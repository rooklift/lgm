/*
 * Symmetry transforms for the editor.
 *
 * Each axis has a parity. "odd" puts the axis through the middle of
 * tile 128 (mirror: x -> 256-x): the saved region (21..235 inclusive,
 * 215 tiles, odd) maps exactly onto itself, and a cell on the axis is
 * its own image. "even" puts the axis on the boundary between tiles
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
"use strict";
(function () {

const MODES = {
	h:      { label: "mirror ⇋" },
	v:      { label: "mirror ⇅" },
	quad:   { label: "quad mirror" },
	rot180: { label: "rotate 180°" },
	rot90:  { label: "rotate 90°" },
};

/* parity: { x: "odd"|"even", y: "odd"|"even" } */
function transforms(mode, parity) {
	let cx = parity.x === "even" ? 255 : 256;
	let cy = parity.y === "even" ? 255 : 256;
	const ID = { pos: (x, y) => [x, y],           dir: d => d };
	const MX = { pos: (x, y) => [cx - x, y],      dir: d => (8 - d) & 15 };  /* mirror left-right */
	const MY = { pos: (x, y) => [x, cy - y],      dir: d => (16 - d) & 15 }; /* mirror top-bottom */
	const R1 = { pos: (x, y) => [cx - y, x],      dir: d => (d + 12) & 15 }; /* quarter turn */
	const R2 = { pos: (x, y) => [cx - x, cy - y], dir: d => (d + 8) & 15 };  /* half turn */
	const R3 = { pos: (x, y) => [y, cy - x],      dir: d => (d + 4) & 15 };  /* three-quarter turn */
	switch (mode) {
		case "h":      return [ID, MX];
		case "v":      return [ID, MY];
		case "quad":   return [ID, MX, MY, R2];
		case "rot180": return [ID, R2];
		case "rot90":  return [ID, R1, R2, R3];
		default:       return [ID];
	}
}

/* All images of (x,y) under the mode, primary first, deduplicated
 * (with an odd axis, a cell on the axis is its own image). A
 * null/undefined mode yields just the primary, so callers can use
 * this unconditionally. */
function orbit(mode, parity, x, y) {
	let out = [];
	let seen = new Set();
	for (let t of transforms(mode, parity)) {
		let [ox, oy] = t.pos(x, y);
		let key = ox + "," + oy;
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
function centre_shift(b, parity) {
	let sx = parity.x === "even" ? 255 : 256;
	let sy = parity.y === "even" ? 255 : 256;
	return {
		dx: Math.round((sx - b.min_x - b.max_x) / 2),
		dy: Math.round((sy - b.min_y - b.max_y) / 2),
	};
}

/* Parity that centres this bounding box exactly, per axis: odd-sized
 * content wants an axis through a tile, even-sized content one between
 * tiles. */
function auto_parity(b) {
	return {
		x: (b.max_x - b.min_x) % 2 === 0 ? "odd" : "even",
		y: (b.max_y - b.min_y) % 2 === 0 ? "odd" : "even",
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
/* Bounding box of terrain plus pills and bases — spawns excluded, since
 * they are invisible to symmetry checks. Null on an empty map. */
function content_box(map) {
	let min_x = SIZE, min_y = SIZE, max_x = -1, max_y = -1;
	let bump = (x, y) => {
		if (x < min_x) min_x = x;
		if (x > max_x) max_x = x;
		if (y < min_y) min_y = y;
		if (y > max_y) max_y = y;
	};
	for (let y = LO; y < HI; y++) {
		for (let x = LO; x < HI; x++) {
			if (map.grid[y * SIZE + x] !== DEEP_SEA) bump(x, y);
		}
	}
	for (let o of map.pills) bump(o.x, o.y);
	for (let o of map.bases) bump(o.x, o.y);
	return max_x < 0 ? null : { min_x, min_y, max_x, max_y };
}

function detect(map) {
	let bounds = content_box(map);
	if (!bounds) return null;
	let { min_x, min_y, max_x, max_y } = bounds;

	/* mirror sums: the x mirror is x -> S-x, so the axis sits at S/2 */
	let S = min_x + max_x, T = min_y + max_y;

	let in_reg = (x, y) => x >= LO && x < HI && y >= LO && y < HI;
	let occ = new Set();
	for (let list of [map.pills, map.bases, map.starts]) {
		for (let o of list) occ.add(o.y * SIZE + o.x);
	}
	let pill_set = new Set(map.pills.map(o => o.y * SIZE + o.x));
	let base_set = new Set(map.bases.map(o => o.y * SIZE + o.x));

	let invariant = f => {
		for (let y = LO; y < HI; y++) {
			for (let x = LO; x < HI; x++) {
				let [ix, iy] = f(x, y);
				let a = map.grid[y * SIZE + x];
				let b = in_reg(ix, iy) ? map.grid[iy * SIZE + ix] : DEEP_SEA;
				if (a === b) continue;
				if (occ.has(y * SIZE + x)) continue;
				if (in_reg(ix, iy) && occ.has(iy * SIZE + ix)) continue;
				return false;
			}
		}
		return true;
	};
	let closed = (list, set, f) => list.every(o => {
		let [ix, iy] = f(o.x, o.y);
		return ix >= 0 && ix < SIZE && iy >= 0 && iy < SIZE && set.has(iy * SIZE + ix);
	});
	let holds = f => invariant(f) && closed(map.pills, pill_set, f) && closed(map.bases, base_set, f);

	const MX = (x, y) => [S - x, y];
	const MY = (x, y) => [x, T - y];
	const R2 = (x, y) => [S - x, T - y];
	/* quarter turn about (S/2, T/2): needs a square box and an integer-
	 * valued map (S and T of equal parity) */
	let square = (max_x - min_x) === (max_y - min_y) && (S + T) % 2 === 0;
	const R1 = (x, y) => [(S + T) / 2 - y, (T - S) / 2 + x];

	let parity = {
		x: S % 2 === 0 ? "odd" : "even",
		y: T % 2 === 0 ? "odd" : "even",
	};
	let found = mode =>
		({ mode, parity, bounds, spawns_symmetric: spawns_symmetric(map, mode, S, T) });
	if (holds(MX)) {
		/* mirror-x plus rot90 would imply mirror-y, so quad wins that race */
		if (holds(MY)) return found("quad");
		return found("h");
	}
	if (square && holds(R1)) return found("rot90");
	if (holds(MY)) return found("v");
	if (holds(R2)) return found("rot180");
	return null;
}

/* Position-only transform group about mirror sums S and T (the x axis
 * sits at S/2, the y axis at T/2). rot90 requires S and T of equal
 * parity; callers ensure that. */
function group_about(mode, S, T) {
	const ID = (x, y) => [x, y];
	const MX = (x, y) => [S - x, y];
	const MY = (x, y) => [x, T - y];
	const R2 = (x, y) => [S - x, T - y];
	const R1 = (x, y) => [(S + T) / 2 - y, (T - S) / 2 + x];
	const R3 = (x, y) => [(S - T) / 2 + y, (S + T) / 2 - x];
	switch (mode) {
		case "h":      return [ID, MX];
		case "v":      return [ID, MY];
		case "quad":   return [ID, MX, MY, R2];
		case "rot180": return [ID, R2];
		default:       return [ID, R1, R2, R3]; /* rot90 */
	}
}

/* Are the spawn points symmetric — as positions, one on every image
 * tile — under the given mode about axes S,T? Spawns are excluded from
 * every other symmetry judgement; this answers that one follow-up
 * question separately. No spawns counts as symmetric. */
function spawns_symmetric(map, mode, S, T) {
	let keys = new Set(map.starts.map(o => o.x + "," + o.y));
	let tf = group_about(mode, S, T);
	return map.starts.every(o => tf.every(f => {
		let [ix, iy] = f(o.x, o.y);
		return keys.has(ix + "," + iy);
	}));
}

/* Score a map's symmetry: the minimum number of edits (tile changes,
 * object additions or removals) that would make it perfectly symmetric,
 * judged with the same slackness as detect(). 0 means perfect.
 *
 * Every mode is tried about a small set of candidate axes — the content
 * box's own axes, one either side (so a single stray tile distorting
 * the box doesn't wreck the score), and the board's standard axes —
 * and the best result wins. Terrain is costed per orbit (orbit size
 * minus its most common value, wildcarding cells under objects); pills
 * and bases per position-orbit (the cheaper of adding the missing or
 * removing the strays).
 *
 * Returns { flaws, mode, parity, S, T, per_mode } or null for an empty
 * map (S and T are the winning mirror sums, for find_flaw). */
function score(map) {
	let b = content_box(map);
	if (!b) return null;
	let S0 = b.min_x + b.max_x, T0 = b.min_y + b.max_y;
	let Sc = [...new Set([S0 - 1, S0, S0 + 1, 255, 256])];
	let Tc = [...new Set([T0 - 1, T0, T0 + 1, 255, 256])];

	let in_reg = (x, y) => x >= LO && x < HI && y >= LO && y < HI;
	let occ = new Set();
	for (let list of [map.pills, map.bases, map.starts]) {
		for (let o of list) occ.add(o.y * SIZE + o.x);
	}
	let pill_keys = new Set(map.pills.map(o => o.x + "," + o.y));
	let base_keys = new Set(map.bases.map(o => o.x + "," + o.y));

	let object_cost = (list, keys, tf) => {
		let cost = 0;
		let done = new Set();
		for (let o of list) {
			if (done.has(o.x + "," + o.y)) continue;
			let slots = new Set();
			for (let f of tf) {
				let [ix, iy] = f(o.x, o.y);
				slots.add(ix + "," + iy);
			}
			let present = 0;
			for (let k of slots) if (keys.has(k)) { present++; done.add(k); }
			cost += Math.min(present, slots.size - present);
		}
		return cost;
	};

	let eval_combo = (mode, S, T) => {
		let tf = group_about(mode, S, T);
		let flaws = 0;
		let seen = new Uint8Array(SIZE * SIZE);
		let ox = [], oy = [], vals = [];
		for (let y = LO; y < HI; y++) {
			for (let x = LO; x < HI; x++) {
				if (seen[y * SIZE + x]) continue;
				ox.length = oy.length = vals.length = 0;
				for (let f of tf) {
					let [ix, iy] = f(x, y);
					let dup = false;
					for (let i = 0; i < ox.length; i++) {
						if (ox[i] === ix && oy[i] === iy) { dup = true; break; }
					}
					if (!dup) { ox.push(ix); oy.push(iy); }
				}
				for (let i = 0; i < ox.length; i++) {
					let ix = ox[i], iy = oy[i];
					if (in_reg(ix, iy)) {
						seen[iy * SIZE + ix] = 1;
						/* cells under objects are wildcards */
						if (!occ.has(iy * SIZE + ix)) vals.push(map.grid[iy * SIZE + ix]);
					} else {
						vals.push(DEEP_SEA); /* off-region reads back as deep sea */
					}
				}
				if (vals.length > 1) {
					/* orbit cost: everything not matching its most common value */
					let maxc = 0;
					for (let i = 0; i < vals.length; i++) {
						let c = 1;
						for (let j = i + 1; j < vals.length; j++) if (vals[j] === vals[i]) c++;
						if (c > maxc) maxc = c;
					}
					flaws += vals.length - maxc;
				}
			}
		}
		return flaws + object_cost(map.pills, pill_keys, tf) + object_cost(map.bases, base_keys, tf);
	};

	let per_mode = {};
	let best = null;
	for (let mode of ["quad", "rot90", "h", "v", "rot180"]) {
		let m = Infinity;
		let Ss = mode === "v" ? [S0] : Sc;
		let Ts = mode === "h" ? [T0] : Tc;
		for (let S of Ss) {
			for (let T of Ts) {
				if (mode === "rot90" && (S + T) % 2 !== 0) continue;
				let f = eval_combo(mode, S, T);
				if (f < m) m = f;
				if (!best || f < best.flaws) best = { flaws: f, mode, S, T };
			}
		}
		per_mode[mode] = m;
	}
	return {
		flaws: best.flaws,
		mode: best.mode,
		parity: {
			x: best.S % 2 === 0 ? "odd" : "even",
			y: best.T % 2 === 0 ? "odd" : "even",
		},
		S: best.S,
		T: best.T,
		per_mode,
		spawns_symmetric: spawns_symmetric(map, best.mode, best.S, best.T),
	};
}

/* Locate one concrete flaw: a tile that score()'s winning mode would
 * edit. Terrain first — an in-region cell, not under an object, that
 * disagrees with its orbit's most common value (or, when the minority
 * is an immutable off-region image, any in-region member of the broken
 * orbit). Then pills and bases: a stray object whose orbit is mostly
 * empty (missing: false), or the empty tile of a mostly-present orbit
 * (missing: true) — matching whichever fix object_cost priced.
 * Returns score()'s result plus a flaw field { x, y, kind, missing }
 * with kind "terrain"|"pill"|"base" (flaw is null when the map is
 * perfect), or null for an empty map. */
function find_flaw(map) {
	let s = score(map);
	if (!s || s.flaws === 0) return s && { ...s, flaw: null };
	let tf = group_about(s.mode, s.S, s.T);

	let in_reg = (x, y) => x >= LO && x < HI && y >= LO && y < HI;
	let occ = new Set();
	for (let list of [map.pills, map.bases, map.starts]) {
		for (let o of list) occ.add(o.y * SIZE + o.x);
	}

	let seen = new Uint8Array(SIZE * SIZE);
	for (let y = LO; y < HI; y++) {
		for (let x = LO; x < HI; x++) {
			if (seen[y * SIZE + x]) continue;
			let mem = [];
			for (let f of tf) {
				let [ix, iy] = f(x, y);
				if (!mem.some(m => m.x === ix && m.y === iy)) mem.push({ x: ix, y: iy });
			}
			for (let m of mem) {
				m.off = !in_reg(m.x, m.y);
				if (!m.off) seen[m.y * SIZE + m.x] = 1;
				m.wild = !m.off && occ.has(m.y * SIZE + m.x);
				m.v = m.off ? DEEP_SEA : map.grid[m.y * SIZE + m.x];
			}
			let vals = mem.filter(m => !m.wild).map(m => m.v);
			if (vals.length < 2) continue;
			let modal = vals[0], maxc = 0;
			for (let v of vals) {
				let c = vals.filter(w => w === v).length;
				if (c > maxc) { maxc = c; modal = v; }
			}
			if (maxc === vals.length) continue;
			let bad = mem.find(m => !m.off && !m.wild && m.v !== modal)
							 || mem.find(m => !m.off && !m.wild);
			if (bad) return { ...s, flaw: { x: bad.x, y: bad.y, kind: "terrain", missing: false } };
		}
	}

	let obj_flaw = (list, kind) => {
		let keys = new Set(list.map(o => o.x + "," + o.y));
		let done = new Set();
		for (let o of list) {
			if (done.has(o.x + "," + o.y)) continue;
			let slots = [];
			for (let f of tf) {
				let [ix, iy] = f(o.x, o.y);
				let k = ix + "," + iy;
				if (!slots.some(sl => sl.k === k)) slots.push({ x: ix, y: iy, k });
			}
			let present = 0;
			for (let sl of slots) if (keys.has(sl.k)) { present++; done.add(sl.k); }
			if (present === slots.length) continue;
			if (present <= slots.length - present) {
				return { x: o.x, y: o.y, kind, missing: false };
			}
			let gap = slots.find(sl => !keys.has(sl.k));
			return { x: gap.x, y: gap.y, kind, missing: true };
		}
		return null;
	};
	let flaw = obj_flaw(map.pills, "pill") || obj_flaw(map.bases, "base");
	return { ...s, flaw };
}

const BoloSym = { MODES, transforms, orbit, centre_shift, auto_parity, content_box,
									spawns_symmetric, detect, score, find_flaw };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloSym;
} else {
	window.BoloSym = BoloSym;
}

})();
