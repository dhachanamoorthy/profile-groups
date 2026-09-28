# Group Sessions

Gives each tab group its own logins (cookie jar) inside one Chrome window.

## Install
1. Unzip, then open chrome://extensions
2. Turn on Developer mode
3. Click Load unpacked and choose the group-sessions folder

## Use
1. Make a tab group and give it a name
2. Click the extension icon and switch the group to isolated
3. Log in to sites inside that group. Other groups stay signed out of them.

## Limits
- One real cookie store: on each switch, saved cookies are swapped in and the tab reloads
- Background tabs in other groups can send the wrong cookies while they load
- localStorage and IndexedDB are shared, so sites that keep tokens there are not isolated
- Saved cookies sit unencrypted in extension storage on your machine
- Groups are re-linked after a restart by name, so keep names unique
