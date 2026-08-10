'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openMap: () => ipcRenderer.invoke('open-map'),
  pathForFile: file => webUtils.getPathForFile(file),
  onLoadMap: cb => ipcRenderer.on('load-map', (e, payload) => cb(payload)),
  saveMap: (filePath, data) => ipcRenderer.invoke('save-map', filePath, data),
  setDirty: d => ipcRenderer.send('set-dirty', d),
  onMenu: cb => ipcRenderer.on('menu-cmd', (e, cmd) => cb(cmd)),
  onConfirmClose: cb => ipcRenderer.on('confirm-close', () => cb()),
  confirmClose: () => ipcRenderer.send('close-confirmed'),
});
