"use strict";
/* Bolo map editor renderer: canvas view, painting tools, objects, undo. */

const { MAP_SIZE, DEEP_SEA, TERRAIN_NAMES, EDGE_MIN, EDGE_MAX } = BoloMap;

/* Editable region: WinBolo's writer drops anything outside (mapGetPos) */
const RGN_LO = EDGE_MIN + 1;   /* 21, inclusive */
const RGN_HI = EDGE_MAX;       /* 236, exclusive */

/* Refuse to slurp files that can't possibly be maps (a maximal legal map
 * is ~113 KB). Keep in sync with MAX_MAP_BYTES in main.js. */
const MAX_MAP_BYTES = 1 << 20;

const TERRAIN_COLORS = {
	0:  "#8a6b4a",  /* building */
	1:  "#3f7fe0",  /* river */
	2:  "#6b7d3f",  /* swamp */
	3:  "#5a5a66",  /* crater */
	4:  "#3a3a3a",  /* road */
	5:  "#58a848",  /* forest */
	6:  "#857a6a",  /* rubble */
	7:  "#1e5c2e",  /* grass */
	8:  "#8c8c99",  /* shot building */
	9:  "#a8c4ee",  /* boat on river */
	255: "#123a6b", /* deep sea */
};
const RGB = {};
for (let t = 0; t <= 9; t++) {
	let c = parseInt(TERRAIN_COLORS[t].slice(1), 16);
	RGB[t] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
/* Mined variants share the base terrain colour; the red dot marks the mine */
for (let t = 10; t <= 15; t++) RGB[t] = RGB[t - 8];
{
	let c = parseInt(TERRAIN_COLORS[255].slice(1), 16);
	RGB[255] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

const OBJECT_DEFAULTS = {
	pill:  { owner: 255, armour: 15, speed: 50 },
	base:  { owner: 255, armour: 90, shells: 90, mines: 90 },
	start: { dir: 0 },
};
const OBJECT_FIELDS = {
	pill:  [["owner", 0, 255], ["armour", 0, 15], ["speed", 0, 255]],
	base:  [["owner", 0, 255], ["armour", 0, 90], ["shells", 0, 90], ["mines", 0, 90]],
	start: [["dir", 0, 15]],
};
const OBJECT_LIST = { pill: "pills", base: "bases", start: "starts" };
const OBJECT_LABEL = { pill: "pillbox", base: "base", start: "spawn" };
const OBJECT_LABEL_PLURAL = { pill: "pillboxes", base: "bases", start: "spawns" };

/* ---------- state ---------- */
let doc = BoloMap.new_map();
let file_path = null;
let dirty = false;

let tool = "paint";
let terrain = 7; /* grass */
let brush_size = 1;
let selected = null; /* {type, index} */
let show_pill_range = false;
let bases_as_circles = false;
let sym_mode = null; /* null | "h" | "v" | "quad" | "rot180" | "rot90" */
let sym_parity = { x: "odd", y: "odd" }; /* "odd": axis through tile 128; "even": between 127 and 128 */

const PILL_RANGE = 8; /* tiles */

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
let view = { zoom: 3, ox: 0, oy: 0 };

const UNDO_MAX = 100;
let undo_stack = [];
let redo_stack = [];

/* ---------- DOM ---------- */
let canvas = document.getElementById("view");
let ctx = canvas.getContext("2d");
let status_bar = document.getElementById("status");
let status_message = document.getElementById("statusMessage");
let status_pos = document.getElementById("statusPos");
let status_terrain = document.getElementById("statusTerrain");
let status_zoom = document.getElementById("statusZoom");
let status_sym = document.getElementById("statusSym");
let counts_el = document.getElementById("counts");
let props_el = document.getElementById("props");

/* offscreen 1px-per-tile terrain image */
let off = document.createElement("canvas");
off.width = off.height = MAP_SIZE;
let off_ctx = off.getContext("2d");
let off_img = off_ctx.createImageData(MAP_SIZE, MAP_SIZE);

function rebuild_offscreen() {
	let d = off_img.data;
	for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
		let [r, g, b] = RGB[doc.grid[i]] || RGB[255];
		d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
	}
	off_ctx.putImageData(off_img, 0, 0);
}
function update_off_pixel(x, y) {
	let i = y * MAP_SIZE + x;
	let [r, g, b] = RGB[doc.grid[i]] || RGB[255];
	let d = off_img.data;
	d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
	off_ctx.putImageData(off_img, 0, 0, x, y, 1, 1);
}

/* ---------- undo ---------- */
function snapshot() {
	return {
		grid: doc.grid.slice(),
		pills: doc.pills.map(o => ({ ...o })),
		bases: doc.bases.map(o => ({ ...o })),
		starts: doc.starts.map(o => ({ ...o })),
		selected: selected ? { ...selected } : null,
		sym_mode,
		sym_parity: { ...sym_parity },
		gen: edit_gen, /* identity of the state captured — see refresh_dirty */
	};
}
/* For edits whose snapshot must predate other state changes (mode or
 * parity switches that recentre): take the snapshot first, mutate,
 * then push it only if something actually changed. */
function push_undo_entry(snap) {
	undo_stack.push(snap);
	if (undo_stack.length > UNDO_MAX) undo_stack.shift();
	redo_stack.length = 0;
}
function push_undo() {
	push_undo_entry(snapshot());
}
/* The restored selection is valid by construction: it was captured in
 * the same snapshot as the lists it indexes into. Symmetry mode and
 * parity travel with the snapshot, so undoing a recentring shift also
 * unwinds the mode change that caused it. */
function restore(snap) {
	doc.grid = snap.grid;
	doc.pills = snap.pills;
	doc.bases = snap.bases;
	doc.starts = snap.starts;
	selected = snap.selected ? { ...snap.selected } : null;
	sym_mode = snap.sym_mode;
	sym_parity = { ...snap.sym_parity };
	edit_gen = snap.gen;
	update_sym_ui();
	rebuild_offscreen();
	render_props();
	refresh_hover_status();
	update_counts();
	refresh_dirty(); /* undoing back to the saved state makes the doc clean */
	request_draw();
}
/* Undo/redo/delete can fire mid-gesture (menu accelerators and the
 * Delete key work while a button is held); ending the gesture first
 * keeps a live drag or stroke from acting on stale indices into the
 * restored/filtered lists. */
function undo() {
	if (!undo_stack.length) return;
	end_gesture();
	redo_stack.push(snapshot());
	restore(undo_stack.pop());
}
function redo() {
	if (!redo_stack.length) return;
	end_gesture();
	undo_stack.push(snapshot());
	restore(redo_stack.pop());
}

/* ---------- helpers ---------- */
function in_region(x, y) {
	return x >= RGN_LO && x < RGN_HI && y >= RGN_LO && y < RGN_HI;
}
function clamp_region(v) {
	return Math.max(RGN_LO, Math.min(RGN_HI - 1, v));
}
/* edit_gen names the current document state: snapshots carry it and
 * restore() brings it back, which is what lets undo/redo recognise the
 * exact state a save wrote (no close prompt after undoing back to it).
 * It also lets an async save tell whether the document it serialized is
 * still the one that exists when the write finishes (edits are possible
 * while the save dialog / disk I/O is open).
 *
 * New ids come from gen_counter, which never decreases even when restore()
 * winds edit_gen back — otherwise edit A, edit B, save, undo, edit C would
 * mint C the saved state's id and pass A+C off as the saved A+B. */
let edit_gen = 0;
let gen_counter = 0; /* high-water mark of ids ever minted */
let last_saved_gen = 0; /* gen of the state the file on disk holds */
function refresh_dirty() {
	dirty = (edit_gen !== last_saved_gen);
	api.set_dirty(dirty);
	update_title();
}
function set_dirty(d) {
	if (d) edit_gen = ++gen_counter;
	else last_saved_gen = edit_gen; /* current state becomes the on-disk baseline */
	refresh_dirty();
}
function update_title() {
	let name = file_path ? file_path.replace(/^.*[\\/]/, "") : "untitled.map";
	document.title = `${name}${dirty ? " •" : ""}`;
}
/* Transient messages live in their own div (#statusMessage), which always
 * holds the last message; showing it temporarily swaps out the info row
 * (the mouse-coordinate div stays put). The timer only toggles visibility,
 * never content. */
let status_msg_timer = null;
function status_msg(text, hold_ms = 2500) {
	status_message.textContent = text;
	status_bar.classList.add("msg");
	clearTimeout(status_msg_timer);
	status_msg_timer = setTimeout(() => status_bar.classList.remove("msg"), hold_ms);
}

function update_counts() {
	counts_el.textContent =
		`pillboxes ${doc.pills.length}/16 · bases ${doc.bases.length}/16 · spawns ${doc.starts.length}/16`;
}

/* ---------- drawing ---------- */
let draw_queued = false;
function request_draw() {
	if (draw_queued) return;
	draw_queued = true;
	requestAnimationFrame(() => { draw_queued = false; draw(); });
}

function screen_to_tile(mx, my) {
	return {
		x: Math.floor(view.ox + mx / view.zoom),
		y: Math.floor(view.oy + my / view.zoom),
	};
}
function tile_to_screen_x(tx) { return (tx - view.ox) * view.zoom; }
function tile_to_screen_y(ty) { return (ty - view.oy) * view.zoom; }

function css_size() {
	return { w: canvas.clientWidth, h: canvas.clientHeight };
}

function clamp_view() {
	let { w, h } = css_size();
	let tw = w / view.zoom, th = h / view.zoom;
	let margin = 16;
	view.ox = Math.max(-tw + margin, Math.min(MAP_SIZE - margin, view.ox));
	view.oy = Math.max(-th + margin, Math.min(MAP_SIZE - margin, view.oy));
}

function draw() {
	let { w, h } = css_size();
	let z = view.zoom;
	ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
	ctx.fillStyle = "#0a0e16";
	ctx.fillRect(0, 0, w, h);

	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);

	/* darken the strip WinBolo won't save (outside 21..235) */
	let rx0 = tile_to_screen_x(RGN_LO), ry0 = tile_to_screen_y(RGN_LO);
	let rx1 = tile_to_screen_x(RGN_HI), ry1 = tile_to_screen_y(RGN_HI);
	ctx.fillStyle = "rgba(0,0,0,0.4)";
	let mx0 = tile_to_screen_x(0), my0 = tile_to_screen_y(0);
	let mx1 = tile_to_screen_x(MAP_SIZE), my1 = tile_to_screen_y(MAP_SIZE);
	ctx.fillRect(mx0, my0, mx1 - mx0, Math.max(0, ry0 - my0));            /* top */
	ctx.fillRect(mx0, ry1, mx1 - mx0, Math.max(0, my1 - ry1));            /* bottom */
	ctx.fillRect(mx0, ry0, Math.max(0, rx0 - mx0), ry1 - ry0);            /* left */
	ctx.fillRect(rx1, ry0, Math.max(0, mx1 - rx1), ry1 - ry0);            /* right */
	ctx.strokeStyle = "rgba(255,120,120,0.5)";
	ctx.lineWidth = 1;
	ctx.strokeRect(rx0 + 0.5, ry0 + 0.5, rx1 - rx0 - 1, ry1 - ry0 - 1);

	/* visible tile range */
	let tx0 = Math.max(0, Math.floor(view.ox));
	let ty0 = Math.max(0, Math.floor(view.oy));
	let tx1 = Math.min(MAP_SIZE, Math.ceil(view.ox + w / z));
	let ty1 = Math.min(MAP_SIZE, Math.ceil(view.oy + h / z));

	/* mine dots — the sole mine indicator, so drawn at every zoom */
	{
		let r = Math.max(0.5, z * 0.28);
		ctx.fillStyle = "#ff3b30";
		ctx.strokeStyle = "#7a0000";
		for (let ty = ty0; ty < ty1; ty++) {
			for (let tx = tx0; tx < tx1; tx++) {
				let t = doc.grid[ty * MAP_SIZE + tx];
				if (t >= 10 && t <= 15) {
					let cx = tile_to_screen_x(tx) + z / 2, cy = tile_to_screen_y(ty) + z / 2;
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
		ctx.strokeStyle = "rgba(255,255,255,0.07)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let tx = tx0; tx <= tx1; tx++) {
			let sx = Math.round(tile_to_screen_x(tx)) + 0.5;
			ctx.moveTo(sx, tile_to_screen_y(ty0));
			ctx.lineTo(sx, tile_to_screen_y(ty1));
		}
		for (let ty = ty0; ty <= ty1; ty++) {
			let sy = Math.round(tile_to_screen_y(ty)) + 0.5;
			ctx.moveTo(tile_to_screen_x(tx0), sy);
			ctx.lineTo(tile_to_screen_x(tx1), sy);
		}
		ctx.stroke();
	}

	/* pillbox range rings, under the object icons */
	if (show_pill_range) {
		ctx.strokeStyle = "rgba(255,59,48,0.3)";
		ctx.lineWidth = 1.5;
		for (let p of doc.pills) {
			ctx.beginPath();
			ctx.arc(tile_to_screen_x(p.x) + z / 2, tile_to_screen_y(p.y) + z / 2, PILL_RANGE * z, 0, Math.PI * 2);
			ctx.stroke();
		}
	}

	/* objects */
	let icon_r = Math.max(4, z * 0.45);
	let font = `${Math.max(8, Math.round(z * 0.6))}px sans-serif`;
	for (let [i, b] of doc.bases.entries()) {
		draw_object("base", i, b, icon_r);
	}
	for (let [i, p] of doc.pills.entries()) {
		draw_object("pill", i, p, icon_r);
	}
	for (let [i, s] of doc.starts.entries()) {
		draw_object("start", i, s, icon_r);
	}
	/* labels in a second pass so no object can be drawn over them */
	for (let [i, b] of doc.bases.entries()) {
		draw_object_label(i, b, icon_r, font);
	}
	for (let [i, p] of doc.pills.entries()) {
		draw_object_label(i, p, icon_r, font);
	}
	for (let [i, s] of doc.starts.entries()) {
		draw_object_label(i, s, icon_r, font);
	}

	/* symmetry axes / centre marker: through the middle of tile 128 for an
	 * odd axis, on the 127|128 tile boundary for an even one */
	if (sym_mode) {
		let ax = tile_to_screen_x(sym_parity.x === "even" ? 128 : 128.5);
		let ay = tile_to_screen_y(sym_parity.y === "even" ? 128 : 128.5);
		ctx.strokeStyle = "rgba(110,190,255,0.6)";
		ctx.lineWidth = 1;
		ctx.setLineDash([5, 5]);
		if (sym_mode === "h" || sym_mode === "quad") {
			ctx.beginPath();
			ctx.moveTo(ax, my0);
			ctx.lineTo(ax, my1);
			ctx.stroke();
		}
		if (sym_mode === "v" || sym_mode === "quad") {
			ctx.beginPath();
			ctx.moveTo(mx0, ay);
			ctx.lineTo(mx1, ay);
			ctx.stroke();
		}
		if (sym_mode === "rot180" || sym_mode === "rot90") {
			ctx.beginPath();
			ctx.arc(ax, ay, Math.max(9, z * 0.75), 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = "rgba(110,190,255,0.6)";
			ctx.beginPath();
			ctx.arc(ax, ay, 2, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.setLineDash([]);
	}
}

function draw_object(type, index, o, r) {
	let z = view.zoom;
	let cx = tile_to_screen_x(o.x) + z / 2;
	let cy = tile_to_screen_y(o.y) + z / 2;
	let is_sel = selected && selected.type === type && selected.index === index;
	ctx.lineWidth = 1.5;
	if (type === "pill") {
		ctx.fillStyle = "#e33";
		ctx.strokeStyle = "#600";
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	} else if (type === "base") {
		ctx.fillStyle = "#f0b429";
		ctx.strokeStyle = "#7a5200";
		if (bases_as_circles) {
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		} else {
			ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
			ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
		}
	} else {
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = "#333";
		/* File format: 0 = east, counter-clockwise (startsConvertDir in starts.c).
		 * Canvas rotation is clockwise-from-north, so mirror: (4 - dir) mod 16. */
		let ang = (((4 - o.dir) & 15) / 16) * Math.PI * 2;
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
	if (is_sel) {
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 2;
		ctx.strokeRect(cx - r - 3, cy - r - 3, (r + 3) * 2, (r + 3) * 2);
	}
}

function draw_object_label(index, o, r, font) {
	if (view.zoom < 10) return;
	let z = view.zoom;
	let cx = tile_to_screen_x(o.x) + z / 2;
	let cy = tile_to_screen_y(o.y) + z / 2;
	ctx.fillStyle = "#fff";
	ctx.font = font;
	ctx.textAlign = "center";
	ctx.fillText(String(index + 1), cx, cy - r - 3);
}

/* ---------- editing ---------- */
function set_cell(x, y, t) {
	if (!in_region(x, y)) return false;
	/* spawn points must sit on deep sea */
	if (t !== DEEP_SEA && object_at("start", x, y) >= 0) return false;
	let i = y * MAP_SIZE + x;
	if (doc.grid[i] === t) return false;
	doc.grid[i] = t;
	update_off_pixel(x, y);
	return true;
}

/* set_cell across the whole symmetry orbit of (x,y). Off-region images are
 * rejected by set_cell like any other cell (and with symmetry on, an image
 * of an in-region cell is always in-region: the saved region maps onto
 * itself under every mode). */
function set_cell_sym(x, y, t) {
	let changed = false;
	for (let m of sym_orbit(x, y)) changed = set_cell(m.x, m.y, t) || changed;
	return changed;
}

function paint_brush(x, y, t) {
	let o = Math.floor((brush_size - 1) / 2);
	let changed = false;
	for (let dy = 0; dy < brush_size; dy++) {
		for (let dx = 0; dx < brush_size; dx++) {
			changed = set_cell_sym(x - o + dx, y - o + dy, t) || changed;
		}
	}
	return changed;
}

function paint_line(x0, y0, x1, y1, t) {
	let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
	let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
	let err = dx - dy, changed = false;
	for (;;) {
		changed = paint_brush(x0, y0, t) || changed;
		if (x0 === x1 && y0 === y1) break;
		let e2 = 2 * err;
		if (e2 > -dy) { err -= dy; x0 += sx; }
		if (e2 < dx) { err += dx; y0 += sy; }
	}
	return changed;
}

function flood_fill(x, y, t) {
	if (!in_region(x, y)) return false;
	let target = doc.grid[y * MAP_SIZE + x];
	if (target === t) return false;
	let stack = [[x, y]];
	let visited = new Uint8Array(MAP_SIZE * MAP_SIZE);
	let filled = [];
	let changed = false;
	while (stack.length) {
		let [cx, cy] = stack.pop();
		if (!in_region(cx, cy)) continue;
		let i = cy * MAP_SIZE + cx;
		if (visited[i] || doc.grid[i] !== target) continue;
		visited[i] = 1;
		/* fill flows past spawn points but leaves their deep sea untouched */
		if (t === DEEP_SEA || object_at("start", cx, cy) < 0) {
			doc.grid[i] = t;
			filled.push(i);
			changed = true;
		}
		stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
	}
	/* Replicate to the symmetry images only after the traversal: painting
	 * them mid-flood would cut off a fill region that straddles an axis.
	 * Direct grid writes (set_cell's rules, minus the per-pixel offscreen
	 * update) keep giant fills from doing thousands of 1px blits. */
	if (sym_mode) {
		for (let i of filled) {
			for (let m of sym_orbit(i & 0xff, i >> 8)) {
				if (!in_region(m.x, m.y)) continue;
				if (t !== DEEP_SEA && object_at("start", m.x, m.y) >= 0) continue;
				let j = m.y * MAP_SIZE + m.x;
				if (doc.grid[j] !== t) { doc.grid[j] = t; changed = true; }
			}
		}
	}
	if (changed) rebuild_offscreen();
	return changed;
}

/* Direction (file convention: 0=E, counter-clockwise, 16 steps) from (x,y)
 * toward the centre of mass of land; empty map falls back to map centre. */
function spawn_dir_toward(x, y) {
	let sx = 0, sy = 0, n = 0;
	for (let ty = 0; ty < MAP_SIZE; ty++) {
		for (let tx = 0; tx < MAP_SIZE; tx++) {
			if (doc.grid[ty * MAP_SIZE + tx] !== DEEP_SEA) { sx += tx; sy += ty; n++; }
		}
	}
	let cx = n ? sx / n : 128, cy = n ? sy / n : 128;
	/* map y grows southward, so negate dy for a 0=east counter-clockwise angle */
	let ang = Math.atan2(-(cy - y), cx - x);
	return ((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16;
}

function object_at(type, x, y) {
	return doc[OBJECT_LIST[type]].findIndex(o => o.x === x && o.y === y);
}

/* First object of any type on this tile, as {type, index}, else null. */
function object_at_any_type(x, y) {
	for (let type of Object.keys(OBJECT_LIST)) {
		let index = object_at(type, x, y);
		if (index >= 0) return { type, index };
	}
	return null;
}

function delete_selected() {
	if (!selected) return;
	end_gesture(); /* a live drag would hold a stale index after the filter */
	let { type } = selected;
	let list_name = OBJECT_LIST[type];
	let list = doc[list_name];
	let o = list[selected.index];
	if (!o) { selected = null; return; }
	push_undo();
	/* Symmetry: any same-type objects on the mirror tiles go too. Tolerant
	 * by design — mirrors that don't exist (or were moved off their tile)
	 * are simply skipped, so this also works on hand-edited layouts. */
	let doomed = new Set([selected.index]);
	for (let m of sym_orbit(o.x, o.y).slice(1)) {
		let idx = object_at(type, m.x, m.y);
		if (idx >= 0) doomed.add(idx);
	}
	doc[list_name] = list.filter((_, i) => !doomed.has(i));
	selected = null;
	set_dirty(true);
	update_counts();
	render_props();
	request_draw();
	if (doomed.size > 1) {
		status_msg(`deleted ${doomed.size} mirrored ${OBJECT_LABEL_PLURAL[type]}`);
	}
}

/* Is any object (of any type) on this tile, other than the excluded one? */
function tile_occupied(x, y, excl_type, excl_index) {
	for (let type of Object.keys(OBJECT_LIST)) {
		let idx = object_at(type, x, y);
		if (idx >= 0 && !(type === excl_type && idx === excl_index)) return true;
	}
	return false;
}

/* ---------- symmetry ---------- */
function sym_orbit(x, y) {
	return BoloSym.orbit(sym_mode, sym_parity, x, y);
}

/* Best-effort recentring when symmetry is switched on: shift everything
 * so the content straddles the centre cell (128,128). Bounds come from
 * BoloSym.content_box — terrain, pills and bases, but NOT spawns — so the
 * axes land exactly where load-time detection would put them; symmetry
 * never looks at spawns, and they must not get a vote on the axes
 * either. Content inside the saved region stays inside it (the centred
 * box can't overhang, because the region itself is centred on 128).
 * The caller owns the undo entry — its snapshot must be taken before
 * the mode/parity change that led here. */
function centre_content(bounds_override) {
	let b = bounds_override || BoloSym.content_box(doc);
	if (!b) return false;
	let { dx, dy } = BoloSym.centre_shift(b, sym_parity);
	if (!dx && !dy) return false;
	let ng = new Uint8Array(MAP_SIZE * MAP_SIZE);
	ng.fill(DEEP_SEA);
	for (let y = 0; y < MAP_SIZE; y++) {
		let ny = y + dy;
		if (ny < 0 || ny >= MAP_SIZE) continue;
		for (let x = 0; x < MAP_SIZE; x++) {
			let v = doc.grid[y * MAP_SIZE + x];
			if (v === DEEP_SEA) continue;
			let nx = x + dx;
			if (nx >= 0 && nx < MAP_SIZE) ng[ny * MAP_SIZE + nx] = v;
		}
	}
	doc.grid = ng;
	/* Shifted objects that leave the saved region are deleted, not
	 * clamped: clamping breaks the translation's rigidity, which can
	 * stack spawns or strand them on occupied or non-sea tiles. On a
	 * well-formed map only spawns are exposed — they are excluded from
	 * the symmetry bounds, so a fringe spawn can fall off the edge when
	 * the map shifts. The caller's undo entry restores them. */
	let dropped = { starts: 0, others: 0 };
	let sel_obj = selected ? doc[OBJECT_LIST[selected.type]][selected.index] : null;
	for (let [type, list_name] of Object.entries(OBJECT_LIST)) {
		let kept = [];
		for (let o of doc[list_name]) {
			if (in_region(o.x + dx, o.y + dy)) {
				o.x += dx;
				o.y += dy;
				kept.push(o);
			} else {
				dropped[type === "start" ? "starts" : "others"]++;
			}
		}
		doc[list_name] = kept;
	}
	if (sel_obj) {
		let idx = doc[OBJECT_LIST[selected.type]].indexOf(sel_obj);
		selected = idx >= 0 ? { type: selected.type, index: idx } : null;
	}
	rebuild_offscreen();
	set_dirty(true);
	render_props();
	refresh_hover_status();
	update_counts();
	return { dropped };
}

/* Status-message suffix for a centre_content result. */
function recentre_note(moved) {
	if (!moved) return "";
	let note = " — map recentred";
	let bits = [];
	if (moved.dropped.starts) {
		bits.push(`${moved.dropped.starts} spawn${moved.dropped.starts === 1 ? "" : "s"}`);
	}
	if (moved.dropped.others) {
		bits.push(`${moved.dropped.others} other object${moved.dropped.others === 1 ? "" : "s"}`);
	}
	if (bits.length) note += `, ${bits.join(" and ")} dropped off the edge`;
	return note;
}

function update_sym_ui() {
	document.querySelectorAll("button.sym").forEach(b =>
		b.classList.toggle("active", b.dataset.sym === (sym_mode || "off")));
	document.querySelectorAll("button.sympar").forEach(b => {
		b.disabled = !sym_mode;
		b.classList.toggle("active", !!sym_mode &&
			sym_parity.x === b.dataset.parity && sym_parity.y === b.dataset.parity);
	});
	let parity_note = sym_parity.x === sym_parity.y
		? sym_parity.x
		: `${sym_parity.x} x, ${sym_parity.y} y`;
	status_sym.textContent = sym_mode
		? `symmetry: ${BoloSym.MODES[sym_mode].label} (${parity_note} axis)`
		: "";
}

/* Same-type objects sitting on the grabbed object's mirror tiles at
 * gesture start, each remembering its transform so it can follow the
 * primary. Matched by position only — nothing is paired persistently,
 * so hand-edited layouts just yield fewer (or no) followers. */
function capture_drag_mirrors(type, index) {
	let o = doc[OBJECT_LIST[type]][index];
	let tf = BoloSym.transforms(sym_mode, sym_parity);
	let mirrors = [];
	let taken = new Set([index]);
	for (let k = 1; k < tf.length; k++) {
		let [mx, my] = tf[k].pos(o.x, o.y);
		let idx = object_at(type, mx, my);
		if (idx >= 0 && !taken.has(idx)) {
			taken.add(idx);
			mirrors.push({ index: idx, k });
		}
	}
	return mirrors;
}

/* Move the dragged object so it lands on (tx, ty), then let its captured
 * mirrors follow, each evaluated one at a time under the normal placement
 * rules — a mirror whose destination is blocked simply stays behind.
 * Deliberately no cleverness: dragging the primary onto one of its own
 * mirrors is an ordinary "tile occupied" refusal, not a swap. */
function drag_object_to(tx, ty) {
	if (!obj_drag) return false;
	let list = doc[OBJECT_LIST[obj_drag.type]];
	let o = list[obj_drag.index];
	let nx = clamp_region(tx), ny = clamp_region(ty);
	if (obj_drag.type === "start" && doc.grid[ny * MAP_SIZE + nx] !== DEEP_SEA) {
		status_msg("spawn points must be on deep sea");
		return false;
	}
	if (tile_occupied(nx, ny, obj_drag.type, obj_drag.index)) {
		status_msg("tile already occupied by another object");
		return false;
	}
	if (!o || (o.x === nx && o.y === ny)) return false;
	if (!obj_drag.undo_pushed) { push_undo(); obj_drag.undo_pushed = true; }
	o.x = nx; o.y = ny;
	let tf = BoloSym.transforms(sym_mode, sym_parity);
	for (let m of obj_drag.mirrors || []) {
		let mo = list[m.index];
		if (!mo || !tf[m.k]) continue;
		let [mx, my] = tf[m.k].pos(nx, ny);
		if (!in_region(mx, my)) continue; /* even-axis far edge has no image */
		if (obj_drag.type === "start" && doc.grid[my * MAP_SIZE + mx] !== DEEP_SEA) continue;
		if (tile_occupied(mx, my, obj_drag.type, m.index)) continue;
		mo.x = mx; mo.y = my;
	}
	set_dirty(true);
	render_props();
	request_draw();
	return true;
}

function set_symmetry(mode, quiet) {
	if (mode === sym_mode) return;
	let snap = snapshot(); /* pre-change, in case entering recentres */
	sym_mode = mode;
	if (mode) {
		/* Every mode click re-derives the axis parity from the content and
		 * recentres, exactly as if entering from off — a manual odd/even
		 * override only lasts for the mode it was made in. Spawn-blind
		 * bounds, so this always agrees with load-time detection. */
		let b = BoloSym.content_box(doc);
		sym_parity = b ? BoloSym.auto_parity(b) : { x: "odd", y: "odd" };
		/* a quarter-turn has a single centre: both axes must share a parity */
		if (mode === "rot90" && sym_parity.x !== sym_parity.y) {
			sym_parity = { x: sym_parity.x, y: sym_parity.x };
		}
		update_sym_ui();
		let moved = centre_content();
		if (moved) push_undo_entry(snap);
		if (!quiet) {
			let note = sym_parity.x === sym_parity.y
				? `${sym_parity.x} axis`
				: `mixed axis (${sym_parity.x} x, ${sym_parity.y} y)`;
			status_msg(`symmetry on: ${BoloSym.MODES[mode].label}, ${note}${recentre_note(moved)}`);
		}
	} else {
		update_sym_ui();
		if (!quiet) status_msg("symmetry off");
	}
	request_draw();
}

/* On load: if the map is already perfectly symmetric (spawns and the
 * tiles under objects excused), switch the matching mode on. The map's
 * own axes may sit anywhere; recentring moves them onto the board's
 * standard axes — as one undoable step, only when a shift is needed,
 * so an already-centred file loads clean. */
function auto_detect_symmetry() {
	let found = BoloSym.detect(doc);
	if (!found) return;
	let snap = snapshot(); /* pre-change: symmetry still off here */
	sym_mode = found.mode;
	sym_parity = found.parity;
	update_sym_ui();
	let moved = centre_content(found.bounds);
	if (moved) push_undo_entry(snap);
	let except = found.spawns_symmetric ? "" : " (except spawns)";
	status_msg(`this map is ${BoloSym.MODES[found.mode].label} symmetric${except} — symmetry mode on${recentre_note(moved)}`, 4000);
	request_draw();
}

/* On demand: how far is this map from perfect symmetry? Reports the
 * minimum-edit count for the best mode, plus every mode's own score. */
function cmd_symmetry_score() {
	let s = BoloSym.score(doc);
	if (!s) {
		status_msg("empty map — nothing to score");
		return;
	}
	let label = m => BoloSym.MODES[m].label;
	let parts = Object.keys(BoloSym.MODES).map(m => `${label(m)} ${s.per_mode[m]}`).join(" · ");
	let except = s.spawns_symmetric ? "" : " (except spawns)";
	let head = s.flaws === 0
		? `symmetry flaws: 0 — perfectly ${label(s.mode)} symmetric${except}`
		: `symmetry flaws: ${s.flaws} (closest: ${label(s.mode)})`;
	status_msg(`${head} — ${parts}`, 6000);
}

/* On demand: locate one concrete flaw — a tile the best mode would
 * edit — and name it in the status bar. */
function cmd_find_flaw() {
	let s = BoloSym.find_flaw(doc);
	if (!s) {
		status_msg("empty map — nothing to check");
		return;
	}
	let label = BoloSym.MODES[s.mode].label;
	if (s.flaws === 0) {
		let except = s.spawns_symmetric ? "" : " (except spawns)";
		status_msg(`no flaws — perfectly ${label} symmetric${except}`, 5000);
		return;
	}
	if (!s.flaw) {
		status_msg(`${s.flaws} flaw${s.flaws === 1 ? "" : "s"} counted but none located — please report this`, 6000);
		return;
	}
	let f = s.flaw;
	let noun = { terrain: "terrain", pill: "pillbox", base: "base" }[f.kind];
	let what = f.kind === "terrain"
		? "terrain differs from its mirror image"
		: (f.missing ? `${noun} missing here` : `${noun} with no mirror image`);
	status_msg(`asymmetric tile (${f.x}, ${f.y}): ${what} — judging as ${label}`, 6000);
}

/* On demand: report every pillbox speed value in use. */
function cmd_pill_speeds() {
	if (doc.pills.length === 0) {
		status_msg("no pillboxes on the map");
		return;
	}
	let counts = new Map();
	for (let p of doc.pills) counts.set(p.speed, (counts.get(p.speed) || 0) + 1);
	if (counts.size === 1) {
		let [speed] = counts.keys();
		status_msg(`all ${doc.pills.length} pillboxes have speed ${speed}`, 5000);
		return;
	}
	let parts = [...counts.entries()]
		.sort(([va, ca], [vb, cb]) => cb - ca || vb - va)
		.map(([v, c]) => `${v} (${c})`)
		.join(", ");
	status_msg(`speeds: ${parts}`, 6000);
}

/* Manual axis-parity override (sets both axes; recentres to match). */
function set_parity(p) {
	if (!sym_mode) return;
	if (sym_parity.x === p && sym_parity.y === p) return;
	let snap = snapshot(); /* pre-change, in case the new axis recentres */
	sym_parity = { x: p, y: p };
	update_sym_ui();
	let moved = centre_content();
	if (moved) push_undo_entry(snap);
	status_msg(`symmetry axis: ${p === "odd" ? "through tile 128" : "between tiles 127 and 128"}${recentre_note(moved)}`);
	request_draw();
}

/* ---------- properties panel ---------- */
function render_props() {
	props_el.textContent = "";
	if (!selected) {
		let hint = document.createElement("span");
		hint.className = "hint";
		let b = document.createElement("b");
		b.textContent = "Right-click";
		hint.appendChild(b);
		hint.appendChild(document.createTextNode(" an object to select or drag it."));
		props_el.appendChild(hint);
		return;
	}
	let list = doc[OBJECT_LIST[selected.type]];
	let o = list[selected.index];
	if (!o) { selected = null; return render_props(); }

	let h = document.createElement("h3");
	h.textContent = `${OBJECT_LABEL[selected.type]} #${selected.index + 1} at (${o.x}, ${o.y})`;
	props_el.appendChild(h);

	if (selected.type === "pill" || selected.type === "base") {
		let row = document.createElement("div");
		row.className = "row";
		let label = document.createElement("span");
		label.textContent = "terrain under";
		let val = document.createElement("span");
		val.textContent = TERRAIN_NAMES[doc.grid[o.y * MAP_SIZE + o.x]];
		row.appendChild(label);
		row.appendChild(val);
		props_el.appendChild(row);
	}

	/* Dormant: pill/base stat editors. We deliberately don't expose these
	 * knobs — non-default values loaded from disk survive saves untouched,
	 * and the reset fixes in the menu normalize them on request. Only the
	 * spawn's dir stays editable. To revive, iterate
	 * OBJECT_FIELDS[selected.type] unconditionally. */
	let fields = selected.type === "start" ? OBJECT_FIELDS[selected.type] : [];
	for (let [field, min, max] of fields) {
		let row = document.createElement("label");
		row.className = "row";
		let span = document.createElement("span");
		span.textContent = field === "owner" ? "owner (255=neutral)"
										 : field === "dir" ? "dir (0=E, counter-cw)"
										 : field;
		let input = document.createElement("input");
		input.type = "number";
		input.min = min; input.max = max; input.value = o[field];
		input.addEventListener("change", () => {
			let v = Math.round(Number(input.value));
			if (!Number.isFinite(v)) v = o[field];
			v = Math.max(min, Math.min(max, v));
			input.value = v;
			/* Symmetry: a committed direction carries to the spawns on the mirror
			 * tiles, each turned by its own transform. Tolerant like
			 * delete_selected — mirrors that don't exist (or were moved off their
			 * tile) are simply skipped. Only pairs that actually change are
			 * collected, so a re-commit of the same value stays a no-op while a
			 * commit that only fixes stale mirrors still counts as an edit. */
			let mirrors = [];
			if (selected.type === "start" && field === "dir") {
				for (let m of sym_orbit(o.x, o.y).slice(1)) {
					let idx = object_at("start", m.x, m.y);
					if (idx < 0 || idx === selected.index) continue;
					let mo = doc.starts[idx];
					let md = m.dir(v);
					if (mo.dir !== md) mirrors.push({ o: mo, dir: md });
				}
			}
			if (o[field] === v && !mirrors.length) return;
			push_undo();
			o[field] = v;
			for (let m of mirrors) m.o.dir = m.dir;
			set_dirty(true);
			request_draw();
			if (mirrors.length) {
				status_msg(`direction mirrored to ${mirrors.length} spawn point${mirrors.length === 1 ? "" : "s"}`);
			}
		});
		row.appendChild(span);
		row.appendChild(input);
		props_el.appendChild(row);
	}

	let del = document.createElement("button");
	del.textContent = "Delete";
	del.addEventListener("click", delete_selected);
	props_el.appendChild(del);
}

/* ---------- palette / tools UI ---------- */
function build_palette() {
	let pal = document.getElementById("palette");
	let order = [7, 5, 4, 2, 0, 8, 6, 3, 9, 1, 255, null,
								 15, 13, 12, 10, null, null, 14, 11];
								 /* nulls: mined building / mined shot building don't exist */
	for (let t of order) {
		if (t === null) { /* spacer separating regular and mined terrain */
			let gap = document.createElement("div");
			gap.className = "swatch blank";
			pal.appendChild(gap);
			continue;
		}
		let sw = document.createElement("div");
		sw.className = "swatch" + (t === terrain ? " active" : "");
		let [r, g, b] = RGB[t];
		sw.style.background = `rgb(${r},${g},${b})`;
		sw.dataset.terrain = t;
		sw.title = TERRAIN_NAMES[t];
		sw.textContent = TERRAIN_NAMES[t];
		if (t >= 10 && t <= 15) {
			let dot = document.createElement("div");
			dot.className = "minedot";
			sw.appendChild(dot);
		}
		sw.addEventListener("click", () => {
			terrain = t;
			document.querySelectorAll(".swatch").forEach(el => el.classList.remove("active"));
			sw.classList.add("active");
			if (tool !== "paint" && tool !== "fill") set_tool("paint");
		});
		pal.appendChild(sw);
	}
}

function set_tool(t) {
	tool = t;
	document.querySelectorAll("button.tool").forEach(b =>
		b.classList.toggle("active", b.dataset.tool === t));
}
document.querySelectorAll("button.tool").forEach(b =>
	b.addEventListener("click", () => set_tool(b.dataset.tool)));
document.querySelectorAll("button.sym").forEach(b =>
	b.addEventListener("click", () =>
		set_symmetry(b.dataset.sym === "off" ? null : b.dataset.sym)));
document.querySelectorAll("button.sympar").forEach(b =>
	b.addEventListener("click", () => set_parity(b.dataset.parity)));
document.getElementById("brushSize").addEventListener("change", e => {
	brush_size = Number(e.target.value);
});

/* ---------- mouse input ---------- */
let painting = false;
let paint_terrain = 7;
let last_tile = null;
/* Pre-stroke snapshot, pushed onto the undo stack only once the stroke
 * actually changes a cell (mirrors included), so no-op clicks leave the
 * undo and redo stacks alone. */
let paint_snap = null;
let panning = false;
let pan_start = null;
let space_down = false;
let obj_drag = null; /* {type, index, undo_pushed} */

canvas.addEventListener("contextmenu", e => e.preventDefault());

function update_hover_status(t) {
	let in_map = t.x >= 0 && t.x < MAP_SIZE && t.y >= 0 && t.y < MAP_SIZE;
	status_pos.textContent = in_map ? `${t.x}, ${t.y}` : "";
	status_terrain.textContent = in_map
		? TERRAIN_NAMES[doc.grid[t.y * MAP_SIZE + t.x]] + (in_region(t.x, t.y) ? "" : " (outside saved area)")
		: "";
}

/* Re-check the tile under the last known mouse position, for changes
 * that alter the map without the mouse moving (undo/redo, menu fixes). */
let last_mouse = null;
function refresh_hover_status() {
	if (last_mouse) update_hover_status(screen_to_tile(last_mouse.mx, last_mouse.my));
}

canvas.addEventListener("pointerdown", e => {
	canvas.setPointerCapture(e.pointerId);
	last_mouse = { mx: e.offsetX, my: e.offsetY };
	let t = screen_to_tile(e.offsetX, e.offsetY);

	if (e.button === 1 || (e.button === 0 && space_down)) {
		panning = true;
		pan_start = { mx: e.offsetX, my: e.offsetY, ox: view.ox, oy: view.oy };
		canvas.style.cursor = "grabbing";
		return;
	}

	/* Right-click: select the object under the cursor (whatever the tool)
	 * and allow dragging it; an empty tile clears the selection.
	 * Delete/Backspace removes the selected object. */
	if (e.button === 2) {
		selected = object_at_any_type(t.x, t.y);
		obj_drag = selected
			? { ...selected, undo_pushed: false, mirrors: capture_drag_mirrors(selected.type, selected.index) }
			: null;
		render_props();
		request_draw();
		return;
	}

	if (tool === "paint" && e.button === 0) {
		painting = true;
		paint_terrain = terrain;
		last_tile = t;
		paint_snap = snapshot();
		if (paint_brush(t.x, t.y, paint_terrain)) {
			push_undo_entry(paint_snap);
			paint_snap = null;
			set_dirty(true);
		}
		request_draw();
	} else if (tool === "fill" && e.button === 0) {
		let snap = snapshot();
		if (flood_fill(t.x, t.y, terrain)) {
			push_undo_entry(snap);
			set_dirty(true);
			if (selected) render_props();
		}
		request_draw();
	} else if (tool === "pill" || tool === "base" || tool === "start") {
		let list_name = OBJECT_LIST[tool];
		if (e.button === 0) {
			/* placement only: manipulating existing objects is right-click's job */
			if (object_at_any_type(t.x, t.y)) {
				status_msg("tile already occupied — right-click to select or drag");
				return;
			}
			if (in_region(t.x, t.y)) {
				if (tool === "start" && doc.grid[t.y * MAP_SIZE + t.x] !== DEEP_SEA) {
					status_msg("spawn points must be on deep sea");
					return;
				}
				let orbit = sym_orbit(t.x, t.y);
				if (doc[list_name].length + orbit.length > 16) {
					status_msg(orbit.length > 1
						? `no room for ${orbit.length} mirrored ${OBJECT_LABEL_PLURAL[tool]} — nothing placed`
						: `max 16 ${OBJECT_LABEL_PLURAL[tool]} reached`);
					return;
				}
				/* all-or-nothing: any bad mirror position vetoes the placement */
				for (let m of orbit.slice(1)) {
					if (!in_region(m.x, m.y)) {
						/* only reachable with an even axis, whose far edge has no image */
						status_msg(`mirrored tile (${m.x}, ${m.y}) is outside the saved area — nothing placed`);
						return;
					}
					if (object_at_any_type(m.x, m.y)) {
						status_msg(`mirrored tile (${m.x}, ${m.y}) already occupied — nothing placed`);
						return;
					}
					if (tool === "start" && doc.grid[m.y * MAP_SIZE + m.x] !== DEEP_SEA) {
						status_msg(`mirrored tile (${m.x}, ${m.y}) is not deep sea — nothing placed`);
						return;
					}
				}
				push_undo();
				let base_dir = tool === "start" ? spawn_dir_toward(t.x, t.y) : 0;
				for (let m of orbit) {
					let o = { x: m.x, y: m.y, ...OBJECT_DEFAULTS[tool] };
					if (tool === "start") o.dir = m.dir(base_dir);
					doc[list_name].push(o);
				}
				selected = { type: tool, index: doc[list_name].length - orbit.length };
				/* the just-placed copies become drag followers, so a continued
				 * drag keeps the whole set symmetric */
				obj_drag = { type: tool, index: selected.index, undo_pushed: true,
										mirrors: capture_drag_mirrors(tool, selected.index) };
				set_dirty(true);
				update_counts();
			}
			render_props();
			request_draw();
		}
	}

	update_hover_status(t); /* clicks change the tile without moving the mouse */
});

canvas.addEventListener("pointermove", e => {
	last_mouse = { mx: e.offsetX, my: e.offsetY };
	let t = screen_to_tile(e.offsetX, e.offsetY);

	if (panning && pan_start) {
		view.ox = pan_start.ox - (e.offsetX - pan_start.mx) / view.zoom;
		view.oy = pan_start.oy - (e.offsetY - pan_start.my) / view.zoom;
		clamp_view();
		request_draw();
	} else if (painting && last_tile) {
		if (t.x !== last_tile.x || t.y !== last_tile.y) {
			if (paint_line(last_tile.x, last_tile.y, t.x, t.y, paint_terrain)) {
				if (paint_snap) {
					push_undo_entry(paint_snap);
					paint_snap = null;
				}
				set_dirty(true);
			}
			last_tile = t;
			request_draw();
		}
	} else if (obj_drag) {
		drag_object_to(t.x, t.y);
	}

	update_hover_status(t);
});

/* Idempotent: also reached via pointercancel / lostpointercapture / blur,
 * so a gesture can't stay live after the OS or a focus change eats the
 * pointerup (which would let bare hover keep painting or dragging). */
function end_gesture() {
	if (painting && selected) render_props(); /* refresh "terrain under" readout */
	painting = false;
	last_tile = null;
	paint_snap = null;
	panning = false;
	pan_start = null;
	obj_drag = null;
	canvas.style.cursor = space_down ? "grab" : "crosshair";
}
canvas.addEventListener("pointerup", end_gesture);
canvas.addEventListener("pointercancel", end_gesture);
canvas.addEventListener("lostpointercapture", end_gesture);
window.addEventListener("blur", () => {
	space_down = false; /* the matching keyup will never arrive */
	end_gesture();
});

canvas.addEventListener("wheel", e => {
	e.preventDefault();
	let idx = ZOOMS.indexOf(view.zoom);
	let nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + (e.deltaY < 0 ? 1 : -1)));
	zoom_to(ZOOMS[nidx], e.offsetX, e.offsetY);
}, { passive: false });

function zoom_to(z, mx, my) {
	if (z === view.zoom) return;
	let { w, h } = css_size();
	if (mx === undefined) { mx = w / 2; my = h / 2; }
	let tx = view.ox + mx / view.zoom;
	let ty = view.oy + my / view.zoom;
	view.zoom = z;
	view.ox = tx - mx / z;
	view.oy = ty - my / z;
	clamp_view();
	status_zoom.textContent = `zoom ${z}×`;
	request_draw();
}

function zoom_step(delta) {
	let idx = ZOOMS.indexOf(view.zoom);
	let nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + delta));
	zoom_to(ZOOMS[nidx]);
}

function zoom_fit() {
	let { w, h } = css_size();
	let z = ZOOMS[0];
	for (let c of ZOOMS) if (c * MAP_SIZE <= Math.min(w, h)) z = c;
	view.zoom = z;
	view.ox = 128 - w / (2 * z);
	view.oy = 128 - h / (2 * z);
	status_zoom.textContent = `zoom ${z}×`;
	request_draw();
}

window.addEventListener("keydown", e => {
	if (e.code === "Space" && !e.repeat && document.activeElement.tagName !== "INPUT") {
		space_down = true;
		canvas.style.cursor = "grab";
		e.preventDefault();
	}
	if (e.code === "Escape") {
		selected = null;
		render_props();
		request_draw();
	}
	if ((e.code === "Delete" || e.code === "Backspace") &&
			selected && document.activeElement.tagName !== "INPUT") {
		delete_selected();
		e.preventDefault();
	}
});
window.addEventListener("keyup", e => {
	if (e.code === "Space") {
		space_down = false;
		if (!panning) canvas.style.cursor = "crosshair";
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
	let n = cost.length, m = cost[0].length;
	let u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
	let p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		let minv = new Array(m + 1).fill(Infinity);
		let used = new Array(m + 1).fill(false);
		do {
			used[j0] = true;
			let i0 = p[j0];
			let delta = Infinity, j1 = -1;
			for (let j = 1; j <= m; j++) {
				if (used[j]) continue;
				let cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
				if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
				if (minv[j] < delta) { delta = minv[j]; j1 = j; }
			}
			for (let j = 0; j <= m; j++) {
				if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
				else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do { let j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
	}
	let assign = new Array(n);
	for (let j = 1; j <= m; j++) if (p[j] > 0) assign[p[j] - 1] = j - 1;
	return assign;
}

/* Reorder a list so index order matches the given grid slots intuitively:
 * percentile-rank positions, squared-distance cost, optimal assignment. */
function status_grid_order(list, slots) {
	let n = list.length;
	let idx = [...list.keys()];
	let by_x = idx.slice().sort((a, b) => list[a].x - list[b].x || list[a].y - list[b].y);
	let by_y = idx.slice().sort((a, b) => list[a].y - list[b].y || list[a].x - list[b].x);
	let rx = new Array(n), ry = new Array(n);
	by_x.forEach((i, r) => { rx[i] = r; });
	by_y.forEach((i, r) => { ry[i] = r; });
	let span = Math.max(1, n - 1);
	let gw = Math.max(...slots.map(s => s[0])); /* grid extents for rank scaling */
	let gh = Math.max(...slots.map(s => s[1]));
	let cost = list.map((o, i) => slots.map(([sx, sy]) => {
		let dx = (gw * rx[i]) / span - sx;
		let dy = (gh * ry[i]) / span - sy;
		return dx * dx + dy * dy;
	}));
	let assign = hungarian(cost);
	return idx.sort((a, b) => assign[a] - assign[b]).map(i => list[i]);
}

/* Each cmd_* fix supports quiet mode: no undo/status/redraw (the caller
 * batches those), and returns whether anything changed. */
function cmd_fix_order(list_name, label, slots, quiet) {
	let list = doc[list_name];
	if (list.length < 2) return false;
	let reordered = status_grid_order(list, slots);
	if (reordered.every((o, i) => o === list[i])) {
		if (!quiet) status_msg(`${label} already in status-grid order`);
		return false;
	}
	if (!quiet) push_undo();
	/* the selection follows its object to the object's new index */
	if (selected && OBJECT_LIST[selected.type] === list_name) {
		selected.index = reordered.indexOf(list[selected.index]);
	}
	doc[list_name] = reordered;
	if (!quiet) {
		set_dirty(true);
		render_props();
		request_draw();
		status_msg(`${label} reordered to match status grid`);
	}
	return true;
}

/* Re-aim every spawn at the land centre of mass (as placement does). */
function cmd_fix_spawn_dirs(quiet) {
	if (!doc.starts.length) return false;
	let new_dirs = doc.starts.map(s => spawn_dir_toward(s.x, s.y));
	if (new_dirs.every((d, i) => d === doc.starts[i].dir)) {
		if (!quiet) status_msg("spawn directions already correct");
		return false;
	}
	if (!quiet) push_undo();
	new_dirs.forEach((d, i) => { doc.starts[i].dir = d; });
	if (!quiet) {
		set_dirty(true);
		render_props();
		request_draw();
		status_msg("spawn directions re-aimed at land centre");
	}
	return true;
}

/* Reset all objects of a type to neutral ownership and default stats. */
function cmd_reset_objects(type, label, quiet, overrides) {
	let list = doc[OBJECT_LIST[type]];
	let defaults = { ...OBJECT_DEFAULTS[type], ...overrides };
	if (!list.length) return false;
	if (list.every(o => Object.entries(defaults).every(([k, v]) => o[k] === v))) {
		if (!quiet) status_msg(`${label} already at defaults`);
		return false;
	}
	if (!quiet) push_undo();
	for (let o of list) Object.assign(o, defaults);
	if (!quiet) {
		set_dirty(true);
		render_props();
		request_draw();
		status_msg(`${label} reset to neutral defaults`);
	}
	return true;
}

/* Convert every deep sea tile that touches land (orthogonally or
 * diagonally) to river, giving coastlines a shallow-water buffer.
 * Neighbours are read via get_pos so tiles outside the saved region
 * count as deep sea, matching what the file will actually contain.
 * Tiles under spawn points are skipped: spawns require deep sea. */
function cmd_buffer_sea(quiet) {
	const RIVER = 1;
	let is_water = t => t === DEEP_SEA || t === RIVER || t === 9; /* 9 = boat */
	let to_convert = [];
	for (let y = RGN_LO; y < RGN_HI; y++) {
		for (let x = RGN_LO; x < RGN_HI; x++) {
			if (doc.grid[y * MAP_SIZE + x] !== DEEP_SEA) continue;
			if (object_at("start", x, y) >= 0) continue;
			let touches_land = false;
			for (let dy = -1; dy <= 1 && !touches_land; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if ((dx || dy) && !is_water(BoloMap.get_pos(doc.grid, x + dx, y + dy))) {
						touches_land = true;
						break;
					}
				}
			}
			if (touches_land) to_convert.push(y * MAP_SIZE + x);
		}
	}
	if (!to_convert.length) {
		if (!quiet) status_msg("sea already buffered");
		return false;
	}
	if (!quiet) push_undo();
	for (let i of to_convert) doc.grid[i] = RIVER;
	rebuild_offscreen();
	if (!quiet) {
		set_dirty(true);
		render_props();
		refresh_hover_status();
		request_draw();
		status_msg(`buffered the sea: ${to_convert.length} tile${to_convert.length === 1 ? "" : "s"} converted to river`);
	}
	return true;
}

/* Run every fix as one undoable step. */
function cmd_apply_all_fixes(pill_overrides) {
	let snap = snapshot();
	let changed = [
		cmd_fix_order("pills", "pillboxes", STATUS_SLOTS, true),
		cmd_fix_order("bases", "bases", STATUS_SLOTS, true),
		cmd_fix_order("starts", "spawns", SPAWN_SLOTS, true),
		cmd_fix_spawn_dirs(true),
		cmd_reset_objects("pill", "pillboxes", true, pill_overrides),
		cmd_reset_objects("base", "bases", true),
	].filter(Boolean).length;
	if (!changed) {
		status_msg("no fixes needed");
		return;
	}
	push_undo_entry(snap);
	set_dirty(true);
	render_props();
	request_draw();
	status_msg(`applied ${changed} fix${changed === 1 ? "" : "es"}`);
}

/* ---------- file operations ---------- */
function load_doc(map, path) {
	/* Like undo/redo: a load can land mid-gesture (menu accelerators fire
	 * while a button is held, and a drop resolves whenever it resolves), so
	 * end the gesture first — otherwise a live stroke or drag carries on
	 * into the fresh document, painting it or moving objects the user never
	 * grabbed, through indices that now mean something else. Before the
	 * swap, so the gesture unwinds against the document it belonged to. */
	end_gesture();
	doc = map;
	file_path = path;
	selected = null;
	set_symmetry(null, true); /* a fresh document starts unsymmetric */
	undo_stack.length = 0;
	redo_stack.length = 0;
	rebuild_offscreen();
	render_props();
	update_counts();
	set_dirty(false);
	auto_detect_symmetry(); /* may re-dirty the doc if it recentres */
	zoom_fit();
}

/* A props-field value still being typed is only committed by its change
 * event (Enter or blur), which a menu accelerator doesn't trigger — so
 * anything that serializes or discards the doc must force the commit
 * first. Blurring the field fires its change handler synchronously. */
function commit_pending_edit() {
	let el = document.activeElement;
	if (el && el.tagName === "INPUT" && props_el.contains(el)) el.blur();
}

/* Never window.confirm()/alert() here: Chromium's blocking dialogs break
 * keyboard focus in Electron (inputs stop accepting typing until the
 * window is refocused), so all prompts go through main's native dialogs. */
async function confirm_discard() {
	commit_pending_edit(); /* an uncommitted edit must count as dirty here */
	if (!dirty) return true;
	return api.confirm_discard();
}

/* Document-level commands — New, Open, drop, Save, the close prompt — all
 * await native dialogs and disk I/O, so two can be in flight at once. Rather
 * than let them race and reconcile afterwards, only one runs at a time: a
 * command that arrives while one is live is refused, so the operation
 * already underway wins. That single invariant is what lets a save assume
 * the document can't be swapped out from under it (load_doc is only reached
 * through gated commands), and lets a load assume no other load will land
 * on top of its result.
 *
 * Edits are deliberately NOT gated. The renderer keeps handling input while
 * main writes the file, so a stroke can still land between serializing the
 * bytes and the write completing — that is what edit_gen is for. */
let file_op_done = null; /* resolves when the in-flight command finishes */

async function file_op(fn) {
	if (file_op_done) {
		status_msg("a file operation is already in progress");
		return;
	}
	let release;
	file_op_done = new Promise(r => { release = r; });
	try {
		return await fn();
	} catch (err) {
		/* Command bodies show their own dialogs and aren't expected to
		 * throw; a rejection escaping one would otherwise vanish into the
		 * devtools console, the command silently doing nothing. */
		api.show_error("Unexpected error", String(err));
	} finally {
		file_op_done = null;
		release();
	}
}

/* Wait out an in-flight command instead of being refused. Looped, because
 * another command can claim the gate in the moment we resume. */
async function file_op_idle() {
	while (file_op_done) await file_op_done;
}

function cmd_new() {
	file_op(async () => {
		if (!await confirm_discard()) return;
		load_doc(BoloMap.new_map(), null);
	});
}

function load_from_bytes(data, path) {
	let map;
	try {
		map = BoloMap.parse_map(data); /* parse before swapping: a bad file loses nothing */
	} catch (err) {
		api.show_error("Could not read map", err.message);
		return;
	}
	load_doc(map, path);
}

function cmd_open() {
	file_op(async () => {
		if (!await confirm_discard()) return;
		let res = await api.open_map();
		if (res.canceled) {
			if (res.error) api.show_error("Could not open map", res.error);
			return;
		}
		load_from_bytes(res.data, res.path);
	});
}

/* map passed on the command line (sent by main once the page loads) */
api.on_load_map(({ path, data }) => file_op(() => load_from_bytes(data, path)));

/* saved settings, pushed by main on every page load; later menu toggles
 * arrive as menu-cmd and are mirrored into main's settings.json there */
api.on_settings(s => {
	show_pill_range = !!s.showPillRange;
	bases_as_circles = !!s.basesAsCircles;
	request_draw();
});

/* main defers a dirty-window close to us, for the same prompt as New/Open.
 * Not gated but waits for the gate: main has already cancelled the close by
 * the time it asks, so a refusal would make the window silently ignore the
 * X. Once the prompt is up it is window-modal, which keeps other commands
 * out for as long as it matters. */
api.on_confirm_close(async () => {
	await file_op_idle();
	if (await confirm_discard()) api.confirm_close();
});

/* drag & drop a .map anywhere onto the window */
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
	e.preventDefault();
	let file = e.dataTransfer.files[0]; /* read now: dataTransfer empties after the event */
	if (!file) return;
	file_op(async () => {
		if (file.size > MAX_MAP_BYTES) {
			api.show_error("Could not open map", `${file.name} is ${file.size} bytes, far larger than any Bolo map.`);
			return;
		}
		if (!await confirm_discard()) return;
		let data;
		try {
			data = new Uint8Array(await file.arrayBuffer());
		} catch (err) {
			/* the file can vanish between the drop and the read (removable
			 * media, a temp file cleaned up) — surface it like any open error */
			api.show_error("Could not open map", String(err));
			return;
		}
		let path = null;
		try { path = api.path_for_file(file) || null; } catch { /* keep null: Save will ask */ }
		load_from_bytes(data, path);
	});
});

function cmd_save(as) {
	file_op(async () => {
		commit_pending_edit(); /* must land in the bytes serialized below */
		let saved_gen = edit_gen;
		let bytes = BoloMap.serialize_map(doc);
		let res = await api.save_map(as ? null : file_path, bytes);
		if (res.canceled) {
			if (res.error) api.show_error("Could not save map", res.error);
			return;
		}
		file_path = res.path;
		/* The bytes just written hold the state at saved_gen. An edit made
		 * while the save was in flight isn't in them, so the document stays
		 * dirty — but undoing back to saved_gen's state makes it clean again,
		 * because the file really does match. refresh_dirty also picks up a
		 * Save As rename even when the doc stays dirty. */
		last_saved_gen = saved_gen;
		refresh_dirty();
	});
}

api.on_menu(cmd => {
	switch (cmd) {
		case "new": cmd_new(); break;
		case "open": cmd_open(); break;
		case "save": cmd_save(false); break;
		case "save-as": cmd_save(true); break;
		case "undo": undo(); break;
		case "redo": redo(); break;
		case "fix-base-order": cmd_fix_order("bases", "bases", STATUS_SLOTS); break;
		case "fix-pill-order": cmd_fix_order("pills", "pillboxes", STATUS_SLOTS); break;
		case "fix-start-order": cmd_fix_order("starts", "spawns", SPAWN_SLOTS); break;
		case "fix-start-dirs": cmd_fix_spawn_dirs(); break;
		case "reset-pills": cmd_reset_objects("pill", "pillboxes"); break;
		case "reset-pills-slow": cmd_reset_objects("pill", "pillboxes", false, { speed: 100 }); break;
		case "reset-bases": cmd_reset_objects("base", "bases"); break;
		case "buffer-sea": cmd_buffer_sea(); break;
		case "count-flaws": cmd_symmetry_score(); break;
		case "find-flaw": cmd_find_flaw(); break;
		case "pill-speeds": cmd_pill_speeds(); break;
		case "apply-all-fixes": cmd_apply_all_fixes(); break;
		case "apply-all-fixes-slow": cmd_apply_all_fixes({ speed: 100 }); break;
		case "toggle-pill-range": show_pill_range = !show_pill_range; request_draw(); break;
		case "toggle-base-circles": bases_as_circles = !bases_as_circles; request_draw(); break;
		case "zoom-in": zoom_step(1); break;
		case "zoom-out": zoom_step(-1); break;
		case "zoom-fit": zoom_fit(); break;
	}
});

/* ---------- boot ---------- */
function resize() {
	let w = canvas.clientWidth, h = canvas.clientHeight;
	canvas.width = Math.max(1, Math.round(w * devicePixelRatio));
	canvas.height = Math.max(1, Math.round(h * devicePixelRatio));
	/* Draw synchronously: setting width/height blanks the canvas, and the
	 * ResizeObserver callback runs before paint, so an immediate draw means
	 * the blank state is never presented (a deferred rAF draw would flicker). */
	draw();
}
new ResizeObserver(resize).observe(canvas);

build_palette();
rebuild_offscreen();
update_counts();
update_sym_ui();
render_props();
update_title();
status_zoom.textContent = `zoom ${view.zoom}×`;
resize();
zoom_fit();
