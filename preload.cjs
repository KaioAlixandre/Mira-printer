const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mira', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),
  login: (body) => ipcRenderer.invoke('auth-login', body),
  logout: () => ipcRenderer.invoke('auth-logout'),
  getPrintSettings: () => ipcRenderer.invoke('get-print-settings'),
  savePrintSettings: (body) => ipcRenderer.invoke('save-print-settings', body),
  onStatus: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onPrintBell: (fn) => {
    const handler = (_e, opts) => fn(opts ?? {});
    ipcRenderer.on('print-bell', handler);
    return () => ipcRenderer.removeListener('print-bell', handler);
  },
  setOpenAtLogin: (v) => ipcRenderer.send('set-open-at-login', v),
  showWindow: () => ipcRenderer.send('show-window'),
  openSetup: () => ipcRenderer.send('open-setup'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
});
