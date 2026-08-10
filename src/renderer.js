'use strict';
/* Bolo map editor renderer: canvas view, painting tools, objects, undo. */

const { MAP_SIZE, DEEP_SEA, TERRAIN_NAMES, EDGE_MIN, EDGE_MAX } = BoloMap;

/* Editable region: WinBolo's writer drops anything outside (mapGetPos) */
const RGN_LO = EDGE_MIN + 1;   /* 21, inclusive */
const RGN_HI = EDGE_MAX;       /* 236, exclusive */

const TERRAIN_COLORS = {
  0:  '#8a6b4a',  /* building */
  1:  '#3f7fe0',  /* river */
  2:  '#6b7d3f',  /* swamp */
  3:  '#5a5a66',  /* crater */
  4:  '#3a3a3a',  /* road */
  5:  '#58a848',  /* forest */
  6:  '#857a6a',  /* rubble */
  7:  '#1e5c2e',  /* grass */
  8:  '#8c8c99',  /* shot building */
  9:  '#a8c4ee',  /* boat on river */
  255: '#123a6b', /* deep sea */
};
const RGB = {};
for (let t = 0; t <= 9; t++) {
  const c = parseInt(TERRAIN_COLORS[t].slice(1), 16);
  RGB[t] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
/* Mined variants share the base terrain colour; the red dot marks the mine */
for (let t = 10; t <= 15; t++) RGB[t] = RGB[t - 8];
{
  const c = parseInt(TERRAIN_COLORS[255].slice(1), 16);
  RGB[255] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

const OBJECT_DEFAULTS = {
  pill:  { owner: 255, armour: 15, speed: 50 },
  base:  { owner: 255, armour: 90, shells: 90, mines: 90 },
  start: { dir: 0 },
};
const OBJECT_FIELDS = {
  pill:  [['owner', 0, 255], ['armour', 0, 15], ['speed', 0, 255]],
  base:  [['owner', 0, 255], ['armour', 0, 90], ['shells', 0, 90], ['mines', 0, 90]],
  start: [['dir', 0, 15]],
};
const OBJECT_LIST = { pill: 'pills', base: 'bases', start: 'starts' };
const OBJECT_LABEL = { pill: 'pillbox', base: 'base', start: 'spawn' };
const OBJECT_LABEL_PLURAL = { pill: 'pillboxes', base: 'bases', start: 'spawns' };

/* ---------- state ---------- */
let doc = BoloMap.newMap();
let filePath = null;
let dirty = false;

let tool = 'paint';
let terrain = 7; /* grass */
let brushSize = 1;
let selected = null; /* {type, index} */
let showPillRange = false;
let symMode = null; /* null | 'h' | 'v' | 'quad' | 'rot180' | 'rot90' */
let symParity = { x: 'odd', y: 'odd' }; /* 'odd': axis through tile 128; 'even': between 127 and 128 */

const PILL_RANGE = 8; /* tiles */

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const view = { zoom: 3, ox: 0, oy: 0 };

const undoStack = [];
const redoStack = [];
const UNDO_MAX = 100;

/* ---------- DOM ---------- */
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const statusBar = document.getElementById('status');
const statusMessage = document.getElementById('statusMessage');
const statusPos = document.getElementById('statusPos');
const statusTerrain = document.getElementById('statusTerrain');
const statusZoom = document.getElementById('statusZoom');
const statusSym = document.getElementById('statusSym');
const countsEl = document.getElementById('counts');
const propsEl = document.getElementById('props');

/* offscreen 1px-per-tile terrain image */
const off = document.createElement('canvas');
off.width = off.height = MAP_SIZE;
const offCtx = off.getContext('2d');
const offImg = offCtx.createImageData(MAP_SIZE, MAP_SIZE);

function rebuildOffscreen() {
  const d = offImg.data;
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const [r, g, b] = RGB[doc.grid[i]] || RGB[255];
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  offCtx.putImageData(offImg, 0, 0);
}
function updateOffPixel(x, y) {
  const i = y * MAP_SIZE + x;
  const [r, g, b] = RGB[doc.grid[i]] || RGB[255];
  const d = offImg.data;
  d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  offCtx.putImageData(offImg, 0, 0, x, y, 1, 1);
}

/* ---------- undo ---------- */
function snapshot() {
  return {
    grid: doc.grid.slice(),
    pills: doc.pills.map(o => ({ ...o })),
    bases: doc.bases.map(o => ({ ...o })),
    starts: doc.starts.map(o => ({ ...o })),
    selected: selected ? { ...selected } : null,
  };
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
}
/* The restored selection is valid by construction: it was captured in
 * the same snapshot as the lists it indexes into. */
function restore(snap) {
  doc.grid = snap.grid;
  doc.pills = snap.pills;
  doc.bases = snap.bases;
  doc.starts = snap.starts;
  selected = snap.selected ? { ...snap.selected } : null;
  rebuildOffscreen();
  renderProps();
  refreshHoverStatus();
  setDirty(true);
  requestDraw();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

/* ---------- helpers ---------- */
function inRegion(x, y) {
  return x >= RGN_LO && x < RGN_HI && y >= RGN_LO && y < RGN_HI;
}
function clampRegion(v) {
  return Math.max(RGN_LO, Math.min(RGN_HI - 1, v));
}
function setDirty(d) {
  dirty = d;
  api.setDirty(d);
  updateTitle();
}
function updateTitle() {
  const name = filePath ? filePath.replace(/^.*[\\/]/, '') : 'untitled.map';
  document.title = `${name}${dirty ? ' •' : ''} — Bolo Map Editor`;
}
/* Transient messages live in their own full-width div (#statusMessage),
 * which always holds the last message; showing it temporarily swaps out
 * the whole info row. The timer only toggles visibility, never content. */
let statusMsgTimer = null;
function statusMsg(text, holdMs = 2500) {
  statusMessage.textContent = text;
  statusBar.classList.add('msg');
  clearTimeout(statusMsgTimer);
  statusMsgTimer = setTimeout(() => statusBar.classList.remove('msg'), holdMs);
}

function updateCounts() {
  countsEl.textContent =
    `pillboxes ${doc.pills.length}/16 · bases ${doc.bases.length}/16 · spawns ${doc.starts.length}/16`;
}

/* ---------- drawing ---------- */
let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function screenToTile(mx, my) {
  return {
    x: Math.floor(view.ox + mx / view.zoom),
    y: Math.floor(view.oy + my / view.zoom),
  };
}
function tileToScreenX(tx) { return (tx - view.ox) * view.zoom; }
function tileToScreenY(ty) { return (ty - view.oy) * view.zoom; }

function cssSize() {
  return { w: canvas.clientWidth, h: canvas.clientHeight };
}

function clampView() {
  const { w, h } = cssSize();
  const tw = w / view.zoom, th = h / view.zoom;
  const margin = 16;
  view.ox = Math.max(-tw + margin, Math.min(MAP_SIZE - margin, view.ox));
  view.oy = Math.max(-th + margin, Math.min(MAP_SIZE - margin, view.oy));
}

function draw() {
  const { w, h } = cssSize();
  const z = view.zoom;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, w, h);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);

  /* darken the strip WinBolo won't save (outside 21..235) */
  const rx0 = tileToScreenX(RGN_LO), ry0 = tileToScreenY(RGN_LO);
  const rx1 = tileToScreenX(RGN_HI), ry1 = tileToScreenY(RGN_HI);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  const mx0 = tileToScreenX(0), my0 = tileToScreenY(0);
  const mx1 = tileToScreenX(MAP_SIZE), my1 = tileToScreenY(MAP_SIZE);
  ctx.fillRect(mx0, my0, mx1 - mx0, Math.max(0, ry0 - my0));            /* top */
  ctx.fillRect(mx0, ry1, mx1 - mx0, Math.max(0, my1 - ry1));            /* bottom */
  ctx.fillRect(mx0, ry0, Math.max(0, rx0 - mx0), ry1 - ry0);            /* left */
  ctx.fillRect(rx1, ry0, Math.max(0, mx1 - rx1), ry1 - ry0);            /* right */
  ctx.strokeStyle = 'rgba(255,120,120,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx0 + 0.5, ry0 + 0.5, rx1 - rx0 - 1, ry1 - ry0 - 1);

  /* visible tile range */
  const tx0 = Math.max(0, Math.floor(view.ox));
  const ty0 = Math.max(0, Math.floor(view.oy));
  const tx1 = Math.min(MAP_SIZE, Math.ceil(view.ox + w / z));
  const ty1 = Math.min(MAP_SIZE, Math.ceil(view.oy + h / z));

  /* mine dots — the sole mine indicator, so drawn at every zoom */
  {
    const r = Math.max(0.5, z * 0.28);
    ctx.fillStyle = '#ff3b30';
    ctx.strokeStyle = '#7a0000';
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        const t = doc.grid[ty * MAP_SIZE + tx];
        if (t >= 10 && t <= 15) {
          const cx = tileToScreenX(tx) + z / 2, cy = tileToScreenY(ty) + z / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
          if (z >= 6) ctx.stroke();
        }
      }
    }
  }

  /* grid */
  if (z >= 8) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = tx0; tx <= tx1; tx++) {
      const sx = Math.round(tileToScreenX(tx)) + 0.5;
      ctx.moveTo(sx, tileToScreenY(ty0));
      ctx.lineTo(sx, tileToScreenY(ty1));
    }
    for (let ty = ty0; ty <= ty1; ty++) {
      const sy = Math.round(tileToScreenY(ty)) + 0.5;
      ctx.moveTo(tileToScreenX(tx0), sy);
      ctx.lineTo(tileToScreenX(tx1), sy);
    }
    ctx.stroke();
  }

  /* pillbox range rings, under the object icons */
  if (showPillRange) {
    ctx.strokeStyle = 'rgba(255,59,48,0.3)';
    ctx.lineWidth = 1.5;
    for (const p of doc.pills) {
      ctx.beginPath();
      ctx.arc(tileToScreenX(p.x) + z / 2, tileToScreenY(p.y) + z / 2, PILL_RANGE * z, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* objects */
  const iconR = Math.max(4, z * 0.45);
  const font = `${Math.max(8, Math.round(z * 0.6))}px sans-serif`;
  for (const [i, b] of doc.bases.entries()) {
    drawObject('base', i, b, iconR, font);
  }
  for (const [i, p] of doc.pills.entries()) {
    drawObject('pill', i, p, iconR, font);
  }
  for (const [i, s] of doc.starts.entries()) {
    drawObject('start', i, s, iconR, font);
  }

  /* symmetry axes / centre marker: through the middle of tile 128 for an
   * odd axis, on the 127|128 tile boundary for an even one */
  if (symMode) {
    const ax = tileToScreenX(symParity.x === 'even' ? 128 : 128.5);
    const ay = tileToScreenY(symParity.y === 'even' ? 128 : 128.5);
    ctx.strokeStyle = 'rgba(110,190,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    if (symMode === 'h' || symMode === 'quad') {
      ctx.beginPath();
      ctx.moveTo(ax, my0);
      ctx.lineTo(ax, my1);
      ctx.stroke();
    }
    if (symMode === 'v' || symMode === 'quad') {
      ctx.beginPath();
      ctx.moveTo(mx0, ay);
      ctx.lineTo(mx1, ay);
      ctx.stroke();
    }
    if (symMode === 'rot180' || symMode === 'rot90') {
      ctx.beginPath();
      ctx.arc(ax, ay, Math.max(9, z * 0.75), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(110,190,255,0.6)';
      ctx.beginPath();
      ctx.arc(ax, ay, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setLineDash([]);
  }
}

function drawObject(type, index, o, r, font) {
  const z = view.zoom;
  const cx = tileToScreenX(o.x) + z / 2;
  const cy = tileToScreenY(o.y) + z / 2;
  const isSel = selected && selected.type === type && selected.index === index;
  ctx.lineWidth = 1.5;
  if (type === 'pill') {
    ctx.fillStyle = '#e33';
    ctx.strokeStyle = '#600';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (type === 'base') {
    ctx.fillStyle = '#f0b429';
    ctx.strokeStyle = '#7a5200';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#333';
    /* File format: 0 = east, counter-clockwise (startsConvertDir in starts.c).
     * Canvas rotation is clockwise-from-north, so mirror: (4 - dir) mod 16. */
    const ang = (((4 - o.dir) & 15) / 16) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, r);
    ctx.lineTo(-r * 0.8, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  if (isSel) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - r - 3, cy - r - 3, (r + 3) * 2, (r + 3) * 2);
  }
  if (view.zoom >= 10) {
    ctx.fillStyle = '#fff';
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.fillText(String(index + 1), cx, cy - r - 3);
  }
}

/* ---------- editing ---------- */
function setCell(x, y, t) {
  if (!inRegion(x, y)) return false;
  /* spawn points must sit on deep sea */
  if (t !== DEEP_SEA && objectAt('start', x, y) >= 0) return false;
  const i = y * MAP_SIZE + x;
  if (doc.grid[i] === t) return false;
  doc.grid[i] = t;
  updateOffPixel(x, y);
  return true;
}

/* setCell across the whole symmetry orbit of (x,y). Off-region images are
 * rejected by setCell like any other cell (and with symmetry on, an image
 * of an in-region cell is always in-region: the saved region maps onto
 * itself under every mode). */
function setCellSym(x, y, t) {
  let changed = false;
  for (const m of symOrbit(x, y)) changed = setCell(m.x, m.y, t) || changed;
  return changed;
}

function paintBrush(x, y, t) {
  const o = Math.floor((brushSize - 1) / 2);
  let changed = false;
  for (let dy = 0; dy < brushSize; dy++) {
    for (let dx = 0; dx < brushSize; dx++) {
      changed = setCellSym(x - o + dx, y - o + dy, t) || changed;
    }
  }
  return changed;
}

function paintLine(x0, y0, x1, y1, t) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, changed = false;
  for (;;) {
    changed = paintBrush(x0, y0, t) || changed;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return changed;
}

function floodFill(x, y, t) {
  if (!inRegion(x, y)) return false;
  const target = doc.grid[y * MAP_SIZE + x];
  if (target === t) return false;
  const stack = [[x, y]];
  const visited = new Uint8Array(MAP_SIZE * MAP_SIZE);
  const filled = [];
  let changed = false;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (!inRegion(cx, cy)) continue;
    const i = cy * MAP_SIZE + cx;
    if (visited[i] || doc.grid[i] !== target) continue;
    visited[i] = 1;
    /* fill flows past spawn points but leaves their deep sea untouched */
    if (t === DEEP_SEA || objectAt('start', cx, cy) < 0) {
      doc.grid[i] = t;
      filled.push(i);
      changed = true;
    }
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  /* Replicate to the symmetry images only after the traversal: painting
   * them mid-flood would cut off a fill region that straddles an axis.
   * Direct grid writes (setCell's rules, minus the per-pixel offscreen
   * update) keep giant fills from doing thousands of 1px blits. */
  if (symMode) {
    for (const i of filled) {
      for (const m of symOrbit(i & 0xff, i >> 8)) {
        if (!inRegion(m.x, m.y)) continue;
        if (t !== DEEP_SEA && objectAt('start', m.x, m.y) >= 0) continue;
        const j = m.y * MAP_SIZE + m.x;
        if (doc.grid[j] !== t) { doc.grid[j] = t; changed = true; }
      }
    }
  }
  if (changed) rebuildOffscreen();
  return changed;
}

/* Direction (file convention: 0=E, counter-clockwise, 16 steps) from (x,y)
 * toward the centre of mass of land; empty map falls back to map centre. */
function spawnDirToward(x, y) {
  let sx = 0, sy = 0, n = 0;
  for (let ty = 0; ty < MAP_SIZE; ty++) {
    for (let tx = 0; tx < MAP_SIZE; tx++) {
      if (doc.grid[ty * MAP_SIZE + tx] !== DEEP_SEA) { sx += tx; sy += ty; n++; }
    }
  }
  const cx = n ? sx / n : 128, cy = n ? sy / n : 128;
  /* map y grows southward, so negate dy for a 0=east counter-clockwise angle */
  const ang = Math.atan2(-(cy - y), cx - x);
  return ((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16;
}

function objectAt(type, x, y) {
  return doc[OBJECT_LIST[type]].findIndex(o => o.x === x && o.y === y);
}

/* First object of any type on this tile, as {type, index}, else null. */
function objectAtAnyType(x, y) {
  for (const type of Object.keys(OBJECT_LIST)) {
    const index = objectAt(type, x, y);
    if (index >= 0) return { type, index };
  }
  return null;
}

function deleteSelected() {
  if (!selected) return;
  const list = doc[OBJECT_LIST[selected.type]];
  if (!list[selected.index]) { selected = null; return; }
  pushUndo();
  list.splice(selected.index, 1);
  selected = null;
  setDirty(true);
  updateCounts();
  renderProps();
  requestDraw();
}

/* Is any object (of any type) on this tile, other than the excluded one? */
function tileOccupied(x, y, exclType, exclIndex) {
  for (const type of Object.keys(OBJECT_LIST)) {
    const idx = objectAt(type, x, y);
    if (idx >= 0 && !(type === exclType && idx === exclIndex)) return true;
  }
  return false;
}

/* ---------- symmetry ---------- */
function symOrbit(x, y) {
  return BoloSym.orbit(symMode, symParity, x, y);
}

/* Bounding box of everything that isn't deep sea, plus all objects
 * (spawns sit on deep sea, so terrain alone would miss them). */
function contentBounds() {
  let minX = MAP_SIZE, minY = MAP_SIZE, maxX = -1, maxY = -1;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (doc.grid[y * MAP_SIZE + x] === DEEP_SEA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (const listName of Object.values(OBJECT_LIST)) {
    for (const o of doc[listName]) {
      if (o.x < minX) minX = o.x;
      if (o.x > maxX) maxX = o.x;
      if (o.y < minY) minY = o.y;
      if (o.y > maxY) maxY = o.y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/* Best-effort recentring when symmetry is switched on: shift everything
 * so the content straddles the centre cell (128,128). Content inside the
 * saved region stays inside it (the centred box can't overhang, because
 * the region itself is centred on 128). One undoable step. */
function centreContent() {
  const b = contentBounds();
  if (!b) return false;
  const { dx, dy } = BoloSym.centreShift(b, symParity);
  if (!dx && !dy) return false;
  pushUndo();
  const ng = new Uint8Array(MAP_SIZE * MAP_SIZE);
  ng.fill(DEEP_SEA);
  for (let y = 0; y < MAP_SIZE; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= MAP_SIZE) continue;
    for (let x = 0; x < MAP_SIZE; x++) {
      const v = doc.grid[y * MAP_SIZE + x];
      if (v === DEEP_SEA) continue;
      const nx = x + dx;
      if (nx >= 0 && nx < MAP_SIZE) ng[ny * MAP_SIZE + nx] = v;
    }
  }
  doc.grid = ng;
  for (const listName of Object.values(OBJECT_LIST)) {
    for (const o of doc[listName]) { o.x += dx; o.y += dy; }
  }
  rebuildOffscreen();
  setDirty(true);
  renderProps();
  refreshHoverStatus();
  return true;
}

function updateSymUI() {
  document.querySelectorAll('button.sym').forEach(b =>
    b.classList.toggle('active', b.dataset.sym === (symMode || 'off')));
  document.querySelectorAll('button.sympar').forEach(b => {
    b.disabled = !symMode;
    b.classList.toggle('active', !!symMode &&
      symParity.x === b.dataset.parity && symParity.y === b.dataset.parity);
  });
  const parityNote = symParity.x === symParity.y
    ? symParity.x
    : `${symParity.x} x, ${symParity.y} y`;
  statusSym.textContent = symMode
    ? `symmetry: ${BoloSym.MODES[symMode].label} (${parityNote} axis)`
    : '';
}

function setSymmetry(mode, quiet) {
  if (mode === symMode) return;
  symMode = mode;
  if (mode) {
    /* Every mode click re-derives the axis parity from the content and
     * recentres, exactly as if entering from off — a manual odd/even
     * override only lasts for the mode it was made in. */
    const b = contentBounds();
    symParity = b ? BoloSym.autoParity(b) : { x: 'odd', y: 'odd' };
    /* a quarter-turn has a single centre: both axes must share a parity */
    if (mode === 'rot90' && symParity.x !== symParity.y) {
      symParity = { x: symParity.x, y: symParity.x };
    }
    updateSymUI();
    const moved = centreContent();
    if (!quiet) {
      const note = symParity.x === symParity.y
        ? `${symParity.x} axis`
        : `mixed axis (${symParity.x} x, ${symParity.y} y)`;
      statusMsg(`symmetry on: ${BoloSym.MODES[mode].label}, ${note}${moved ? ' — map recentred' : ''}`);
    }
  } else {
    updateSymUI();
    if (!quiet) statusMsg('symmetry off');
  }
  requestDraw();
}

/* Manual axis-parity override (sets both axes; recentres to match). */
function setParity(p) {
  if (!symMode) return;
  if (symParity.x === p && symParity.y === p) return;
  symParity = { x: p, y: p };
  updateSymUI();
  const moved = centreContent();
  statusMsg(`symmetry axis: ${p === 'odd' ? 'through tile 128' : 'between tiles 127 and 128'}${moved ? ' — map recentred' : ''}`);
  requestDraw();
}

/* ---------- properties panel ---------- */
function renderProps() {
  propsEl.textContent = '';
  if (!selected) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    const b = document.createElement('b');
    b.textContent = 'Right-click';
    hint.appendChild(b);
    hint.appendChild(document.createTextNode(' an object to select or drag it.'));
    propsEl.appendChild(hint);
    return;
  }
  const list = doc[OBJECT_LIST[selected.type]];
  const o = list[selected.index];
  if (!o) { selected = null; return renderProps(); }

  const h = document.createElement('h3');
  h.textContent = `${OBJECT_LABEL[selected.type]} #${selected.index + 1} at (${o.x}, ${o.y})`;
  propsEl.appendChild(h);

  if (selected.type === 'pill' || selected.type === 'base') {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = 'terrain under';
    const val = document.createElement('span');
    val.textContent = TERRAIN_NAMES[doc.grid[o.y * MAP_SIZE + o.x]];
    row.appendChild(label);
    row.appendChild(val);
    propsEl.appendChild(row);
  }

  for (const [field, min, max] of OBJECT_FIELDS[selected.type]) {
    const row = document.createElement('label');
    row.className = 'row';
    const span = document.createElement('span');
    span.textContent = field === 'owner' ? 'owner (255=neutral)'
                     : field === 'dir' ? 'dir (0=E, counter-cw)'
                     : field;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min; input.max = max; input.value = o[field];
    input.addEventListener('change', () => {
      let v = Math.round(Number(input.value));
      if (!Number.isFinite(v)) v = o[field];
      v = Math.max(min, Math.min(max, v));
      input.value = v;
      if (o[field] !== v) {
        pushUndo();
        o[field] = v;
        setDirty(true);
        requestDraw();
      }
    });
    row.appendChild(span);
    row.appendChild(input);
    propsEl.appendChild(row);
  }

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.addEventListener('click', deleteSelected);
  propsEl.appendChild(del);
}

/* ---------- palette / tools UI ---------- */
function buildPalette() {
  const pal = document.getElementById('palette');
  const order = [7, 5, 4, 2, 0, 8, 6, 3, 9, 1, 255, null,
                 15, 13, 12, 10, null, null, 14, 11];
                 /* nulls: mined building / mined shot building don't exist */
  for (const t of order) {
    if (t === null) { /* spacer separating regular and mined terrain */
      const gap = document.createElement('div');
      gap.className = 'swatch blank';
      pal.appendChild(gap);
      continue;
    }
    const sw = document.createElement('div');
    sw.className = 'swatch' + (t === terrain ? ' active' : '');
    const [r, g, b] = RGB[t];
    sw.style.background = `rgb(${r},${g},${b})`;
    sw.dataset.terrain = t;
    sw.title = TERRAIN_NAMES[t];
    sw.textContent = TERRAIN_NAMES[t];
    if (t >= 10 && t <= 15) {
      const dot = document.createElement('div');
      dot.className = 'minedot';
      sw.appendChild(dot);
    }
    sw.addEventListener('click', () => {
      terrain = t;
      document.querySelectorAll('.swatch').forEach(el => el.classList.remove('active'));
      sw.classList.add('active');
      if (tool !== 'paint' && tool !== 'fill') setTool('paint');
    });
    pal.appendChild(sw);
  }
}

function setTool(t) {
  tool = t;
  document.querySelectorAll('button.tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
}
document.querySelectorAll('button.tool').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('button.sym').forEach(b =>
  b.addEventListener('click', () =>
    setSymmetry(b.dataset.sym === 'off' ? null : b.dataset.sym)));
document.querySelectorAll('button.sympar').forEach(b =>
  b.addEventListener('click', () => setParity(b.dataset.parity)));
document.getElementById('brushSize').addEventListener('change', e => {
  brushSize = Number(e.target.value);
});

/* ---------- mouse input ---------- */
let painting = false;
let paintTerrain = 7;
let lastTile = null;
let panning = false;
let panStart = null;
let spaceDown = false;
let objDrag = null; /* {type, index, undoPushed} */

canvas.addEventListener('contextmenu', e => e.preventDefault());

function updateHoverStatus(t) {
  const inMap = t.x >= 0 && t.x < MAP_SIZE && t.y >= 0 && t.y < MAP_SIZE;
  statusPos.textContent = inMap ? `${t.x}, ${t.y}` : '';
  statusTerrain.textContent = inMap
    ? TERRAIN_NAMES[doc.grid[t.y * MAP_SIZE + t.x]] + (inRegion(t.x, t.y) ? '' : ' (outside saved area)')
    : '';
}

/* Re-check the tile under the last known mouse position, for changes
 * that alter the map without the mouse moving (undo/redo, menu fixes). */
let lastMouse = null;
function refreshHoverStatus() {
  if (lastMouse) updateHoverStatus(screenToTile(lastMouse.mx, lastMouse.my));
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  lastMouse = { mx: e.offsetX, my: e.offsetY };
  const t = screenToTile(e.offsetX, e.offsetY);

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    panning = true;
    panStart = { mx: e.offsetX, my: e.offsetY, ox: view.ox, oy: view.oy };
    canvas.style.cursor = 'grabbing';
    return;
  }

  /* Right-click: select the object under the cursor (whatever the tool)
   * and allow dragging it; an empty tile clears the selection.
   * Delete/Backspace removes the selected object. */
  if (e.button === 2) {
    selected = objectAtAnyType(t.x, t.y);
    if (selected) objDrag = { ...selected, undoPushed: false };
    renderProps();
    requestDraw();
    return;
  }

  if (tool === 'paint' && e.button === 0) {
    pushUndo();
    painting = true;
    paintTerrain = terrain;
    lastTile = t;
    if (paintBrush(t.x, t.y, paintTerrain)) setDirty(true);
    requestDraw();
  } else if (tool === 'fill' && e.button === 0) {
    pushUndo();
    if (floodFill(t.x, t.y, terrain)) {
      setDirty(true);
      if (selected) renderProps();
    } else {
      undoStack.pop();
    }
    requestDraw();
  } else if (tool === 'pill' || tool === 'base' || tool === 'start') {
    const listName = OBJECT_LIST[tool];
    if (e.button === 0) {
      /* placement only: manipulating existing objects is right-click's job */
      if (objectAtAnyType(t.x, t.y)) {
        statusMsg('tile already occupied — right-click to select or drag');
        return;
      }
      if (inRegion(t.x, t.y)) {
        if (tool === 'start' && doc.grid[t.y * MAP_SIZE + t.x] !== DEEP_SEA) {
          statusMsg('spawn points must be on deep sea');
          return;
        }
        const orbit = symOrbit(t.x, t.y);
        if (doc[listName].length + orbit.length > 16) {
          statusMsg(orbit.length > 1
            ? `no room for ${orbit.length} mirrored ${OBJECT_LABEL_PLURAL[tool]} — nothing placed`
            : `max 16 ${OBJECT_LABEL_PLURAL[tool]} reached`);
          return;
        }
        /* all-or-nothing: any bad mirror position vetoes the placement */
        for (const m of orbit.slice(1)) {
          if (!inRegion(m.x, m.y)) {
            /* only reachable with an even axis, whose far edge has no image */
            statusMsg(`mirrored tile (${m.x}, ${m.y}) is outside the saved area — nothing placed`);
            return;
          }
          if (objectAtAnyType(m.x, m.y)) {
            statusMsg(`mirrored tile (${m.x}, ${m.y}) already occupied — nothing placed`);
            return;
          }
          if (tool === 'start' && doc.grid[m.y * MAP_SIZE + m.x] !== DEEP_SEA) {
            statusMsg(`mirrored tile (${m.x}, ${m.y}) is not deep sea — nothing placed`);
            return;
          }
        }
        pushUndo();
        const baseDir = tool === 'start' ? spawnDirToward(t.x, t.y) : 0;
        for (const m of orbit) {
          const o = { x: m.x, y: m.y, ...OBJECT_DEFAULTS[tool] };
          if (tool === 'start') o.dir = m.dir(baseDir);
          doc[listName].push(o);
        }
        selected = { type: tool, index: doc[listName].length - orbit.length };
        /* drag-after-place only when there are no mirror copies to desync */
        objDrag = orbit.length === 1
          ? { type: tool, index: selected.index, undoPushed: true }
          : null;
        setDirty(true);
        updateCounts();
      }
      renderProps();
      requestDraw();
    }
  }

  updateHoverStatus(t); /* clicks change the tile without moving the mouse */
});

canvas.addEventListener('pointermove', e => {
  lastMouse = { mx: e.offsetX, my: e.offsetY };
  const t = screenToTile(e.offsetX, e.offsetY);

  if (panning && panStart) {
    view.ox = panStart.ox - (e.offsetX - panStart.mx) / view.zoom;
    view.oy = panStart.oy - (e.offsetY - panStart.my) / view.zoom;
    clampView();
    requestDraw();
  } else if (painting && lastTile) {
    if (t.x !== lastTile.x || t.y !== lastTile.y) {
      if (paintLine(lastTile.x, lastTile.y, t.x, t.y, paintTerrain)) setDirty(true);
      lastTile = t;
      requestDraw();
    }
  } else if (objDrag) {
    const o = doc[OBJECT_LIST[objDrag.type]][objDrag.index];
    const nx = clampRegion(t.x), ny = clampRegion(t.y);
    if (objDrag.type === 'start' && doc.grid[ny * MAP_SIZE + nx] !== DEEP_SEA) {
      statusMsg('spawn points must be on deep sea');
      return;
    }
    if (tileOccupied(nx, ny, objDrag.type, objDrag.index)) {
      statusMsg('tile already occupied by another object');
      return;
    }
    if (o && (o.x !== nx || o.y !== ny)) {
      if (!objDrag.undoPushed) { pushUndo(); objDrag.undoPushed = true; }
      o.x = nx; o.y = ny;
      setDirty(true);
      renderProps();
      requestDraw();
    }
  }

  updateHoverStatus(t);
});

canvas.addEventListener('pointerup', () => {
  if (painting && selected) renderProps(); /* refresh "terrain under" readout */
  painting = false;
  lastTile = null;
  panning = false;
  panStart = null;
  objDrag = null;
  canvas.style.cursor = spaceDown ? 'grab' : 'crosshair';
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const idx = ZOOMS.indexOf(view.zoom);
  const nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + (e.deltaY < 0 ? 1 : -1)));
  zoomTo(ZOOMS[nidx], e.offsetX, e.offsetY);
}, { passive: false });

function zoomTo(z, mx, my) {
  if (z === view.zoom) return;
  const { w, h } = cssSize();
  if (mx === undefined) { mx = w / 2; my = h / 2; }
  const tx = view.ox + mx / view.zoom;
  const ty = view.oy + my / view.zoom;
  view.zoom = z;
  view.ox = tx - mx / z;
  view.oy = ty - my / z;
  clampView();
  statusZoom.textContent = `zoom ${z}×`;
  requestDraw();
}

function zoomStep(delta) {
  const idx = ZOOMS.indexOf(view.zoom);
  const nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + delta));
  zoomTo(ZOOMS[nidx]);
}

function zoomFit() {
  const { w, h } = cssSize();
  let z = ZOOMS[0];
  for (const c of ZOOMS) if (c * MAP_SIZE <= Math.min(w, h)) z = c;
  view.zoom = z;
  view.ox = 128 - w / (2 * z);
  view.oy = 128 - h / (2 * z);
  statusZoom.textContent = `zoom ${z}×`;
  requestDraw();
}

window.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') {
    spaceDown = true;
    canvas.style.cursor = 'grab';
    e.preventDefault();
  }
  if (e.code === 'Escape') {
    selected = null;
    renderProps();
    requestDraw();
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') &&
      selected && document.activeElement.tagName !== 'INPUT') {
    deleteSelected();
    e.preventDefault();
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    spaceDown = false;
    if (!panning) canvas.style.cursor = 'crosshair';
  }
});

/* ---------- status-grid ordering fixes ---------- */
/* The in-game status display is a 6×3 grid with the two central cells void.
 * Object #1 occupies the top-left cell, filling row-major around the voids: */
const STATUS_SLOTS = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
  [0, 1], [1, 1],       /* (2,1),(3,1) void */       [4, 1], [5, 1],
  [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2],
];

/* Spawns have no in-game status grid; order them top-to-bottom (1×16 column). */
const SPAWN_SLOTS = Array.from({ length: 16 }, (_, i) => [0, i]);

/* Hungarian algorithm (Kuhn–Munkres with potentials), rows n ≤ cols m.
 * Returns assign[i] = column chosen for row i, minimizing total cost. */
function hungarian(cost) {
  const n = cost.length, m = cost[0].length;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assign = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j] > 0) assign[p[j] - 1] = j - 1;
  return assign;
}

/* Reorder a list so index order matches the given grid slots intuitively:
 * percentile-rank positions, squared-distance cost, optimal assignment. */
function statusGridOrder(list, slots) {
  const n = list.length;
  const idx = [...list.keys()];
  const byX = idx.slice().sort((a, b) => list[a].x - list[b].x || list[a].y - list[b].y);
  const byY = idx.slice().sort((a, b) => list[a].y - list[b].y || list[a].x - list[b].x);
  const rx = new Array(n), ry = new Array(n);
  byX.forEach((i, r) => { rx[i] = r; });
  byY.forEach((i, r) => { ry[i] = r; });
  const span = Math.max(1, n - 1);
  const gw = Math.max(...slots.map(s => s[0])); /* grid extents for rank scaling */
  const gh = Math.max(...slots.map(s => s[1]));
  const cost = list.map((o, i) => slots.map(([sx, sy]) => {
    const dx = (gw * rx[i]) / span - sx;
    const dy = (gh * ry[i]) / span - sy;
    return dx * dx + dy * dy;
  }));
  const assign = hungarian(cost);
  return idx.sort((a, b) => assign[a] - assign[b]).map(i => list[i]);
}

/* Each cmd* fix supports quiet mode: no undo/status/redraw (the caller
 * batches those), and returns whether anything changed. */
function cmdFixOrder(listName, label, slots, quiet) {
  const list = doc[listName];
  if (list.length < 2) return false;
  const reordered = statusGridOrder(list, slots);
  if (reordered.every((o, i) => o === list[i])) {
    if (!quiet) statusMsg(`${label} already in status-grid order`);
    return false;
  }
  if (!quiet) pushUndo();
  /* the selection follows its object to the object's new index */
  if (selected && OBJECT_LIST[selected.type] === listName) {
    selected.index = reordered.indexOf(list[selected.index]);
  }
  doc[listName] = reordered;
  if (!quiet) {
    setDirty(true);
    renderProps();
    requestDraw();
    statusMsg(`${label} reordered to match status grid`);
  }
  return true;
}

/* Re-aim every spawn at the land centre of mass (as placement does). */
function cmdFixSpawnDirs(quiet) {
  if (!doc.starts.length) return false;
  const newDirs = doc.starts.map(s => spawnDirToward(s.x, s.y));
  if (newDirs.every((d, i) => d === doc.starts[i].dir)) {
    if (!quiet) statusMsg('spawn directions already correct');
    return false;
  }
  if (!quiet) pushUndo();
  newDirs.forEach((d, i) => { doc.starts[i].dir = d; });
  if (!quiet) {
    setDirty(true);
    renderProps();
    requestDraw();
    statusMsg('spawn directions re-aimed at land centre');
  }
  return true;
}

/* Reset all objects of a type to neutral ownership and default stats. */
function cmdResetObjects(type, label, quiet) {
  const list = doc[OBJECT_LIST[type]];
  const defaults = OBJECT_DEFAULTS[type];
  if (!list.length) return false;
  if (list.every(o => Object.entries(defaults).every(([k, v]) => o[k] === v))) {
    if (!quiet) statusMsg(`${label} already at defaults`);
    return false;
  }
  if (!quiet) pushUndo();
  for (const o of list) Object.assign(o, defaults);
  if (!quiet) {
    setDirty(true);
    renderProps();
    requestDraw();
    statusMsg(`${label} reset to neutral defaults`);
  }
  return true;
}

/* Convert every deep sea tile that touches land (orthogonally or
 * diagonally) to river, giving coastlines a shallow-water buffer.
 * Neighbours are read via getPos so tiles outside the saved region
 * count as deep sea, matching what the file will actually contain.
 * Tiles under spawn points are skipped: spawns require deep sea. */
function cmdBufferSea(quiet) {
  const RIVER = 1;
  const isWater = t => t === DEEP_SEA || t === RIVER || t === 9; /* 9 = boat */
  const toConvert = [];
  for (let y = RGN_LO; y < RGN_HI; y++) {
    for (let x = RGN_LO; x < RGN_HI; x++) {
      if (doc.grid[y * MAP_SIZE + x] !== DEEP_SEA) continue;
      if (objectAt('start', x, y) >= 0) continue;
      let touchesLand = false;
      for (let dy = -1; dy <= 1 && !touchesLand; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && !isWater(BoloMap.getPos(doc.grid, x + dx, y + dy))) {
            touchesLand = true;
            break;
          }
        }
      }
      if (touchesLand) toConvert.push(y * MAP_SIZE + x);
    }
  }
  if (!toConvert.length) {
    if (!quiet) statusMsg('sea already buffered');
    return false;
  }
  if (!quiet) pushUndo();
  for (const i of toConvert) doc.grid[i] = RIVER;
  rebuildOffscreen();
  if (!quiet) {
    setDirty(true);
    renderProps();
    refreshHoverStatus();
    requestDraw();
    statusMsg(`buffered the sea: ${toConvert.length} tile${toConvert.length === 1 ? '' : 's'} converted to river`);
  }
  return true;
}

/* Run every fix as one undoable step. */
function cmdApplyAllFixes() {
  const snap = snapshot();
  const changed = [
    cmdFixOrder('pills', 'pillboxes', STATUS_SLOTS, true),
    cmdFixOrder('bases', 'bases', STATUS_SLOTS, true),
    cmdFixOrder('starts', 'spawns', SPAWN_SLOTS, true),
    cmdFixSpawnDirs(true),
    cmdResetObjects('pill', 'pillboxes', true),
    cmdResetObjects('base', 'bases', true),
  ].filter(Boolean).length;
  if (!changed) {
    statusMsg('no fixes needed');
    return;
  }
  undoStack.push(snap);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  setDirty(true);
  renderProps();
  requestDraw();
  statusMsg(`applied ${changed} fix${changed === 1 ? '' : 'es'}`);
}

/* ---------- file operations ---------- */
function loadDoc(map, path) {
  doc = map;
  filePath = path;
  selected = null;
  setSymmetry(null, true); /* a fresh document starts unsymmetric */
  undoStack.length = 0;
  redoStack.length = 0;
  rebuildOffscreen();
  renderProps();
  updateCounts();
  setDirty(false);
  zoomFit();
}

async function cmdNew() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  loadDoc(BoloMap.newMap(), null);
}

function loadFromBytes(data, path) {
  try {
    loadDoc(BoloMap.parseMap(data), path);
  } catch (err) {
    alert(`Could not read map: ${err.message}`);
  }
}

async function cmdOpen() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const res = await api.openMap();
  if (res.canceled) {
    if (res.error) alert(res.error);
    return;
  }
  loadFromBytes(res.data, res.path);
}

/* map passed on the command line (sent by main once the page loads) */
api.onLoadMap(({ path, data }) => loadFromBytes(data, path));

/* drag & drop a .map anywhere onto the window */
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const data = new Uint8Array(await file.arrayBuffer());
  let path = null;
  try { path = api.pathForFile(file) || null; } catch { /* keep null: Save will ask */ }
  loadFromBytes(data, path);
});

async function cmdSave(as) {
  const bytes = BoloMap.serializeMap(doc);
  const res = await api.saveMap(as ? null : filePath, bytes);
  if (res.canceled) {
    if (res.error) alert(res.error);
    return;
  }
  filePath = res.path;
  setDirty(false);
}

api.onMenu(cmd => {
  switch (cmd) {
    case 'new': cmdNew(); break;
    case 'open': cmdOpen(); break;
    case 'save': cmdSave(false); break;
    case 'save-as': cmdSave(true); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'fix-base-order': cmdFixOrder('bases', 'bases', STATUS_SLOTS); break;
    case 'fix-pill-order': cmdFixOrder('pills', 'pillboxes', STATUS_SLOTS); break;
    case 'fix-start-order': cmdFixOrder('starts', 'spawns', SPAWN_SLOTS); break;
    case 'fix-start-dirs': cmdFixSpawnDirs(); break;
    case 'reset-pills': cmdResetObjects('pill', 'pillboxes'); break;
    case 'reset-bases': cmdResetObjects('base', 'bases'); break;
    case 'buffer-sea': cmdBufferSea(); break;
    case 'apply-all-fixes': cmdApplyAllFixes(); break;
    case 'toggle-pill-range': showPillRange = !showPillRange; requestDraw(); break;
    case 'zoom-in': zoomStep(1); break;
    case 'zoom-out': zoomStep(-1); break;
    case 'zoom-fit': zoomFit(); break;
  }
});

/* ---------- boot ---------- */
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(h * devicePixelRatio));
  /* Draw synchronously: setting width/height blanks the canvas, and the
   * ResizeObserver callback runs before paint, so an immediate draw means
   * the blank state is never presented (a deferred rAF draw would flicker). */
  draw();
}
new ResizeObserver(resize).observe(canvas);

buildPalette();
rebuildOffscreen();
updateCounts();
updateSymUI();
renderProps();
updateTitle();
statusZoom.textContent = `zoom ${view.zoom}×`;
resize();
zoomFit();
