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
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
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
        { label: 'Fix Base Order', click: () => send('fix-base-order') },
        { label: 'Fix Pillbox Order', click: () => send('fix-pill-order') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit Map', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
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

  win.on('close', e => {
    if (isDirty) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Discard changes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'The map has unsaved changes. Discard them?',
      });
      if (choice === 1) e.preventDefault();
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
  try {
    fs.writeFileSync(p, Buffer.from(data));
    return { canceled: false, path: p };
  } catch (err) {
    return { canceled: true, error: String(err) };
  }
});

ipcMain.on('set-dirty', (e, d) => { isDirty = !!d; });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
