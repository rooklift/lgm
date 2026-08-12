'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
let isDirty = false;

const MAP_FILTERS = [
  { name: 'Bolo maps', extensions: ['map'] },
  { name: 'All files', extensions: ['*'] },
];

/* Sanity ceiling for files we handle as maps; comfortably above the ~113 KB
 * a maximal legal map serializes to (a checkerboard against sea: every
 * isolated tile is its own 5-byte run), but small enough to refuse a huge
 * unrelated file that ended up under a .map name. */
const MAX_MAP_BYTES = 1 << 20;

function send(cmd) {
  if (win) win.webContents.send('menu-cmd', cmd);
}

/* Persistent UI settings. A missing or corrupt file just means defaults. */
let settings = {};
let settingsPath = null;

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
  } catch { /* first run, or unreadable */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch { /* non-fatal; the session still works, it just won't persist */ }
}

function toggleSetting(key, item, cmd) {
  settings[key] = item.checked;
  saveSettings();
  send(cmd);
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
      ],
    },
    {
      label: 'Fi&xes',
      submenu: [
        { label: 'Fix base order', click: () => send('fix-base-order') },
        { label: 'Fix pillbox order', click: () => send('fix-pill-order') },
        { label: 'Fix spawn order', click: () => send('fix-start-order') },
        { label: 'Fix spawn directions', click: () => send('fix-start-dirs') },
        { type: 'separator' },
        { label: 'Reset bases', click: () => send('reset-bases') },
        { label: 'Reset pillboxes (wait 50)', click: () => send('reset-pills') },
        { type: 'separator' },
        { label: 'Apply all fixes above', click: () => send('apply-all-fixes') },
        { type: 'separator' },
        { label: 'Reset pillboxes (wait 100)', click: () => send('reset-pills-slow') },
        { label: 'Buffer the sea', click: () => send('buffer-sea') },

      ],
    },
    {
      label: '&Queries',
      submenu: [
        { label: 'Count symmetry flaws', click: () => send('count-flaws') },
        { label: 'Find a symmetry flaw', click: () => send('find-flaw') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit map', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
        { type: 'separator' },
        { label: 'Show pillbox range', type: 'checkbox', checked: !!settings.showPillRange, click: item => toggleSetting('showPillRange', item, 'toggle-pill-range') },
        { label: 'Draw bases as circles', type: 'checkbox', checked: !!settings.basesAsCircles, click: item => toggleSetting('basesAsCircles', item, 'toggle-base-circles') },
        { type: 'separator' },
        { label: "Toggle dev tools", role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* A .map file given on the command line (e.g. `electron . islands.map`) */
function findCliMap() {
  for (const arg of process.argv.slice(1)) {
    if (/\.map$/i.test(arg) && fs.existsSync(arg)) return path.resolve(arg);
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#10131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');

  /* 'on', not 'once': a reload resets the renderer's flags to defaults,
   * so the current settings must be re-pushed each load. */
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('settings', settings);
  });

  const cliMap = findCliMap();
  if (cliMap) {
    win.webContents.once('did-finish-load', () => {
      try {
        const size = fs.statSync(cliMap).size;
        if (size > MAX_MAP_BYTES) throw new Error(`${cliMap} is ${size} bytes, far larger than any Bolo map.`);
        win.webContents.send('load-map', { path: cliMap, data: new Uint8Array(fs.readFileSync(cliMap)) });
      } catch (err) {
        dialog.showErrorBox('Could not open map', String(err));
      }
    });
  }

  /* Closing a dirty window defers to the renderer, which asks with the
   * same discard prompt used by New/Open, then requests a real close. */
  win.on('close', e => {
    if (isDirty) {
      e.preventDefault();
      win.webContents.send('confirm-close');
    }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('open-map', async () => {
  const res = await dialog.showOpenDialog(win, {
    filters: MAP_FILTERS,
    properties: ['openFile'],
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  const p = res.filePaths[0];
  try {
    const size = fs.statSync(p).size;
    if (size > MAX_MAP_BYTES) {
      return { canceled: true, error: `${p} is ${size} bytes, far larger than any Bolo map.` };
    }
    return { canceled: false, path: p, data: new Uint8Array(fs.readFileSync(p)) };
  } catch (err) {
    return { canceled: true, error: String(err) };
  }
});

ipcMain.handle('save-map', async (e, filePath, data) => {
  let p = filePath;
  if (!p) {
    const res = await dialog.showSaveDialog(win, {
      filters: MAP_FILTERS,
      defaultPath: 'untitled.map',
    });
    if (res.canceled) return { canceled: true };
    p = res.filePath;
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
      if (err.code !== 'ENOENT') throw err; /* no original: plain write below */
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
        const name = p + '.bak' + process.pid + (i > 0 ? '.' + i : '');
        try {
          fs.copyFileSync(p, name, fs.constants.COPYFILE_EXCL);
          bak = name;
        } catch (err) {
          if (err.code !== 'EEXIST' || i >= 32) throw err;
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
ipcMain.handle('confirm-discard', async () => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1, /* Enter cancels: a destructive action must not be the reflex default */
    cancelId: 1,
    noLink: true,
    message: 'Discard unsaved changes?',
  });
  return res.response === 0;
});

ipcMain.on('show-error', (e, title, message) => {
  dialog.showErrorBox(title, message);
});

ipcMain.on('set-dirty', (e, d) => { isDirty = !!d; });

/* destroy() skips the 'close' event, so the dirty check can't re-fire */
ipcMain.on('close-confirmed', () => { if (win) win.destroy(); });

app.whenReady().then(() => {
  loadSettings();
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
