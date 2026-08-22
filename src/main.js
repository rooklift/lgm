"use strict";
const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

let win = null;
let is_dirty = false;

const MAP_FILTERS = [
	{ name: "Bolo maps", extensions: ["map", "rsrc"] },
	{ name: "All files", extensions: ["*"] },
];

/* Sanity ceiling for files we handle as maps; comfortably above the ~113 KB
 * a maximal legal map serializes to (a checkerboard against sea: every
 * isolated tile is its own 5-byte run), but small enough to refuse a huge
 * unrelated file that ended up under a .map name. */
const MAX_MAP_BYTES = 1 << 20;

function send(cmd) {
	if (win) win.webContents.send("menu-cmd", cmd);
}

/* Persistent UI settings. A missing or corrupt file just means defaults. */
let settings = {};
let settings_path = null;

function load_settings() {
	settings_path = path.join(app.getPath("userData"), "settings.json");
	try {
		let parsed = JSON.parse(fs.readFileSync(settings_path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
	} catch { /* first run, or unreadable */ }
}

function save_settings() {
	try {
		fs.writeFileSync(settings_path, JSON.stringify(settings, null, 2) + "\n");
	} catch { /* non-fatal; the session still works, it just won't persist */ }
}

function toggle_setting(key, item, cmd) {
	settings[key] = item.checked;
	save_settings();
	send(cmd);
}

function build_menu() {
	let template = [
		{
			label: "&File",
			submenu: [
				{ label: "New", accelerator: "CmdOrCtrl+N", click: () => send("new") },
				{ label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
				{ type: "separator" },
				{ label: "Auto-detect shifted legacy maps", type: "checkbox", checked: settings.detectLegacyPhase !== false, click: item => toggle_setting("detectLegacyPhase", item, "toggle-legacy-phase") },
				{ type: "separator" },
				{ label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
				{ label: "Save as…", accelerator: "CmdOrCtrl+Shift+S", click: () => send("save-as") },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "&Edit",
			submenu: [
				{ label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
				{ label: "Redo", accelerator: "CmdOrCtrl+Y", click: () => send("redo") },
			],
		},
		{
			label: "Fi&xes",
			submenu: [
				{ label: "Fix base order", click: () => send("fix-base-order") },
				{ label: "Fix pillbox order", click: () => send("fix-pill-order") },
				{ label: "Fix spawn order", click: () => send("fix-start-order") },
				{ type: "separator" },
				{ label: "Fix spawn directions", click: () => send("fix-start-dirs") },
				{ type: "separator" },
				{ label: "Reset bases", click: () => send("reset-bases") },
				{ type: "separator" },
				{ label: "Reset pillboxes (wait 50)", click: () => send("reset-pills-fast") },
				{ label: "Reset pillboxes (wait 100)", click: () => send("reset-pills-slow") },
				{ type: "separator" },
				{ label: "Apply all fixes above (wait 50)", click: () => send("apply-all-fixes-fast") },
				{ label: "Apply all fixes above (wait 100)", click: () => send("apply-all-fixes-slow") },
				{ type: "separator" },
				{ label: "Buffer the sea", click: () => send("buffer-sea") },

			],
		},
		{
			label: "&Queries",
			submenu: [
				{ label: "Count symmetry flaws", click: () => send("count-flaws") },
				{ label: "Find a flaw (best symmetry)", click: () => send("find-flaw") },
				{ label: "Find a flaw (selected symmetry)", click: () => send("find-flaw-selected") },
				{ type: "separator" },
				{ label: "Pillbox speeds", click: () => send("pill-speeds") },
				{ label: "Count non-standard objects", click: () => send("count-nonstandard") },
			],
		},
		{
			label: "&View",
			submenu: [
				{ label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => send("zoom-in") },
				{ label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => send("zoom-out") },
				{ label: "Fit map", accelerator: "CmdOrCtrl+0", click: () => send("zoom-fit") },
				{ type: "separator" },
				{ label: "Terrain sprites when zoomed in", type: "checkbox", checked: settings.showSprites !== false, click: item => toggle_setting("showSprites", item, "toggle-sprites") },
				{ label: "Show pillbox range", type: "checkbox", checked: settings.showPillRange !== false, click: item => toggle_setting("showPillRange", item, "toggle-pill-range") },
				{ label: "Draw bases as circles", type: "checkbox", checked: settings.basesAsCircles !== false, click: item => toggle_setting("basesAsCircles", item, "toggle-base-circles") },
				{ type: "separator" },
				{ label: "Toggle dev tools", role: "toggleDevTools" },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* A map file given on the command line (e.g. `electron . islands.map`, or a
 * file dropped onto the exe, which arrives as an argument). Maps in the wild
 * don't reliably have a .map extension, so any existing regular file counts;
 * the size ceiling and the parser sort out the rest. Flags and the app dir
 * in dev mode (`electron .`) are skipped. */
function find_cli_map() {
	for (let arg of process.argv.slice(1)) {
		if (arg.startsWith("-")) continue;
		try {
			if (fs.statSync(arg).isFile()) return path.resolve(arg);
		} catch { /* not a real path: some other kind of argument */ }
	}
	return null;
}

function create_window() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		backgroundColor: "#10131a",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile("index.html");

	/* "on", not "once": a reload resets the renderer's flags to defaults,
	 * so the current settings must be re-pushed each load. */
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("settings", settings);
	});

	let cli_map = find_cli_map();
	if (cli_map) {
		win.webContents.once("did-finish-load", () => {
			try {
				let size = fs.statSync(cli_map).size;
				if (size > MAX_MAP_BYTES) throw new Error(`${cli_map} is ${size} bytes, far larger than any Bolo map.`);
				win.webContents.send("load-map", { path: cli_map, data: new Uint8Array(fs.readFileSync(cli_map)) });
			} catch (err) {
				dialog.showErrorBox("Could not open map", String(err));
			}
		});
	}

	/* Closing a dirty window defers to the renderer, which asks with the
	 * same discard prompt used by New/Open, then requests a real close. */
	win.on("close", e => {
		if (is_dirty) {
			e.preventDefault();
			win.webContents.send("confirm-close");
		}
	});
	win.on("closed", () => { win = null; });
}

ipcMain.handle("open-map", async () => {
	let opts = {
		filters: MAP_FILTERS,
		properties: ["openFile"],
	};
	if (typeof settings.lastOpenDir === "string") opts.defaultPath = settings.lastOpenDir;
	let res = await dialog.showOpenDialog(win, opts);
	if (res.canceled || res.filePaths.length === 0) return { canceled: true };
	let p = res.filePaths[0];
	settings.lastOpenDir = path.dirname(p);
	save_settings();
	try {
		let size = fs.statSync(p).size;
		if (size > MAX_MAP_BYTES) {
			return { canceled: true, error: `${p} is ${size} bytes, far larger than any Bolo map.` };
		}
		return { canceled: false, path: p, data: new Uint8Array(fs.readFileSync(p)) };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

ipcMain.handle("save-map", async (e, file_path, data) => {
	let p = file_path;
	if (!p) {
		let res = await dialog.showSaveDialog(win, {
			filters: MAP_FILTERS,
			defaultPath: typeof settings.lastOpenDir === "string" ? path.join(settings.lastOpenDir, "untitled.map") : "untitled.map",
		});
		if (res.canceled) return { canceled: true };
		p = res.filePath;
		settings.lastOpenDir = path.dirname(p);
		save_settings();
	}
	/* Overwrite in place, so the destination keeps its file identity —
		 writing a temp file and renaming it over p makes a new directory
		 entry, which loses the desktop icon position, creation date and
		 ACLs. The old content is copied to a backup first, so a failed
		 write still can't destroy it; the backup is removed once the write
		 lands. COPYFILE_EXCL refuses a name that already exists, so a stray
		 pre-existing backup is never clobbered — we just try another name. */
	let bak = null;
	try {
		let existing = null;
		try {
			existing = fs.statSync(p);
		} catch (err) {
			if (err.code !== "ENOENT") throw err; /* no original: plain write below */
		}
		if (existing) {
			/* The largest legal map is ~113 KB (see MAX_MAP_BYTES). Anything
				 wildly bigger is not a map we wrote — the user may have dropped
				 some other file onto this name — so refuse to touch it rather
				 than back it up. */
			if (existing.size > MAX_MAP_BYTES) {
				return { canceled: true, error:
					`The copy of ${p} on disk is now ${existing.size} bytes. Not overwriting it; use Save As.` };
			}
			for (let i = 0; bak === null; i++) {
				let name = p + ".bak" + process.pid + (i > 0 ? "." + i : "");
				try {
					fs.copyFileSync(p, name, fs.constants.COPYFILE_EXCL);
					bak = name;
				} catch (err) {
					if (err.code !== "EEXIST" || i >= 32) throw err;
				}
			}
		}
		try {
			fs.writeFileSync(p, Buffer.from(data));
		} catch (err) {
			if (!bak) throw err; /* nothing was at p, so nothing was lost */
			try {
				fs.copyFileSync(bak, p); /* p may be truncated or partial: put the original back */
				fs.unlinkSync(bak);
				return { canceled: true, error: `${err} — the original file is unchanged.` };
			} catch {
				return { canceled: true, error: `${err} — the original content is preserved in ${bak}` };
			}
		}
		/* The save itself succeeded past this point, whatever the cleanup does. */
		if (bak) { try { fs.unlinkSync(bak); } catch { /* a leftover backup is harmless */ } }
		return { canceled: false, path: p };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

/* The renderer must not use window.confirm()/alert(): after Chromium's
 * blocking dialogs, keyboard focus breaks and inputs stop accepting
 * typing until the window is refocused (electron#19977 or #31917).
 * Native dialogs from the main process don't have that problem. */
ipcMain.handle("confirm-discard", async () => {
	let res = await dialog.showMessageBox(win, {
		type: "warning",
		buttons: ["Discard", "Cancel"],
		defaultId: 1, /* Enter cancels: a destructive action must not be the reflex default */
		cancelId: 1,
		noLink: true,
		message: "Discard unsaved changes?",
	});
	return res.response === 0;
});

ipcMain.on("show-error", (e, title, message) => {
	dialog.showErrorBox(title, message);
});

ipcMain.on("set-dirty", (e, d) => { is_dirty = !!d; });

/* destroy() skips the "close" event, so the dirty check can't re-fire */
ipcMain.on("close-confirmed", () => { if (win) win.destroy(); });

app.whenReady().then(() => {
	load_settings();
	build_menu();
	create_window();
});
app.on("window-all-closed", () => app.quit());
