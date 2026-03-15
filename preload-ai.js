const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aiAPI', {
  getPageText:    () => ipcRenderer.invoke('ai:get-page-text'),
  getPageInfo:    () => ipcRenderer.invoke('ai:get-page-info'),
  getInputFields: () => ipcRenderer.invoke('ai:get-input-fields'),
  fillAnswers:    (answers) => ipcRenderer.invoke('ai:fill-answers', answers),
  close:          () => ipcRenderer.send('ai:close-window'),
  moveWindow:     (dx, dy) => ipcRenderer.send('ai:move-window', { dx, dy }),
  getApiKey:      () => ipcRenderer.invoke('ai:get-api-key'),
  setApiKey:      (key) => ipcRenderer.invoke('ai:set-api-key', key),
});
