const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('barBridge', {
  sbOpen: () => ipcRenderer.send('bar:sb-open'),
  sbClose: () => ipcRenderer.send('bar:sb-close'),
});
