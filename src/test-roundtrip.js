/* Round-trip test: parse ../map_format/example.map, re-serialize, compare. */
'use strict';
const fs = require('fs');
const path = require('path');
const BoloMap = require('./format.js');

const file = process.argv[2] || path.join(__dirname, '..', 'map_format', 'example.map');
const orig = new Uint8Array(fs.readFileSync(file));

const map = BoloMap.parseMap(orig);
console.log(`parsed ${file}: ${map.pills.length} pills, ${map.bases.length} bases, ${map.starts.length} starts`);

let nonSea = 0;
for (const t of map.grid) if (t !== BoloMap.DEEP_SEA) nonSea++;
console.log(`non-sea squares: ${nonSea}`);

const out = BoloMap.serializeMap(map);
console.log(`re-serialized: ${out.length} bytes (original ${orig.length})`);

if (out.length === orig.length && out.every((b, i) => b === orig[i])) {
	console.log('BYTE-IDENTICAL round trip: PASS');
} else {
	let firstDiff = -1;
	for (let i = 0; i < Math.min(out.length, orig.length); i++) {
		if (out[i] !== orig[i]) { firstDiff = i; break; }
	}
	console.log(`byte round trip differs (first diff at offset ${firstDiff})`);
	/* Fall back to semantic comparison */
	const re = BoloMap.parseMap(out);
	const gridsEqual = re.grid.every((t, i) => t === map.grid[i]);
	const objsEqual = JSON.stringify([re.pills, re.bases, re.starts]) ===
										JSON.stringify([map.pills, map.bases, map.starts]);
	console.log(`semantic round trip (grid ${gridsEqual ? 'equal' : 'DIFFERS'}, objects ${objsEqual ? 'equal' : 'DIFFER'}): ${gridsEqual && objsEqual ? 'PASS' : 'FAIL'}`);
	process.exitCode = gridsEqual && objsEqual ? 0 : 1;
}
