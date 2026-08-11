/*
 * Symmetry transforms for the editor.
 *
 * Each axis has a parity. 'odd' puts the axis through the middle of
 * tile 128 (mirror: x -> 256-x): the saved region (21..235 inclusive,
 * 215 tiles, odd) maps exactly onto itself, and a cell on the axis is
 * its own image. 'even' puts the axis on the boundary between tiles
 * 127 and 128 (mirror: x -> 255-x) for maps whose content is an even
 * number of tiles across; the far edge of the saved region (235) then
 * has no in-region image, so edits there simply don't replicate.
 *
 * dir() maps a spawn's direction (file convention: 0 = east, counter-
 * clockwise, 16 steps) to the direction of its image. Map y grows south,
 * so R1 is a clockwise quarter-turn as seen on screen. R1/R3 require
 * both axes to share a parity (a quarter-turn has a single centre);
 * callers enforce that for rot90.
 */
'use strict';
(function () {

const MODES = {
  h:      { label: 'mirror ⇋' },
  v:      { label: 'mirror ⇅' },
  quad:   { label: 'quad mirror' },
  rot180: { label: 'rotate 180°' },
  rot90:  { label: 'rotate 90°' },
};

/* parity: { x: 'odd'|'even', y: 'odd'|'even' } */
function transforms(mode, parity) {
  const cx = parity.x === 'even' ? 255 : 256;
  const cy = parity.y === 'even' ? 255 : 256;
  const ID = { pos: (x, y) => [x, y],           dir: d => d };
  const MX = { pos: (x, y) => [cx - x, y],      dir: d => (8 - d) & 15 };  /* mirror left-right */
  const MY = { pos: (x, y) => [x, cy - y],      dir: d => (16 - d) & 15 }; /* mirror top-bottom */
  const R1 = { pos: (x, y) => [cx - y, x],      dir: d => (d + 12) & 15 }; /* quarter turn */
  const R2 = { pos: (x, y) => [cx - x, cy - y], dir: d => (d + 8) & 15 };  /* half turn */
  const R3 = { pos: (x, y) => [y, cy - x],      dir: d => (d + 4) & 15 };  /* three-quarter turn */
  switch (mode) {
    case 'h':      return [ID, MX];
    case 'v':      return [ID, MY];
    case 'quad':   return [ID, MX, MY, R2];
    case 'rot180': return [ID, R2];
    case 'rot90':  return [ID, R1, R2, R3];
    default:       return [ID];
  }
}

/* All images of (x,y) under the mode, primary first, deduplicated
 * (with an odd axis, a cell on the axis is its own image). A
 * null/undefined mode yields just the primary, so callers can use
 * this unconditionally. */
function orbit(mode, parity, x, y) {
  const out = [];
  const seen = new Set();
  for (const t of transforms(mode, parity)) {
    const [ox, oy] = t.pos(x, y);
    const key = ox + ',' + oy;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ x: ox, y: oy, dir: t.dir });
    }
  }
  return out;
}

/* Shift that centres a content bounding box on the axes' crossing:
 * cell (128,128) for odd axes, the corner between (127,127) and
 * (128,128) for even ones. When the box's parity matches the axis
 * parity the centring is exact; otherwise it lands half a tile off,
 * which play never notices. */
function centreShift(b, parity) {
  const sx = parity.x === 'even' ? 255 : 256;
  const sy = parity.y === 'even' ? 255 : 256;
  return {
    dx: Math.round((sx - b.minX - b.maxX) / 2),
    dy: Math.round((sy - b.minY - b.maxY) / 2),
  };
}

/* Parity that centres this bounding box exactly, per axis: odd-sized
 * content wants an axis through a tile, even-sized content one between
 * tiles. */
function autoParity(b) {
  return {
    x: (b.maxX - b.minX) % 2 === 0 ? 'odd' : 'even',
    y: (b.maxY - b.minY) % 2 === 0 ? 'odd' : 'even',
  };
}

/* Constants mirrored from format.js so node tests can load sym.js alone. */
const SIZE = 256, DEEP_SEA = 0xff, LO = 21, HI = 236;

/* Detect whether a map is already perfectly symmetric, and under which
 * mode. Symmetry is judged about the content's own axes (the bounding
 * box centre — any mirror or rotation must pass through it), so a
 * symmetric map made elsewhere is recognised wherever it sits; the
 * caller recentres it onto the board's standard axes afterwards.
 *
 * Slackness, by design: spawn points are ignored entirely; object
 * properties are ignored (positions only); and terrain mismatches are
 * excused when either cell sits under any object.
 *
 * Returns { mode, parity, bounds } or null. Preference order when
 * several modes hold: quad, rot90, h, v, rot180. */
function detect(map) {
  let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
  const bump = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (let y = LO; y < HI; y++) {
    for (let x = LO; x < HI; x++) {
      if (map.grid[y * SIZE + x] !== DEEP_SEA) bump(x, y);
    }
  }
  for (const o of map.pills) bump(o.x, o.y);
  for (const o of map.bases) bump(o.x, o.y);
  if (maxX < 0) return null;
  const bounds = { minX, minY, maxX, maxY };

  /* mirror sums: the x mirror is x -> S-x, so the axis sits at S/2 */
  const S = minX + maxX, T = minY + maxY;

  const inReg = (x, y) => x >= LO && x < HI && y >= LO && y < HI;
  const occ = new Set();
  for (const list of [map.pills, map.bases, map.starts]) {
    for (const o of list) occ.add(o.y * SIZE + o.x);
  }
  const pillSet = new Set(map.pills.map(o => o.y * SIZE + o.x));
  const baseSet = new Set(map.bases.map(o => o.y * SIZE + o.x));

  const invariant = f => {
    for (let y = LO; y < HI; y++) {
      for (let x = LO; x < HI; x++) {
        const [ix, iy] = f(x, y);
        const a = map.grid[y * SIZE + x];
        const b = inReg(ix, iy) ? map.grid[iy * SIZE + ix] : DEEP_SEA;
        if (a === b) continue;
        if (occ.has(y * SIZE + x)) continue;
        if (inReg(ix, iy) && occ.has(iy * SIZE + ix)) continue;
        return false;
      }
    }
    return true;
  };
  const closed = (list, set, f) => list.every(o => {
    const [ix, iy] = f(o.x, o.y);
    return ix >= 0 && ix < SIZE && iy >= 0 && iy < SIZE && set.has(iy * SIZE + ix);
  });
  const holds = f => invariant(f) && closed(map.pills, pillSet, f) && closed(map.bases, baseSet, f);

  const MX = (x, y) => [S - x, y];
  const MY = (x, y) => [x, T - y];
  const R2 = (x, y) => [S - x, T - y];
  /* quarter turn about (S/2, T/2): needs a square box and an integer-
   * valued map (S and T of equal parity) */
  const square = (maxX - minX) === (maxY - minY) && (S + T) % 2 === 0;
  const R1 = (x, y) => [(S + T) / 2 - y, (T - S) / 2 + x];

  const parity = {
    x: S % 2 === 0 ? 'odd' : 'even',
    y: T % 2 === 0 ? 'odd' : 'even',
  };
  if (holds(MX)) {
    /* mirror-x plus rot90 would imply mirror-y, so quad wins that race */
    if (holds(MY)) return { mode: 'quad', parity, bounds };
    return { mode: 'h', parity, bounds };
  }
  if (square && holds(R1)) return { mode: 'rot90', parity, bounds };
  if (holds(MY)) return { mode: 'v', parity, bounds };
  if (holds(R2)) return { mode: 'rot180', parity, bounds };
  return null;
}

const BoloSym = { MODES, transforms, orbit, centreShift, autoParity, detect };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoloSym;
} else {
  window.BoloSym = BoloSym;
}

})();
