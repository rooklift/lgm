/* Sprite test: every name the calc rules can produce exists on disk, and
 * name_for never returns an unknown sprite for any neighbourhood. */
"use strict";
const fs = require("fs");
const path = require("path");
const BoloSprites = require("./sprites.js");

const MAP_SIZE = 256;
const GRASS = 7, DEEP_SEA = 255;
let failures = 0;

function check(cond, msg) {
	if (!cond) {
		failures++;
		console.log(`FAIL: ${msg}`);
	}
}

/* Every declared sprite has its PNG, exactly once. */
let seen = new Set();
for (let name of BoloSprites.NAMES) {
	check(!seen.has(name), `duplicate sprite name ${name}`);
	seen.add(name);
	check(fs.existsSync(path.join(__dirname, "sprites", name + ".png")), `missing sprite file ${name}.png`);
}

/* And every PNG in sprites/ is declared (no dead files). */
for (let file of fs.readdirSync(path.join(__dirname, "sprites"))) {
	check(seen.has(file.replace(/\.png$/, "")), `undeclared sprite file ${file}`);
}

/* name_for stays inside NAMES for every centre terrain against every
 * combination of the neighbour values its rules react to. The centre
 * sits mid-map on grass, its 8 neighbours written per combination. */
let grid = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(GRASS);
const CX = 100, CY = 100;
const NEIGHBOURS = [
	[CX - 1, CY - 1], [CX, CY - 1], [CX + 1, CY - 1],
	[CX - 1, CY], [CX + 1, CY],
	[CX - 1, CY + 1], [CX, CY + 1], [CX + 1, CY + 1],
];

function try_all(centre, values) {
	grid[CY * MAP_SIZE + CX] = centre;
	let n = values.length;
	for (let combo = 0; combo < n ** 8; combo++) {
		let c = combo;
		for (let [x, y] of NEIGHBOURS) {
			grid[y * MAP_SIZE + x] = values[c % n];
			c = Math.floor(c / n);
		}
		let name = BoloSprites.name_for(grid, CX, CY);
		if (!seen.has(name)) {
			check(false, `centre ${centre} combo ${combo}: unknown sprite "${name}"`);
			break; /* one bad combo per centre is enough noise */
		}
	}
	for (let [x, y] of NEIGHBOURS) grid[y * MAP_SIZE + x] = GRASS;
}

try_all(0, [0, 8, GRASS]);                       /* building: 8-neighbour rules */
try_all(1, [1, 4, GRASS, DEEP_SEA]);             /* river */
try_all(4, [4, 1, GRASS, DEEP_SEA, 9]);          /* road, incl. water variants */
try_all(5, [5, GRASS]);                          /* forest */
try_all(9, [1, 4, GRASS, DEEP_SEA]);             /* boat */
try_all(DEEP_SEA, [DEEP_SEA, 1, GRASS, 9]);      /* deep sea shores */
for (let t of [2, 3, 6, 7, 8, 10, 11, 12, 13, 14, 15]) {
	try_all(t, [GRASS, DEEP_SEA]);                 /* singles and mined variants */
}

/* Mined terrain both displays as its base terrain (plus the overlay the
 * renderer draws) and counts as its base terrain when it is a neighbour. */
grid[CY * MAP_SIZE + CX] = 12; /* mined road */
grid[CY * MAP_SIZE + CX + 1] = 13; /* mined forest to the right */
let mined = BoloSprites.name_for(grid, CX, CY);
grid[CY * MAP_SIZE + CX] = 4;
grid[CY * MAP_SIZE + CX + 1] = 5;
check(mined === BoloSprites.name_for(grid, CX, CY), "mined road/forest not drawn as road/forest");
grid[CY * MAP_SIZE + CX] = GRASS;
grid[CY * MAP_SIZE + CX + 1] = GRASS;

/* Map corners: off-map neighbours count as deep sea, and never crash. */
for (let [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]]) {
	grid[y * MAP_SIZE + x] = 1; /* lone river against the void */
	check(seen.has(BoloSprites.name_for(grid, x, y)), `corner (${x},${y}) produced an unknown sprite`);
	grid[y * MAP_SIZE + x] = DEEP_SEA;
}

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("sprite tests passed");
