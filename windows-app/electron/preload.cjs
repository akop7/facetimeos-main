const { contextBridge, ipcRenderer } = require('electron');
// No generic IPC, filesystem, shell, or Node access is exposed to the page.
const listen = (channel, callback) => {
  const handler = (_, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
if (process.isMainFrame) contextBridge.exposeInMainWorld('faceTimeWindows', {
  signIn: () => ipcRenderer.invoke('account:sign-in'),
  cancelSignIn: () => ipcRenderer.invoke('account:cancel'),
  openWebsite: () => ipcRenderer.invoke('app:website'),
  openReleases: () => ipcRenderer.invoke('app:releases'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  setInRoom: (value) => ipcRenderer.invoke('app:in-room', value === true),
  onRoomLink: (callback) => listen('app:room-link', callback),
  ready: () => ipcRenderer.invoke('app:ready'),
  captureSources: () => ipcRenderer.invoke('capture:sources'),
  selectCapture: (id) => ipcRenderer.invoke('capture:select', id),
});
