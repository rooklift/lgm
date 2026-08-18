/* Round-trip test: parse ../map_format/example.map, re-serialize, compare. */
"use strict";
const fs = require("fs");
const path = require("path");
const BoloMap = require("./format.js");

let file = process.argv[2] || path.join(__dirname, "..", "map_format", "example.map");
let orig = new Uint8Array(fs.readFileSync(file));

let map = BoloMap.parse_map(orig);
console.log(`parsed ${file}: ${map.pills.length} pills, ${map.bases.length} bases, ${map.starts.length} starts`);

let non_sea = 0;
for (let t of map.grid) if (t !== BoloMap.DEEP_SEA) non_sea++;
console.log(`non-sea squares: ${non_sea}`);

let out = BoloMap.serialize_map(map);
console.log(`re-serialized: ${out.length} bytes (original ${orig.length})`);

if (out.length === orig.length && out.every((b, i) => b === orig[i])) {
	console.log("BYTE-IDENTICAL round trip: PASS");
} else {
	let first_diff = -1;
	for (let i = 0; i < Math.min(out.length, orig.length); i++) {
		if (out[i] !== orig[i]) { first_diff = i; break; }
	}
	console.log(`byte round trip differs (first diff at offset ${first_diff})`);
	/* Fall back to semantic comparison */
	let re = BoloMap.parse_map(out);
	let grids_equal = re.grid.every((t, i) => t === map.grid[i]);
	/* serialize_map normalises WinBolo's neutral owner (16) to 0xff, so the
	 * original must be normalised the same way before comparing. */
	let norm = list => list.map(o => ({ ...o, owner: o.owner === 16 ? 255 : o.owner }));
	let objs_equal = JSON.stringify([re.pills, re.bases, re.starts]) ===
										JSON.stringify([norm(map.pills), norm(map.bases), map.starts]);
	console.log(`semantic round trip (grid ${grids_equal ? "equal" : "DIFFERS"}, objects ${objs_equal ? "equal" : "DIFFER"}): ${grids_equal && objs_equal ? "PASS" : "FAIL"}`);
	process.exitCode = grids_equal && objs_equal ? 0 : 1;
}
