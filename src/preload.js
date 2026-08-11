'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
	openMap: () => ipcRenderer.invoke('open-map'),
	pathForFile: file => webUtils.getPathForFile(file),
	onLoadMap: cb => ipcRenderer.on('load-map', (e, payload) => cb(payload)),
	saveMap: (filePath, data) => ipcRenderer.invoke('save-map', filePath, data),
	setDirty: d => ipcRenderer.send('set-dirty', d),
	confirmDiscard: () => ipcRenderer.invoke('confirm-discard'),
	showError: (title, message) => ipcRenderer.send('show-error', title, message),
	onMenu: cb => ipcRenderer.on('menu-cmd', (e, cmd) => cb(cmd)),
	onSettings: cb => ipcRenderer.on('settings', (e, s) => cb(s)),
	onConfirmClose: cb => ipcRenderer.on('confirm-close', () => cb()),
	confirmClose: () => ipcRenderer.send('close-confirmed'),
});
