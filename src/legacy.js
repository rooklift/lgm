/*
 * Importer for pre-0.99 Macintosh Bolo maps (circa 1993), which lived in a
 * "BMAP" resource in the file's resource fork rather than as BMAPBOLO data.
 * Reverse-engineered from ~185 surviving maps, validated against Bolo
 * 0.99's own built-in copy of Everard Island and 18 other maps that exist
 * in both formats.
 *
 * Container: the fork usually reaches us as AppleDouble (magic 00051607) or
 * AppleSingle (00051600), whose entry id 2 is the resource fork; a bare
 * resource fork (data offset 0x100) is also accepted. Standard resource
 * fork layout: header (data offset, map offset, lengths), each resource
 * as 4-byte length + data, and a map with a type list. We take the first
 * resource of type BMAP (the Bolo application itself carries two).
 *
 * Payload (always 3198 bytes): a struct dump, structure-of-arrays.
 *   0x000  base x[16]           0xf0 = unused slot
 *   0x010  base y[16]
 *   0x020  base owner[16]       0x10 = neutral
 *   0x030  base armour[16]      always 90, same as 0.99's defaults
 *   0x040  base shells[16]
 *   0x050  base mines[16]
 *   0x060  pill x[16]
 *   0x070  pill y[16]
 *   0x080  0xff
 *   0x090  pill owner[16]       0x0e or 0x10 = neutral; 0xff = unused slot
 *   0x0a0  0xff
 *   0x0b0  0xff
 *   0x1f0  terrain: 104 x 52 squares, row-major, 2 nibbles per byte, LOW
 *          nibble first, 2702 bytes = 5404 squares: the four corner
 *          squares are not stored, so the first and last rows hold 102
 *          squares and the 50 between hold 104. Nibble codes are
 *          identical to 0.99's (0 building ... 15 mined grass). There is
 *          no deep sea; water is river.
 * Pill/base coordinates are world coordinates offset (17, 10) from the
 * stored terrain's top-left. No map in the corpus has an owned pill or
 * base, and 0.99 conversions all carry default stats, so imports use the
 * editor's defaults. There are no start positions.
 *
 * The world is dropped where Bolo 0.99 puts it: top-left at (77, 102) in
 * the 256 x 256 map, deep sea around it and in the unstored corners.
 */
"use strict";
(function () {

const BoloMap = typeof module !== "undefined" && module.exports ? require("./format.js") : window.BoloMap;

const LEGACY_W = 104;
const LEGACY_H = 52;
const ROW_BYTES = LEGACY_W / 2;
const TERRAIN_OFFSET = 0x1f0;
const TERRAIN_SQUARES = LEGACY_W * LEGACY_H - 4;
const PAYLOAD_MIN = TERRAIN_OFFSET + TERRAIN_SQUARES / 2;
const COORD_OFFSET_X = 17;
const COORD_OFFSET_Y = 10;
const PLACE_X = 77;
const PLACE_Y = 102;

function u32(b, p) {
	if (p + 4 > b.length) throw new Error("Truncated resource fork");
	return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}
function u16(b, p) {
	if (p + 2 > b.length) throw new Error("Truncated resource fork");
	return (b[p] << 8) | b[p + 1];
}

/* AppleSingle / AppleDouble: returns the resource fork entry, or null if the
 * bytes are not such a container. */
function unwrap_apple(bytes) {
	if (bytes.length < 26) return null;
	let magic = u32(bytes, 0);
	if (magic !== 0x00051600 && magic !== 0x00051607) return null;
	let n = u16(bytes, 24);
	for (let i = 0; i < n; i++) {
		let e = 26 + i * 12;
		let id = u32(bytes, e), off = u32(bytes, e + 4), len = u32(bytes, e + 8);
		if (id === 2) {
			if (off + len > bytes.length) throw new Error("Resource fork entry runs past end of file");
			return bytes.subarray(off, off + len);
		}
	}
	throw new Error("AppleSingle/AppleDouble file has no resource fork");
}

function looks_like_resource_fork(bytes) {
	return bytes.length >= 16 && u32(bytes, 0) === 0x100 && u32(bytes, 4) + u32(bytes, 12) <= bytes.length;
}

/* Returns the data of the first resource of the given 4-char type, or null. */
function find_resource(fork, want_type) {
	let data_off = u32(fork, 0), map_off = u32(fork, 4);
	let type_list = map_off + u16(fork, map_off + 24);
	let n_types = (u16(fork, type_list) + 1) & 0xffff;
	for (let i = 0; i < n_types; i++) {
		let t = type_list + 2 + i * 8;
		let type = String.fromCharCode(fork[t], fork[t + 1], fork[t + 2], fork[t + 3]);
		if (type !== want_type) continue;
		let ref = type_list + u16(fork, t + 6); /* first reference entry */
		let off = data_off + (u32(fork, ref + 4) & 0xffffff);
		let len = u32(fork, off);
		if (off + 4 + len > fork.length) throw new Error("Resource data runs past end of fork");
		return fork.subarray(off + 4, off + 4 + len);
	}
	return null;
}

function parse_payload(p) {
	if (p.length < PAYLOAD_MIN) throw new Error(`BMAP resource too short (${p.length} bytes)`);

	let map = BoloMap.new_map();
	let grid = map.grid;
	let n = 0; /* nibble index: the squares are stored consecutively, corners skipped */
	for (let y = 0; y < LEGACY_H; y++) {
		for (let x = 0; x < LEGACY_W; x++) {
			let edge_row = y === 0 || y === LEGACY_H - 1;
			if (edge_row && (x === 0 || x === LEGACY_W - 1)) continue; /* unstored corner: stays deep sea */
			let b = p[TERRAIN_OFFSET + (n >> 1)];
			grid[(PLACE_Y + y) * BoloMap.MAP_SIZE + PLACE_X + x] = (n & 1) ? (b >> 4) : (b & 0x0f);
			n++;
		}
	}

	let place = (x, y) => ({ x: x - COORD_OFFSET_X + PLACE_X, y: y - COORD_OFFSET_Y + PLACE_Y });
	let in_world = (x, y) => x >= COORD_OFFSET_X && x < COORD_OFFSET_X + LEGACY_W && y >= COORD_OFFSET_Y && y < COORD_OFFSET_Y + LEGACY_H;

	for (let i = 0; i < 16; i++) {
		let x = p[0x60 + i], y = p[0x70 + i], o = p[0x90 + i];
		if (x === 0xf0 || o === 0xff || !in_world(x, y)) continue;
		map.pills.push({ ...place(x, y), owner: 16, armour: 15, speed: 100 });
	}
	for (let i = 0; i < 16; i++) {
		let x = p[i], y = p[0x10 + i], o = p[0x20 + i];
		if (x === 0xf0 || o === 0xff || !in_world(x, y)) continue;
		map.bases.push({ ...place(x, y), owner: 16, armour: 90, shells: 90, mines: 90 });
	}
	return map;
}

/* True if these bytes are worth handing to parse_legacy_map. */
function is_legacy_container(bytes) {
	try {
		return unwrap_apple(bytes) !== null || looks_like_resource_fork(bytes);
	} catch {
		return false;
	}
}

function parse_legacy_map(bytes) {
	let fork = unwrap_apple(bytes);
	if (!fork) {
		if (!looks_like_resource_fork(bytes)) throw new Error("Not a Bolo map (no BMAPBOLO header, and not a Mac resource fork)");
		fork = bytes;
	}
	let payload = find_resource(fork, "BMAP");
	if (!payload) throw new Error("Resource fork has no BMAP resource");
	return parse_payload(payload);
}

const BoloLegacy = { is_legacy_container, parse_legacy_map, LEGACY_W, LEGACY_H, PLACE_X, PLACE_Y };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloLegacy;
} else {
	window.BoloLegacy = BoloLegacy;
}

})();
