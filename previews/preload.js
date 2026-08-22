"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
	on_maps: cb => ipcRenderer.on("maps", (e, entries) => cb(entries)),
});
