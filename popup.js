const list = document.getElementById('list');
const note = document.getElementById('note');

const send = (msg) => chrome.runtime.sendMessage(msg);

function showError(text) {
  note.textContent = text || '';
  note.hidden = !text;
}

async function run(msg) {
  showError('');
  const res = await send(msg);
  if (res?.error) showError(res.error);
  await render();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function row(group, current) {
  const isolated = Boolean(group.sessionId);
  const active   = isolated && group.sessionId === current;
  const named    = Boolean(group.title);

  const r = el('div', 'row' + (active ? ' active' : ''));
  r.style.setProperty('--c', group.hex);

  /* --- metadata column --- */
  const meta = el('div', 'meta');

  // Name row: dot · name · optional ACTIVE badge
  const nameRow = el('div', 'name-row');
  const dot = el('span', 'dot');
  dot.style.setProperty('--c', group.hex);
  nameRow.append(dot);
  nameRow.append(el('span', 'name', named ? group.title : 'Unnamed group'));
  if (active) nameRow.append(el('span', 'badge', 'Active'));
  meta.append(nameRow);

  // Status text — concise, sans emoji
  const statusText =
    !named     ? 'Name this group in Chrome to enable isolation'
    : active   ? 'Isolated — in use in this tab'
    : isolated ? 'Isolated — own login session'
    :            'Shares your normal browser logins';
  meta.append(el('div', 'status', statusText));

  // Clear logins
  if (isolated) {
    const actions = el('div', 'actions');
    const clear = el('button', 'link', 'Clear logins');
    clear.type = 'button';
    clear.title = `Sign out of every site in "${group.title}"`;
    clear.addEventListener('click', () => {
      if (confirm(`Sign out of every site in "${group.title}"?`)) {
        run({ type: 'clear', groupId: group.id });
      }
    });
    actions.append(clear);
    meta.append(actions);
  }

  r.append(meta);

  /* --- toggle column --- */
  const sw = el('button', 'switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(isolated));
  sw.setAttribute(
    'aria-label',
    isolated
      ? `Disable isolation for ${named ? group.title : 'this group'}`
      : `Isolate ${named ? group.title : 'this group'}`
  );
  if (!named && !isolated) {
    sw.disabled = true;
    sw.title = 'Name the group in Chrome first, then you can isolate it';
  }
  sw.addEventListener('click', () => {
    sw.disabled = true;
    if (isolated) {
      if (!confirm(`Stop isolating "${group.title}"? Its saved logins will be deleted.`)) {
        sw.disabled = false;
        return;
      }
      run({ type: 'unisolate', groupId: group.id });
    } else {
      run({ type: 'isolate', groupId: group.id });
    }
  });
  r.append(sw);

  return r;
}

async function render() {
  const win   = await chrome.windows.getCurrent();
  const state = await send({ type: 'state', windowId: win.id });
  list.replaceChildren();

  if (state?.error) { showError(state.error); return; }

  if (!state.groups.length) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'empty-title', 'No tab groups yet'));
    empty.append(el('p', 'empty-desc', 'Create a named tab group to start giving it its own login session.'));

    const steps = el('ol', 'empty-steps');
    [
      'Right-click any tab → Add tab to new group',
      'Give the group a name (e.g. "Work" or "Shopping")',
      'Come back here and toggle Isolate',
    ].forEach((text, i) => {
      const li = document.createElement('li');
      li.append(el('span', 'step-num', String(i + 1).padStart(2, '0')));
      li.append(document.createTextNode(text));
      steps.append(li);
    });

    empty.append(steps);
    list.append(empty);
    return;
  }

  state.groups.forEach((g) => list.append(row(g, state.current)));
}

render();
