const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, protocol, session, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { APP_ORIGIN, API_URL, WEB_URL, RELEASE_URL, isAppUrl, roomPath } = require('./urls.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'ftos', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setAppUserModelId('com.alokgond.facetimeos.windows');
// Separate profile from any previous desktop implementation.
app.setPath('userData', path.join(app.getPath('appData'), 'FaceTimeOS-Windows'));
let mainWindow, pickerWindow, captureRequest, inRoom = false, forceClose = false;
let powerId = null, loginController = null, pendingRoom = null, rendererReady = false;
const preload = path.join(__dirname, 'preload.cjs');
const webPreferences = { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true };

function trusted(event, win) {
  return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && isAppUrl(event.senderFrame.url);
}
function handle(channel, fn, picker = false) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event, picker ? pickerWindow : mainWindow)) throw new Error('Untrusted app request');
    return fn(...args);
  });
}
function focusApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
async function openRoom(value) {
  const route = roomPath(value);
  if (!route) return;
  pendingRoom = route;
  if (!rendererReady) return;
  if (inRoom) {
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Leave this room and open the invite?', buttons: ['Stay here', 'Open invite'], defaultId: 0, cancelId: 0 });
    if (response !== 1) { pendingRoom = null; return; }
  }
  mainWindow.webContents.send('app:room-link', pendingRoom); pendingRoom = null; focusApp();
}
function lockNavigation(win) {
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) {
      void dialog.showMessageBox(win, { type: 'question', message: 'Open this link in your browser?', detail: url.slice(0, 500), buttons: ['Cancel', 'Open browser'], cancelId: 0, defaultId: 0 })
        .then(({ response }) => { if (response === 1) return shell.openExternal(url); }).catch(() => {});
    }
    return { action: 'deny' };
  });
}

async function jsonRequest(endpoint, body, signal) {
  const res = await net.fetch(`${API_URL}/rtc/desktop-auth/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Desktop sign-in is not deployed on the meeting server yet. Use email sign-in, or finish the owner setup guide.'); }
  if (!res.ok) throw new Error(data.message || (res.status === 404 ? 'The new desktop login endpoint is not deployed yet. Deploy the latest server commit on Render first.' : 'Desktop sign-in could not complete. Try again.'));
  return data;
}
async function signIn() {
  if (loginController) throw new Error('Sign-in is already open in your browser.');
  const controller = new AbortController(); loginController = controller;
  const expiry = setTimeout(() => controller.abort(), 300_000);
  try {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const { requestId, code } = await jsonRequest('start', { challenge }, controller.signal);
    if (!/^[a-zA-Z0-9_-]{32,64}$/.test(requestId) || !/^[A-Z0-9-]{9}$/.test(code)) throw new Error('Invalid sign-in response');
    // The verification code in the browser is also shown by the trusted native app.
    void dialog.showMessageBox(mainWindow, { type: 'info', message: `Confirm code ${code} in your browser`, detail: 'Only continue if the browser shows this same code. Your password stays with Google.', buttons: ['OK'] });
    await shell.openExternal(`${WEB_URL}/desktop-auth?request=${encodeURIComponent(requestId)}`);
    while (!controller.signal.aborted) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000); controller.signal.addEventListener('abort', done, { once: true });
      });
      const result = await jsonRequest('exchange', { requestId, verifier }, controller.signal);
      if (result.customToken) { focusApp(); return { customToken: result.customToken }; }
    }
    throw new Error('Sign-in cancelled.');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Sign-in cancelled or expired. Please try again.');
    throw error;
  } finally { clearTimeout(expiry); loginController = null; }
}

function finishCapture(id) {
  const request = captureRequest;
  captureRequest = null;
  if (request) { clearTimeout(request.timer); request.callback(id && request.sources.has(id) ? { video: request.sources.get(id) } : {}); }
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  pickerWindow = null;
}

async function setupSession() {
  const ses = session.defaultSession;
  const root = path.resolve(__dirname, '../dist');
  const csp = [
    "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", "font-src 'self' data:", "media-src 'self' blob:",
    `connect-src 'self' ${API_URL} ${API_URL.replace('https:', 'wss:')} https://*.googleapis.com https://*.firebaseapp.com`,
    "worker-src 'self' blob:", "frame-src https: blob: 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'",
  ].join('; ');
  await ses.protocol.handle('ftos', async (request) => {
    if (!isAppUrl(request.url) || !['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 });
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const route = pathname === '/' || pathname === '/share-picker' || /^\/room\/[a-f0-9-]+$/.test(pathname);
    const target = path.resolve(root, route ? 'index.html' : `.${pathname}`);
    if (!target.startsWith(root + path.sep) || pathname.includes('\\') || pathname.includes('\0')) return new Response('Forbidden', { status: 403 });
    try {
      const stat = await fs.stat(target); if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(target).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', csp);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const mediaOrigins = new Set();
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (contents !== mainWindow?.webContents || !isAppUrl(origin) || details.isMainFrame === false) return false;
    return ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission);
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== mainWindow?.webContents || !isAppUrl(details.requestingUrl) || details.isMainFrame === false) return callback(false);
    if (permission === 'display-capture' || permission === 'clipboard-sanitized-write') return callback(true);
    if (permission !== 'media') return callback(false);
    const key = (details.mediaTypes || []).slice().sort().join(',');
    if (mediaOrigins.has(key)) return callback(true);
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Allow FaceTimeOS to use your camera and microphone?', detail: 'You can turn them off at any time using the meeting controls.', buttons: ['Not now', 'Allow'], cancelId: 0, defaultId: 1 });
    if (response === 1) mediaOrigins.add(key);
    callback(response === 1);
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== mainWindow?.webContents.mainFrame || !isAppUrl(request.securityOrigin) || captureRequest) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      captureRequest = { sources: new Map(sources.map(s => [s.id, s])), callback, timer: setTimeout(() => finishCapture(null), 120_000) };
      pickerWindow = new BrowserWindow({ parent: mainWindow, modal: true, width: 900, height: 640, minWidth: 650, minHeight: 450, title: 'Choose what to share', autoHideMenuBar: true, backgroundColor: '#0d1117', webPreferences });
      lockNavigation(pickerWindow);
      pickerWindow.on('closed', () => { pickerWindow = null; if (captureRequest) finishCapture(null); });
      await pickerWindow.loadURL(`${APP_ORIGIN}/share-picker`);
    } catch { if (captureRequest) finishCapture(null); else callback({}); }
  });
  ses.on('will-download', (event, item, contents) => {
    if (contents !== mainWindow?.webContents || !isAppUrl(contents.getURL()) || !/^(blob:ftos:|ftos:)/.test(item.getURL())) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: 'Export from FaceTimeOS', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1400, height: 900, minWidth: 900, minHeight: 650, show: false, title: 'FaceTimeOS', icon: path.join(__dirname, '../dist/icon.ico'), backgroundColor: '#0d1117', autoHideMenuBar: true, webPreferences });
  lockNavigation(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', (_event, code, description, _url, main) => {
    if (main && code !== -3) dialog.showErrorBox('FaceTimeOS could not start', `${description}\nReinstall the latest Windows release.`);
  });
  mainWindow.on('close', async (event) => {
    if (inRoom && !forceClose) {
      event.preventDefault();
      const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Leave the meeting and close FaceTimeOS?', detail: 'Closing ends your camera, microphone, and screen sharing.', buttons: ['Stay in meeting', 'Leave and close'], defaultId: 0, cancelId: 0 });
      if (response === 1) { forceClose = true; mainWindow.close(); }
    }
  });
  mainWindow.loadURL(APP_ORIGIN + '/');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  pendingRoom = process.argv.map(roomPath).find(Boolean) || null;
  app.on('second-instance', (_, argv) => { focusApp(); const link = argv.find(v => roomPath(v)); if (link) void openRoom(link); });
  app.on('open-url', (event, url) => { event.preventDefault(); void openRoom(url); });
  app.whenReady().then(async () => {
    if (app.isPackaged) app.setAsDefaultProtocolClient('facetimeos');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'FaceTimeOS', submenu: [{ label: 'Download updates', click: () => shell.openExternal(RELEASE_URL) }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    handle('app:version', () => app.getVersion());
    handle('app:website', () => shell.openExternal(WEB_URL));
    handle('app:releases', () => shell.openExternal(RELEASE_URL));
    handle('app:ready', () => { rendererReady = true; if (pendingRoom) { mainWindow.webContents.send('app:room-link', pendingRoom); pendingRoom = null; } });
    handle('app:in-room', (value) => {
      inRoom = value === true;
      if (inRoom && powerId === null) powerId = powerSaveBlocker.start('prevent-display-sleep');
      if (!inRoom && powerId !== null) { powerSaveBlocker.stop(powerId); powerId = null; }
    });
    handle('account:sign-in', signIn);
    handle('account:cancel', () => loginController?.abort());
    handle('capture:sources', () => [...(captureRequest?.sources.values() || [])].map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })), true);
    handle('capture:select', (id) => finishCapture(typeof id === 'string' ? id : null), true);
    await setupSession(); createWindow();
  }).catch(error => { dialog.showErrorBox('FaceTimeOS startup error', error.message); app.quit(); });
  app.on('window-all-closed', () => { loginController?.abort(); app.quit(); });
}
