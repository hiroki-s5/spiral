const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('barBridge', {
  goBack:           () => ipcRenderer.send('bar:go-back'),
  goForward:        () => ipcRenderer.send('bar:go-forward'),
  reload:           () => ipcRenderer.send('bar:reload'),
  navigate:         (url) => ipcRenderer.send('bar:navigate', url),
  onUrlChanged:     (cb) => ipcRenderer.on('bar:url-changed', (_, url) => cb(url)),
  getExtensions:    () => ipcRenderer.invoke('ext:list'),
  openExtPopup:     (extId) => ipcRenderer.invoke('ext:openPopup', extId),
  closePopup:       () => ipcRenderer.send('ext:closePopup'),
  getIconData:      (iconPath) => ipcRenderer.invoke('bar:icon-data', iconPath),
  onPopupFailed:    (cb) => ipcRenderer.on('ext:popup-failed', (_, extId) => cb(extId)),
});
