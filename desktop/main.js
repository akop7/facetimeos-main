/**
 * FaceTimeOS as a Windows application.
 *
 * The window is a real Chromium view of the deployed web app, which is what
 * makes this worth doing at all: WebRTC, `getUserMedia` and `getDisplayMedia`
 * behave exactly as they do in Chrome, so there is no second implementation of
 * the call to keep working.
 *
 * Three jobs beyond "show a web page":
 *
 * 1. Sign-in. Google refuses OAuth in an embedded browser, so the shell hands
 *    the whole flow to the system browser and passes the resulting ID token back
 *    to the page (see `src/google-oauth.js`).
 * 2. Permissions. Camera, microphone and screen capture are granted to the
 *    configured origin and to nothing else.
 * 3. Staying a shell. Any navigation away from that origin opens in the browser
 *    rather than turning this window into a general-purpose one.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, desktopCapturer, ipcMain, session, shell } from 'electron';
import { loadConfig, normalizeAppUrl, saveSettings } from './src/config.js';
import { signInWithGoogle } from './src/google-oauth.js';

const HERE = import.meta.dirname;
const UI_DIR = path.join(HERE, 'ui');
const PRELOAD = path.join(HERE, 'preload.cjs');
const UI_PREFIX = pathToFileURL(UI_DIR).toString();

/** Set by `npm run smoke`: load, report, exit. No human needed. */
const SMOKE = process.env.FACETIMEOS_SMOKE === '1';

let mainWindow = null;
let config = null;

const uiUrl = (name, params = {}) => {
  const url = pathToFileURL(path.join(UI_DIR, name));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

const isLocalUi = (url) => typeof url === 'string' && url.startsWith(UI_PREFIX);

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const isAppOrigin = (url) => Boolean(config?.origin) && originOf(url) === config.origin;

/**
 * Media permissions, scoped to the configured origin.
 *
 * Electron denies nothing by default in a bare app, and this window loads a
 * remote page — so an unscoped handler would hand the camera to whatever that
 * page decided to embed. The check handler matters as much as the request one:
 * `navigator.permissions.query` and the device-enumeration path go through it,
 * and the app uses both to decide what to show before asking for anything.
 */
function applyPermissionPolicy(ses) {
  const mediaKinds = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requester = details?.requestingUrl || contents?.getURL();
    callback(mediaKinds.has(permission) && isAppOrigin(requester));
  });

  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    mediaKinds.has(permission) && requestingOrigin === config?.origin
  );

  /**
   * Screen sharing. Without a handler `getDisplayMedia` rejects outright in
   * Electron — there is no built-in picker. Windows 11 has a native one, so use
   * it; where it is unavailable Electron falls back to this callback, and
   * offering the primary screen is a defensible default for a call.
   */
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isAppOrigin(request.frame?.url || request.securityOrigin)) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      callback(sources.length ? { video: sources[0] } : {});
    },
    { useSystemPicker: true }
  );
}

/** Keep this window a shell: anything that is not the app opens in the browser. */
function applyNavigationPolicy(contents) {
  contents.on('will-navigate', (event, url) => {
    if (isLocalUi(url) || isAppOrigin(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Nothing in the app needs a second window. Invite links, docs and the
    // occasional external reference all belong in the user's browser, where
    // their extensions and sessions already are.
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('did-fail-load', (event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED, which a redirect or a fast second navigation produces.
    if (!isMainFrame || errorCode === -3 || isLocalUi(failedUrl)) return;
    mainWindow?.loadURL(
      uiUrl('unreachable.html', { url: failedUrl, reason: errorDescription || String(errorCode) })
    );
  });
}

function targetUrl() {
  return config?.appUrl ? config.appUrl : uiUrl('setup.html');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    show: false,
    // Matches the app's own background, so a slow first paint is not a white flash
    // in a dark room.
    backgroundColor: '#0b0b0f',
    title: 'FaceTimeOS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // It is a video call. Waiting for a click before playing the other
      // person's stream would be a bug, not a safeguard.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  applyNavigationPolicy(mainWindow.webContents);
  mainWindow.loadURL(targetUrl());
  return mainWindow;
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Change server URL…',
          click: () => mainWindow?.loadURL(uiUrl('setup.html')),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Which page is allowed to call what.
 *
 * The setup and error screens are local files and may change where the app
 * points; the remote app may ask for a sign-in and nothing else. Deciding this
 * in the preload would be tidier to read but is not a boundary — a compromised
 * renderer talks to `ipcMain` directly. So it is checked here, against the URL
 * the sending frame actually has.
 */
function registerIpc(userDataDir) {
  const senderUrl = (event) => {
    try {
      return event.senderFrame?.url ?? event.sender.getURL();
    } catch {
      return '';
    }
  };

  const fromLocalUi = (event) => isLocalUi(senderUrl(event));

  ipcMain.handle('shell:get-config', (event) => {
    if (!fromLocalUi(event)) throw new Error('Not available to this page.');
    return {
      appUrl: config?.appUrl ?? '',
      fromEnv: Boolean(config?.fromEnv),
      hasGoogleClient: Boolean(config?.google.clientId),
      // Never the secret itself — only whether one is set.
      hasGoogleSecret: Boolean(config?.google.clientSecret),
      version: app.getVersion(),
    };
  });

  ipcMain.handle('shell:save-config', (event, patch) => {
    if (!fromLocalUi(event)) throw new Error('Not available to this page.');

    const appUrl = normalizeAppUrl(patch?.appUrl);
    if (!appUrl) throw new Error('That does not look like an http:// or https:// address.');

    saveSettings(userDataDir, {
      appUrl,
      googleClientId: String(patch?.googleClientId ?? '').trim() || undefined,
      googleClientSecret: String(patch?.googleClientSecret ?? '').trim() || undefined,
    });
    config = loadConfig(userDataDir);
    mainWindow?.loadURL(targetUrl());
    return { appUrl: config.appUrl };
  });

  ipcMain.handle('shell:retry', () => {
    mainWindow?.loadURL(targetUrl());
  });

  ipcMain.handle('shell:open-external', (event, url) => {
    if (!/^https?:/i.test(String(url))) throw new Error('Only http(s) links can be opened.');
    return shell.openExternal(String(url));
  });

  /**
   * The sign-in bridge. Only the configured origin may call it: an ID token is a
   * bearer credential for the user's identity, so handing one to any page that
   * happened to load here would be worse than the popup problem it solves.
   */
  ipcMain.handle('auth:google-sign-in', async (event) => {
    if (!isAppOrigin(senderUrl(event))) throw new Error('Sign-in is not available to this page.');
    if (!config?.google.clientId) {
      throw new Error(
        'No Google OAuth client is configured. Add a Desktop-app client ID under File → Change server URL.'
      );
    }
    const { idToken } = await signInWithGoogle({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      openExternal: (url) => shell.openExternal(url),
    });
    return { idToken };
  });
}

/**
 * One window, always. Clicking the desktop shortcut twice should focus the call
 * you are already in, not start a second process that fights over the camera.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Without this the taskbar groups the window under "Electron" and notifications
  // are attributed to it too.
  app.setAppUserModelId('dev.facetimeos.desktop');

  app.whenReady().then(() => {
    const userDataDir = app.getPath('userData');
    config = loadConfig(userDataDir);

    applyPermissionPolicy(session.defaultSession);
    registerIpc(userDataDir);
    buildMenu();
    createWindow();

    if (SMOKE) {
      // Enough of a launch to prove the window loads, the preload lands and the
      // policies apply, without waiting for a human to close it.
      //
      // Every load is reported rather than only the first, because one of the
      // behaviours worth checking is a *second* navigation: a URL that refuses the
      // connection has to end up on the local error page.
      let quitTimer = null;
      mainWindow.webContents.on('did-finish-load', async () => {
        console.log(`[smoke] loaded ${mainWindow.webContents.getURL()}`);
        console.log(`[smoke] appUrl ${config.appUrl ?? '(none — setup screen)'}`);
        console.log(`[smoke] googleClient ${config.google.clientId ? 'configured' : 'none'}`);
        const bridge = await mainWindow.webContents.executeJavaScript(
          `JSON.stringify({
             desktop: Boolean(window.facetimeosDesktop?.isDesktop),
             shell: typeof window.facetimeosShell?.getConfig === 'function',
           })`
        );
        console.log(`[smoke] bridge ${bridge}`);
        // Reset, so a fallback navigation gets its turn before the app exits.
        clearTimeout(quitTimer);
        quitTimer = setTimeout(() => app.quit(), 900);
      });
    }
  });

  // Windows has no dock to keep the app alive in, so closing the window means done.
  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
