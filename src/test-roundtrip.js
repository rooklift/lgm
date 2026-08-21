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
	/* parse_map normalises owners (anything above 15 loads as neutral 16),
	 * so both sides are already in the same form. */
	let objs_equal = JSON.stringify([re.pills, re.bases, re.starts]) ===
										JSON.stringify([map.pills, map.bases, map.starts]);
	console.log(`semantic round trip (grid ${grids_equal ? "equal" : "DIFFERS"}, objects ${objs_equal ? "equal" : "DIFFER"}): ${grids_equal && objs_equal ? "PASS" : "FAIL"}`);
	process.exitCode = grids_equal && objs_equal ? 0 : 1;
}

/* Internally owners are 0-16 with 16 = neutral: loading takes any value
 * above 15 (WinBolo's 16, the classic 0xff, junk) as 16, and saving
 * writes neutral back out as the classic 0xff. */
{
	let bytes = [];
	for (let i = 0; i < 8; i++) bytes.push("BMAPBOLO".charCodeAt(i));
	bytes.push(1, 2, 1, 0);                /* version, 2 pills, 1 base, 0 starts */
	bytes.push(100, 100, 16, 15, 50);      /* pill, WinBolo neutral 16 */
	bytes.push(102, 100, 200, 15, 50);     /* pill, junk owner 200 */
	bytes.push(110, 110, 255, 90, 90, 90); /* base, classic neutral 0xff */
	bytes.push(4, 0xff, 0xff, 0xff);       /* terminator run */
	let m = BoloMap.parse_map(Uint8Array.from(bytes));
	let loaded_ok = m.pills[0].owner === 16 && m.pills[1].owner === 16 && m.bases[0].owner === 16;
	let out = BoloMap.serialize_map(m);
	/* owner bytes: header is 12 bytes, pills 5 bytes each, then bases */
	let saved_ok = out[14] === 255 && out[19] === 255 && out[24] === 255;
	if (loaded_ok && saved_ok) {
		console.log("neutral owner normalisation (loads as 16, saves as 0xff): PASS");
	} else {
		console.log(`neutral owner normalisation FAIL (loaded ${m.pills[0].owner}/${m.pills[1].owner}/${m.bases[0].owner}, saved ${out[14]}/${out[19]}/${out[24]})`);
		process.exitCode = 1;
	}
}
