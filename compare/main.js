"use strict";
/* Usage: electron . ancestors.json
 * The JSON is an object mapping old map path -> new map path. Every file is
 * read here and handed to the renderer as one flat list: old1, new1, old2, ... */
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_MAP_BYTES = 1 << 20;

function find_json_arg() {
	for (let arg of process.argv.slice(1)) {
		if (arg.startsWith("-")) continue;
		try {
			if (fs.statSync(arg).isFile()) return path.resolve(arg);
		} catch { /* not a file */ }
	}
	return null;
}

function read_entries(json_path) {
	let dict = JSON.parse(fs.readFileSync(json_path, "utf8"));
	if (!dict || typeof dict !== "object" || Array.isArray(dict)) throw new Error("JSON must be an object of old path -> new path");
	let entries = [];
	let pair = 0;
	for (let [old_path, new_path] of Object.entries(dict)) {
		for (let [role, p] of [["old", old_path], ["new", new_path]]) {
			let entry = { pair, role, path: p, data: null, error: null };
			try {
				let size = fs.statSync(p).size;
				if (size > MAX_MAP_BYTES) throw new Error(`${size} bytes, far larger than any Bolo map`);
				entry.data = new Uint8Array(fs.readFileSync(p));
			} catch (err) {
				entry.error = String(err.message || err);
			}
			entries.push(entry);
		}
		pair++;
	}
	return entries;
}

function create_window() {
	let win = new BrowserWindow({
		width: 1400,
		height: 1100,
		backgroundColor: "#10131a",
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile("index.html");
	win.webContents.once("did-finish-load", () => {
		let json_path = find_json_arg();
		if (!json_path) {
			dialog.showErrorBox("No JSON given", "Usage: electron . ancestors.json");
			app.quit();
			return;
		}
		try {
			win.webContents.send("maps", read_entries(json_path));
		} catch (err) {
			dialog.showErrorBox("Could not read JSON", String(err));
			app.quit();
		}
	});
}

app.whenReady().then(create_window);
app.on("window-all-closed", () => app.quit());
