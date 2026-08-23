"use strict";
/* Usage: electron . mapfolder
 * Every regular file in the folder (non-recursive, sorted by name) is read
 * here and handed to the renderer as one flat list. */
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_MAP_BYTES = 1 << 20;

function find_dir_arg() {
	for (let arg of process.argv.slice(1)) {
		if (arg.startsWith("-")) continue;
		if (path.resolve(arg) === app.getAppPath()) continue;    /* the app dir itself, from `electron . mapfolder` */
		try {
			if (fs.statSync(arg).isDirectory()) return path.resolve(arg);
		} catch { /* not a directory */ }
	}
	return null;
}

function read_entries(dir_path) {
	let names = fs.readdirSync(dir_path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	let entries = [];
	for (let name of names) {
		let p = path.join(dir_path, name);
		let stat;
		try {
			stat = fs.statSync(p);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		let entry = { path: p, data: null, error: null };
		try {
			if (stat.size > MAX_MAP_BYTES) throw new Error(`${stat.size} bytes, far larger than any Bolo map`);
			entry.data = new Uint8Array(fs.readFileSync(p));
		} catch (err) {
			entry.error = String(err.message || err);
		}
		entries.push(entry);
	}
	return entries;
}

/* Copies the file to the desktop, never overwriting: "foo.map", then
 * "foo (2).map", "foo (3).map"... Returns the destination path. */
function copy_to_desktop(src) {
	let desktop = app.getPath("desktop");
	let ext = path.extname(src);
	let stem = path.basename(src, ext);
	for (let n = 1; ; n++) {
		let dst = path.join(desktop, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
		try {
			fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
			return dst;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
		}
	}
}

ipcMain.handle("copy_to_desktop", (e, src) => {
	try {
		return { ok: true, dst: copy_to_desktop(src) };
	} catch (err) {
		return { ok: false, error: String(err.message || err) };
	}
});

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
		let dir_path = find_dir_arg();
		if (!dir_path) {
			dialog.showErrorBox("No folder given", "Usage: electron . mapfolder");
			app.quit();
			return;
		}
		try {
			win.webContents.send("maps", read_entries(dir_path));
		} catch (err) {
			dialog.showErrorBox("Could not read folder", String(err));
			app.quit();
		}
	});
}

app.whenReady().then(create_window);
app.on("window-all-closed", () => app.quit());
