// Group Sessions: gives each isolated tab group its own cookie jar.
//
// How it works: Chrome has one real cookie store. We keep one saved "jar" per
// isolated group (plus one for everything else). When the active tab moves to a
// tab in a different group, we save the live cookies into the old jar, wipe the
// live store, load the new jar, and reload the tab.

const DEFAULT = 'default';
const HEX = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
  green: '#188038', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e',
};

let swapping = false;
let queue = Promise.resolve();

// Run one job at a time so swaps never overlap.
function enqueue(job) {
  const run = queue.then(job);
  queue = run.catch((e) => console.error('[group-sessions]', e));
  return run;
}

/* ---------- storage helpers ---------- */

async function read(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] ?? fallback;
}
const write = (key, value) => chrome.storage.local.set({ [key]: value });

/* ---------- cookie jar helpers ---------- */

function cookieUrl(c) {
  return `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
}

async function clearJar() {
  const all = await chrome.cookies.getAll({});
  await Promise.allSettled(
    all.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }))
  );
}

async function restoreJar(cookies) {
  const now = Date.now() / 1000;
  await Promise.allSettled(
    cookies
      .filter((c) => c.session || c.expirationDate > now)
      .map((c) => {
        const details = {
          url: cookieUrl(c),
          name: c.name,
          value: c.value,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          storeId: c.storeId,
        };
        if (!c.hostOnly) details.domain = c.domain;
        if (!c.session) details.expirationDate = c.expirationDate;
        return chrome.cookies.set(details);
      })
  );
}

// Returns true if the live cookie store was changed.
async function switchTo(key) {
  const current = await read('current', DEFAULT);
  if (current === key) return false;
  swapping = true;
  try {
    // Save first, so a crash mid-swap cannot lose the outgoing session.
    await write('jar:' + current, await chrome.cookies.getAll({}));
    await clearJar();
    await restoreJar(await read('jar:' + key, []));
    await write('current', key);
  } finally {
    swapping = false;
  }
  return true;
}

async function saveCurrent() {
  const current = await read('current', DEFAULT);
  await write('jar:' + current, await chrome.cookies.getAll({}));
}

/* ---------- group <-> session mapping ---------- */

// Group ids change when Chrome restarts, so sessions are re-linked by group name.
async function reconcile() {
  const groups = await chrome.tabGroups.query({});
  const sessions = await read('sessions', {});
  const oldMap = await read('groupMap', {});
  const map = {};
  const claimed = new Set();

  for (const g of groups) {
    const id = oldMap[g.id];
    if (id && sessions[id]) {
      map[g.id] = id;
      claimed.add(id);
      sessions[id].title = g.title;
      sessions[id].color = g.color;
    }
  }
  for (const g of groups) {
    if (map[g.id] || !g.title) continue;
    const match = Object.values(sessions).find((s) => !claimed.has(s.id) && s.title === g.title);
    if (match) {
      map[g.id] = match.id;
      claimed.add(match.id);
      match.color = g.color;
    }
  }
  await write('groupMap', map);
  await write('sessions', sessions);
}

async function keyForTab(tab, map, sessions) {
  if (!tab || tab.groupId == null || tab.groupId < 0) return DEFAULT;
  const id = map[tab.groupId];
  return id && sessions[id] ? id : DEFAULT;
}

async function paintBadges() {
  const map = await read('groupMap', {});
  const sessions = await read('sessions', {});
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.map(async (tab) => {
      const key = await keyForTab(tab, map, sessions);
      if (key === DEFAULT) return chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      await chrome.action.setBadgeText({ tabId: tab.id, text: '\u25CF' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: HEX[sessions[key].color] || HEX.grey });
      await chrome.action.setBadgeTextColor?.({ tabId: tab.id, color: '#ffffff' });
    })
  );
}

const isWeb = (tab) => /^https?:/.test(tab?.url || '');

// Make the live cookie store match the tab the person is looking at.
async function sync() {
  await reconcile();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) {
    const key = await keyForTab(tab, await read('groupMap', {}), await read('sessions', {}));
    const switched = await switchTo(key);
    if (switched && isWeb(tab)) chrome.tabs.reload(tab.id);
  }
  await paintBadges();
}

async function reloadGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  tabs.filter(isWeb).forEach((t) => chrome.tabs.reload(t.id));
}

/* ---------- events ---------- */

chrome.tabs.onActivated.addListener(() => enqueue(sync));
chrome.tabs.onUpdated.addListener((_id, info) => {
  if ('groupId' in info) enqueue(sync);
});
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) enqueue(sync);
});
chrome.tabGroups.onCreated.addListener(() => enqueue(sync));
chrome.tabGroups.onUpdated.addListener(() => enqueue(sync));
chrome.tabGroups.onRemoved.addListener((group) =>
  enqueue(async () => {
    const map = await read('groupMap', {});
    delete map[group.id]; // the session's saved logins stay, and re-link if a group with the same name returns
    await write('groupMap', map);
    await sync();
  })
);

// Keep the saved copy of the active session fresh as cookies change.
let saveTimer;
chrome.cookies.onChanged.addListener(() => {
  if (swapping) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => enqueue(saveCurrent), 3000);
});

chrome.runtime.onStartup.addListener(() =>
  enqueue(async () => {
    await write('groupMap', {}); // old group ids are meaningless after a restart
    await sync();
  })
);
chrome.runtime.onInstalled.addListener(() => enqueue(sync));

/* ---------- messages from the popup ---------- */

async function handle(msg) {
  switch (msg.type) {
    case 'state':
      return enqueue(async () => {
        await reconcile();
        const groups = await chrome.tabGroups.query({ windowId: msg.windowId });
        const map = await read('groupMap', {});
        return {
          current: await read('current', DEFAULT),
          groups: groups.map((g) => ({
            id: g.id,
            title: g.title,
            color: g.color,
            hex: HEX[g.color] || HEX.grey,
            sessionId: map[g.id] || null,
          })),
        };
      });

    case 'isolate':
      return enqueue(async () => {
        const g = await chrome.tabGroups.get(msg.groupId);
        if (!g.title) throw new Error('Name the group first, so its session can be found after a restart.');
        const sessions = await read('sessions', {});
        const map = await read('groupMap', {});
        if (map[g.id]) return {};
        const id = crypto.randomUUID();
        sessions[id] = { id, title: g.title, color: g.color };
        map[g.id] = id;
        await write('jar:' + id, []); // starts signed out everywhere
        await write('sessions', sessions);
        await write('groupMap', map);
        await sync();
        return {};
      });

    case 'unisolate':
      return enqueue(async () => {
        const sessions = await read('sessions', {});
        const map = await read('groupMap', {});
        const id = map[msg.groupId];
        if (!id) return {};
        if ((await read('current', DEFAULT)) === id) await switchTo(DEFAULT);
        delete map[msg.groupId];
        delete sessions[id];
        await chrome.storage.local.remove('jar:' + id);
        await write('sessions', sessions);
        await write('groupMap', map);
        await sync();
        await reloadGroup(msg.groupId);
        return {};
      });

    case 'clear':
      return enqueue(async () => {
        const map = await read('groupMap', {});
        const id = map[msg.groupId];
        if (!id) return {};
        if ((await read('current', DEFAULT)) === id) {
          swapping = true;
          try { await clearJar(); } finally { swapping = false; }
          await reloadGroup(msg.groupId);
        }
        await write('jar:' + id, []);
        return {};
      });

    default:
      throw new Error('Unknown message: ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
  return true;
});
