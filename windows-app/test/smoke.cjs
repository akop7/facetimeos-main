// Real Chromium/Electron integration check, run in a disposable profile.
// This does not log in, access devices, create a room, or change cloud data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ftos-windows-smoke-'));
const originalSetPath = app.setPath.bind(app);
app.setPath = (key, value) => originalSetPath(key, key === 'userData' ? profile : value);
let checking = false;
const timer = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 45_000);
app.on('browser-window-created', (_, win) => {
  if (checking) return; checking = true;
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && !document.querySelector('.desktop-home'); i++) await new Promise(r => setTimeout(r, 50));
        const result = {
          home: Boolean(document.querySelector('.desktop-home')),
          secure: window.isSecureContext,
          noNode: typeof window.require === 'undefined' && typeof window.process === 'undefined',
          bridge: typeof window.faceTimeWindows?.signIn === 'function',
          version: await window.faceTimeWindows?.getVersion(),
          media: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
          origin: window.location.origin,
          scripts: [...document.scripts].filter(s => s.src).map(s => new URL(s.src).protocol),
        };
        try { await window.faceTimeWindows.captureSources(); result.pickerIPCBlocked = false; }
        catch { result.pickerIPCBlocked = true; }
        history.pushState(null, '', '/room/c7ecbf6c-b7ed-4975-abd4-206f2499e11b');
        dispatchEvent(new PopStateEvent('popstate'));
        await new Promise(r => setTimeout(r, 400));
        result.roomRoute = !document.querySelector('.desktop-home') && document.body.innerText.length > 20;
        return result;
      })()`);
      assert.equal(result.home, true, 'packaged home renders');
      assert.equal(result.secure, true, 'camera APIs require a secure app origin');
      assert.equal(result.noNode, true, 'renderer has no Node privileges');
      assert.equal(result.bridge, true, 'restricted native bridge is present');
      assert.equal(result.media, true, 'screen-sharing API is exposed');
      assert.equal(result.origin, 'ftos://app');
      assert.ok(result.scripts.every(scheme => scheme === 'ftos:'));
      assert.equal(result.pickerIPCBlocked, true, 'main renderer cannot enumerate screens without a picker');
      assert.equal(result.roomRoute, true, 'shared room component renders');
      console.log(JSON.stringify({ smoke: 'passed', ...result }));
      clearTimeout(timer); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
  });
});
require('../electron/main.cjs');
