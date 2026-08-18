"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
	open_map: () => ipcRenderer.invoke("open-map"),
	path_for_file: file => webUtils.getPathForFile(file),
	on_load_map: cb => ipcRenderer.on("load-map", (e, payload) => cb(payload)),
	save_map: (file_path, data) => ipcRenderer.invoke("save-map", file_path, data),
	set_dirty: d => ipcRenderer.send("set-dirty", d),
	confirm_discard: () => ipcRenderer.invoke("confirm-discard"),
	show_error: (title, message) => ipcRenderer.send("show-error", title, message),
	on_menu: cb => ipcRenderer.on("menu-cmd", (e, cmd) => cb(cmd)),
	on_settings: cb => ipcRenderer.on("settings", (e, s) => cb(s)),
	on_confirm_close: cb => ipcRenderer.on("confirm-close", () => cb()),
	confirm_close: () => ipcRenderer.send("close-confirmed"),
});
