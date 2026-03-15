const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pwManager', {
  getAll:          () => ipcRenderer.invoke('passwords:get-all'),
  savePassword:    (entry) => ipcRenderer.invoke('passwords:save', entry),
  deletePassword:  (id)    => ipcRenderer.invoke('passwords:delete', id),
  saveLogin:       (entry) => ipcRenderer.invoke('login-history:save-manual', entry),
  deleteLogin:     (id)    => ipcRenderer.invoke('login-history:delete', id),
  clearLogins:     ()      => ipcRenderer.invoke('login-history:clear'),
  autoLogin:       (tabId, entry) => ipcRenderer.invoke('login-history:auto-login', { tabId, entry }),
  getActiveTabId:  () => ipcRenderer.invoke('pw-win:get-active-tab'),
});
