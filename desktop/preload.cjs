/**
 * The only thing the page can see of Node.
 *
 * CommonJS on purpose: the package is `"type": "module"`, so a `preload.js` here
 * would be parsed as ESM — and an ESM preload requires `sandbox: false`. Keeping
 * the renderer sandboxed is worth more than matching the file extension of the
 * rest of the shell.
 *
 * Two bridges, deliberately separate:
 *
 * - `facetimeosDesktop` is what the web app looks for. It says "you are in the
 *   desktop shell" and offers sign-in, nothing else. The app checks for it to
 *   decide between `signInWithPopup` and the loopback flow.
 * - `facetimeosShell` is for the bundled setup and error pages: where to point,
 *   and how to retry.
 *
 * Both are exposed to every page, because this file cannot tell where it is
 * running any more reliably than the page could lie about it. The main process
 * checks the sender's URL on every call and refuses the ones that do not belong
 * to it — that is the real boundary. What is here is only ergonomics.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('facetimeosDesktop', {
  /** Truthy marker, so feature detection does not depend on a function existing. */
  isDesktop: true,
  platform: process.platform,
  /**
   * Runs the whole RFC 8252 flow in the system browser and resolves with a Google
   * ID token. The renderer turns that into a Firebase credential itself, so no
   * session state lives out here.
   */
  signInWithGoogle: () => ipcRenderer.invoke('auth:google-sign-in'),
});

contextBridge.exposeInMainWorld('facetimeosShell', {
  getConfig: () => ipcRenderer.invoke('shell:get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('shell:save-config', patch),
  retry: () => ipcRenderer.invoke('shell:retry'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});
