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

function send(cmd) {
  if (win) win.webContents.send('menu-cmd', cmd);
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
        { label: 'Reset pillboxes', click: () => send('reset-pills') },
        { label: 'Reset bases', click: () => send('reset-bases') },
        { type: 'separator' },
        { label: 'Apply all fixes above', click: () => send('apply-all-fixes') },
        { type: 'separator' },
        { label: 'Buffer the sea', click: () => send('buffer-sea') },

      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit map', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
        { type: 'separator' },
        { label: 'Show pillbox range', type: 'checkbox', checked: false, click: () => send('toggle-pill-range') },
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

  const cliMap = findCliMap();
  if (cliMap) {
    win.webContents.once('did-finish-load', () => {
      try {
        win.webContents.send('load-map', { path: cliMap, data: new Uint8Array(fs.readFileSync(cliMap)) });
      } catch (err) {
        dialog.showErrorBox('Could not open map', String(err));
      }
    });
  }

  /* Closing a dirty window defers to the renderer, which asks with the
   * same confirm() used by New/Open, then requests a real close. */
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
  /* Write to a temp file then rename, so a failed write can't destroy the
     original. 'wx' refuses to open a name that already exists, so a stray
     pre-existing .tmp file is never clobbered — we just try another name. */
  let tmp = null;
  let fd = null;
  try {
    for (let i = 0; fd === null; i++) {
      tmp = p + '.tmp' + process.pid + (i > 0 ? '.' + i : '');
      try {
        fd = fs.openSync(tmp, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST' || i >= 32) throw err;
      }
    }
    fs.writeFileSync(fd, Buffer.from(data));
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
    return { canceled: false, path: p };
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* never created, or rename consumed it */ }
    return { canceled: true, error: String(err) };
  }
});

ipcMain.on('set-dirty', (e, d) => { isDirty = !!d; });

/* destroy() skips the 'close' event, so the dirty check can't re-fire */
ipcMain.on('close-confirmed', () => { if (win) win.destroy(); });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
