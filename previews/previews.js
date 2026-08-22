"use strict";
/* Flip-book viewer: one map at a time, at sprite scale, centred on its land. */

const { MAP_SIZE, DEEP_SEA, EDGE_MIN, EDGE_MAX } = BoloMap;
const RGN_LO = EDGE_MIN + 1;   /* 21, inclusive */
const RGN_HI = EDGE_MAX;       /* 236, exclusive */

const ZOOM = BoloSprites.MIN_ZOOM; /* smallest zoom that draws real tile art */

/* same flat colours as the editor (renderer.js): the underlay until the
 * sprite atlas is ready, and whatever the atlas lacks */
const TERRAIN_COLORS = {
	0: "#8a6b4a", 1: "#3f7fe0", 2: "#6b7d3f", 3: "#5a5a66", 4: "#3a3a3a",
	5: "#58a848", 6: "#857a6a", 7: "#1e5c2e", 8: "#8c8c99", 9: "#a8c4ee", 255: "#123a6b",
};
const RGB = {};
for (let t of Object.keys(TERRAIN_COLORS)) {
	let c = parseInt(TERRAIN_COLORS[t].slice(1), 16);
	RGB[t] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
for (let t = 10; t <= 15; t++) RGB[t] = RGB[t - 8];

let entries = [];   /* {path, map, off, cx, cy} or {path, error} */
let index = 0;

/* pan, in tiles, relative to the current map's land centre — kept across
 * maps so successive maps are seen from the same place */
let pan = { x: 0, y: 0 };
let drag = null;

let canvas = document.getElementById("view");
let ctx = canvas.getContext("2d");
let header = document.getElementById("header");

function parse(data) {
	if (BoloLegacy.is_legacy_container(data)) return BoloLegacy.parse_legacy_map(data);
	return BoloMap.parse_map(data);
}

/* 1px-per-tile image of the terrain, scaled up at draw time */
function build_offscreen(map) {
	let off = document.createElement("canvas");
	off.width = off.height = MAP_SIZE;
	let octx = off.getContext("2d");
	let img = octx.createImageData(MAP_SIZE, MAP_SIZE);
	for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
		let [r, g, b] = RGB[map.grid[i]] || RGB[255];
		img.data[i * 4] = r;
		img.data[i * 4 + 1] = g;
		img.data[i * 4 + 2] = b;
		img.data[i * 4 + 3] = 255;
	}
	octx.putImageData(img, 0, 0);
	return off;
}

/* centre of the land's bounding box; the map centre if there is no land */
function land_centre(map) {
	let x0 = MAP_SIZE, y0 = MAP_SIZE, x1 = -1, y1 = -1;
	for (let y = 0; y < MAP_SIZE; y++) {
		for (let x = 0; x < MAP_SIZE; x++) {
			if (map.grid[y * MAP_SIZE + x] !== DEEP_SEA) {
				if (x < x0) x0 = x;
				if (y < y0) y0 = y;
				if (x > x1) x1 = x;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return { cx: MAP_SIZE / 2, cy: MAP_SIZE / 2 };
	return { cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}

function basename(p) {
	return p.split(/[\\/]/).pop();
}

function escape_html(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function set_header(e) {
	let line1 = `[${index + 1}/${entries.length}] <b>${escape_html(basename(e.path))}</b>`;
	if (e.error) {
		line1 += ` <span class="err">— ${escape_html(e.error)}</span>`;
	} else {
		line1 += ` &nbsp; pills ${e.map.pills.length} · bases ${e.map.bases.length} · spawns ${e.map.starts.length}`;
	}
	header.innerHTML = `${line1}<br><span class="path">${escape_html(e.path)}</span>`;
}

function draw() {
	let w = canvas.clientWidth, h = canvas.clientHeight;
	canvas.width = Math.round(w * devicePixelRatio);
	canvas.height = Math.round(h * devicePixelRatio);
	ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
	ctx.fillStyle = "#0a0e16";
	ctx.fillRect(0, 0, w, h);

	let e = entries[index];
	if (!e) { header.textContent = "No maps."; return; }
	set_header(e);
	if (e.error) return;

	let z = ZOOM;
	/* view origin in tiles: the land centre (plus pan) lands mid-canvas */
	let view = {
		zoom: z,
		ox: e.cx + pan.x - w / (2 * z),
		oy: e.cy + pan.y - h / (2 * z),
	};
	let sx = tx => (tx - view.ox) * z;
	let sy = ty => (ty - view.oy) * z;

	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(e.off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);
	let sprites_drawn = BoloSprites.draw_view(ctx, e.map.grid, view, w, h);

	/* region outline */
	ctx.strokeStyle = "rgba(255,120,120,0.5)";
	ctx.lineWidth = 1;
	ctx.strokeRect(sx(RGN_LO) + 0.5, sy(RGN_LO) + 0.5, (RGN_HI - RGN_LO) * z - 1, (RGN_HI - RGN_LO) * z - 1);

	/* mine dots, until the atlas supplies the real mine graphic */
	if (!sprites_drawn) {
		let mr = z * 0.28;
		ctx.fillStyle = "#ff3b30";
		for (let ty = 0; ty < MAP_SIZE; ty++) {
			for (let tx = 0; tx < MAP_SIZE; tx++) {
				let t = e.map.grid[ty * MAP_SIZE + tx];
				if (t >= 10 && t <= 15) {
					ctx.beginPath();
					ctx.arc(sx(tx) + z / 2, sy(ty) + z / 2, mr, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}

	/* objects */
	let r = z * 0.45;
	ctx.lineWidth = 1.5;
	let blob = (o, fill, stroke) => {
		ctx.fillStyle = fill;
		ctx.strokeStyle = stroke;
		ctx.beginPath();
		ctx.arc(sx(o.x) + z / 2, sy(o.y) + z / 2, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	};
	for (let b of e.map.bases) blob(b, "#f0b429", "#7a5200");
	for (let p of e.map.pills) blob(p, "#e33", "#600");
	ctx.fillStyle = "#fff";
	ctx.strokeStyle = "#333";
	for (let s of e.map.starts) {
		/* as in the editor: file dir 0 = east, counter-clockwise, but canvas
		 * rotation is clockwise-from-north, so mirror: (4 - dir) mod 16 */
		let ang = (((4 - s.dir) & 15) / 16) * Math.PI * 2;
		ctx.save();
		ctx.translate(sx(s.x) + z / 2, sy(s.y) + z / 2);
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
}

function go(i) {
	if (entries.length === 0) return;
	index = Math.max(0, Math.min(entries.length - 1, i));
	draw();
}

document.addEventListener("keydown", ev => {
	switch (ev.key) {
		case "ArrowRight": case "ArrowDown": go(index + 1); break;
		case "ArrowLeft": case "ArrowUp": go(index - 1); break;
		case "Home": go(0); break;
		case "End": go(entries.length - 1); break;
		case "c": case "C": pan = { x: 0, y: 0 }; draw(); break;
		default: return;
	}
	ev.preventDefault();
});

canvas.addEventListener("mousedown", ev => {
	drag = { mx: ev.clientX, my: ev.clientY, px: pan.x, py: pan.y };
});
window.addEventListener("mousemove", ev => {
	if (!drag) return;
	pan.x = drag.px - (ev.clientX - drag.mx) / ZOOM;
	pan.y = drag.py - (ev.clientY - drag.my) / ZOOM;
	draw();
});
window.addEventListener("mouseup", () => { drag = null; });

window.addEventListener("resize", draw);

BoloSprites.load(draw, "../src/sprites/");

api.on_maps(list => {
	entries = list.map(e => {
		if (!e.error) {
			try {
				e.map = parse(e.data);
				e.off = build_offscreen(e.map);
				Object.assign(e, land_centre(e.map));
			} catch (err) {
				e.error = err.message;
			}
		}
		delete e.data;
		return e;
	});
	go(0);
});
