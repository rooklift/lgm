"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
	on_maps: cb => ipcRenderer.on("maps", (e, entries) => cb(entries)),
	copy_to_desktop: p => ipcRenderer.invoke("copy_to_desktop", p),
});
