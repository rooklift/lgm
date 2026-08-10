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

const BoloSym = { MODES, transforms, orbit, centreShift, autoParity };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoloSym;
} else {
  window.BoloSym = BoloSym;
}

})();
