/* Symmetry test: group laws, saved-region closure, orbits, centring. */
'use strict';
const BoloSym = require('./sym.js');

const RGN_LO = 21, RGN_HI = 236; /* saved region, 21..235 inclusive */
let failures = 0;

function check(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${msg}`);
  }
}

const ODD = { x: 'odd', y: 'odd' };
const EVEN = { x: 'even', y: 'even' };
const pname = p => `${p.x}/${p.y}`;

/* Closure: an odd axis maps the whole saved region onto itself; an even
 * axis maps everything except the far edge (235), whose image is 20.
 * So the "mirrorable" region is 21..235 for odd, 21..234 for even. */
for (const parity of [ODD, EVEN]) {
  const hiX = parity.x === 'even' ? RGN_HI - 1 : RGN_HI;
  const hiY = parity.y === 'even' ? RGN_HI - 1 : RGN_HI;
  for (const mode of Object.keys(BoloSym.MODES)) {
    if (mode === 'rot90' && parity.x !== parity.y) continue;
    for (let y = RGN_LO; y < hiY; y += 7) {
      for (let x = RGN_LO; x < hiX; x += 7) {
        for (const t of BoloSym.transforms(mode, parity)) {
          const [ox, oy] = t.pos(x, y);
          check(ox >= RGN_LO && ox < hiX && oy >= RGN_LO && oy < hiY,
            `${mode} ${pname(parity)}: (${x},${y}) -> (${ox},${oy}) leaves the mirrorable region`);
        }
        /* orbit of any orbit member is the same set of cells */
        const base = BoloSym.orbit(mode, parity, x, y).map(m => `${m.x},${m.y}`).sort().join(' ');
        for (const m of BoloSym.orbit(mode, parity, x, y)) {
          const again = BoloSym.orbit(mode, parity, m.x, m.y).map(n => `${n.x},${n.y}`).sort().join(' ');
          check(again === base, `${mode} ${pname(parity)}: orbit of (${m.x},${m.y}) != orbit of (${x},${y})`);
        }
      }
    }
    /* pos and dir cycle back to the start together (group law) */
    for (const t of BoloSym.transforms(mode, parity)) {
      for (let d = 0; d < 16; d++) {
        let x = 60, y = 100, dd = d, steps = 0;
        do { [x, y] = t.pos(x, y); dd = t.dir(dd); steps++; } while ((x !== 60 || y !== 100) && steps < 8);
        check(steps <= 4, `${mode} ${pname(parity)}: pos does not cycle within 4 steps`);
        check(dd === d, `${mode} ${pname(parity)}: dir ${d} does not return after pos cycles (got ${dd})`);
      }
    }
  }
}

/* Mixed parity is legal for everything except rot90 (which the editor
 * never requests with mixed axes). */
for (const mode of ['h', 'v', 'quad', 'rot180']) {
  for (const tr of BoloSym.transforms(mode, { x: 'even', y: 'odd' })) {
    const [x1, y1] = tr.pos(60, 100);
    const [x2, y2] = tr.pos(x1, y1);
    check(x2 === 60 && y2 === 100, `${mode} mixed parity: transform does not cycle back at (60,100)`);
  }
}

/* Odd axis: cells on the axis are their own image. Even axis: no fixed
 * cells at all — even the "centre" tiles pair up. */
check(BoloSym.orbit('h', ODD, 128, 50).length === 1, 'h odd: axis cell should be its own image');
check(BoloSym.orbit('quad', ODD, 128, 50).length === 2, 'quad odd: axis cell should have a 2-orbit');
check(BoloSym.orbit('rot90', ODD, 128, 128).length === 1, 'rot90 odd: centre should be fixed');
check(BoloSym.orbit('h', EVEN, 128, 50).length === 2, 'h even: tile 128 mirrors to 127');
check(BoloSym.orbit('h', EVEN, 127, 50)[1].x === 128, 'h even: tile 127 mirrors to 128');
check(BoloSym.orbit('quad', EVEN, 127, 127).length === 4, 'quad even: no fixed cells');
check(BoloSym.orbit('rot90', EVEN, 127, 127).length === 4, 'rot90 even: no fixed cells');
check(BoloSym.orbit(null, ODD, 30, 40).length === 1, 'null mode should yield just the primary');

/* Direction spot checks (0 = east, counter-clockwise; north = 4).
 * orbit() lists transforms in a fixed order, primary (identity) first. */
const mx = BoloSym.orbit('h', ODD, 60, 100)[1];       /* mirror left-right */
check(mx.dir(0) === 8 && mx.dir(4) === 4 && mx.dir(12) === 12, 'MX dir: E->W, N->N, S->S');
const my = BoloSym.orbit('v', ODD, 60, 100)[1];       /* mirror top-bottom */
check(my.dir(0) === 0 && my.dir(4) === 12, 'MY dir: E->E, N->S');
const r1 = BoloSym.orbit('rot90', ODD, 60, 100)[1];   /* quarter turn, clockwise on screen */
check(r1.dir(0) === 12 && r1.dir(4) === 0, 'R1 dir: E->S, N->E');
check(r1.x === 256 - 100 && r1.y === 60, 'R1 pos odd: (60,100) -> (156,60)');
const r1e = BoloSym.orbit('rot90', EVEN, 60, 100)[1];
check(r1e.x === 255 - 100 && r1e.y === 60, 'R1 pos even: (60,100) -> (155,60)');
const r2 = BoloSym.orbit('rot180', ODD, 60, 100)[1];  /* half turn */
check(r2.dir(0) === 8 && r2.dir(4) === 12, 'R2 dir: E->W, N->S');

/* quad = MX then MY composes to the half turn, on pos and dir alike */
{
  const q = BoloSym.orbit('quad', ODD, 60, 100);
  check(q[3].x === 256 - 60 && q[3].y === 256 - 100, 'quad 4th member should be the half turn');
  for (let d = 0; d < 16; d++) {
    check(q[3].dir(d) === (d + 8) % 16, `quad: MX∘MY dir(${d}) should equal half turn`);
  }
}

/* Centring: a box whose parity matches the axis centres exactly; either
 * way a centred in-region box never overhangs the region. */
{
  let s = BoloSym.centreShift({ minX: 30, maxX: 40, minY: 200, maxY: 210 }, ODD);
  check((30 + 40) / 2 + s.dx === 128 && (200 + 210) / 2 + s.dy === 128,
    'odd box centres on tile 128 under an odd axis');
  s = BoloSym.centreShift({ minX: 30, maxX: 41, minY: 200, maxY: 211 }, EVEN);
  check((30 + 41) / 2 + s.dx === 127.5 && (200 + 211) / 2 + s.dy === 127.5,
    'even box centres on the 127|128 boundary under an even axis');
  s = BoloSym.centreShift({ minX: 30, maxX: 41, minY: 200, maxY: 210 }, { x: 'even', y: 'odd' });
  check((30 + 41) / 2 + s.dx === 127.5 && (200 + 210) / 2 + s.dy === 128,
    'mixed box centres exactly on each axis independently');
  s = BoloSym.centreShift({ minX: RGN_LO, maxX: RGN_HI - 1, minY: RGN_LO, maxY: RGN_HI - 1 }, ODD);
  check(s.dx === 0 && s.dy === 0, 'full-region box needs no shift');
  for (const parity of [ODD, EVEN]) {
    for (let minX = RGN_LO; minX < RGN_HI; minX += 3) {
      for (let maxX = minX; maxX < RGN_HI; maxX += 5) {
        const { dx } = BoloSym.centreShift({ minX, maxX, minY: minX, maxY: maxX }, parity);
        check(minX + dx >= RGN_LO && maxX + dx < RGN_HI,
          `centred box [${minX},${maxX}] overhangs the region (${pname(parity)}, dx=${dx})`);
      }
    }
  }
}

/* autoParity picks the parity that makes centring exact, per axis. */
{
  const p1 = BoloSym.autoParity({ minX: 30, maxX: 40, minY: 30, maxY: 41 });
  check(p1.x === 'odd' && p1.y === 'even', 'autoParity: 11-wide is odd, 12-tall is even');
  const p2 = BoloSym.autoParity({ minX: 100, maxX: 100, minY: 100, maxY: 100 });
  check(p2.x === 'odd' && p2.y === 'odd', 'autoParity: single cell is odd/odd');
}

/* detect(): auto symmetry detection on load. Judged about the content's
 * own axes; spawns invisible; object properties and under-object tiles
 * excused. */
{
  const blank = () => ({ grid: new Uint8Array(256 * 256).fill(0xff), pills: [], bases: [], starts: [] });
  const put = (m, x, y, t) => { m.grid[y * 256 + x] = t; };
  const P = (x, y) => ({ x, y, owner: 255, armour: 15, speed: 50 });

  let m = blank();
  [[100, 100], [156, 100], [128, 90]].forEach(([x, y]) => put(m, x, y, 7));
  let d = BoloSym.detect(m);
  check(d && d.mode === 'h' && d.parity.x === 'odd', 'detect: mirror-x about tile 128');

  m = blank();
  for (const x of [100, 101, 154, 155]) for (const y of [60, 61, 194, 195]) put(m, x, y, 7);
  d = BoloSym.detect(m);
  check(d && d.mode === 'quad' && d.parity.x === 'even' && d.parity.y === 'even',
    'detect: even-axis quad');

  m = blank();
  [[100, 100], [156, 156]].forEach(([x, y]) => put(m, x, y, 7));
  d = BoloSym.detect(m);
  check(d && d.mode === 'rot180', 'detect: half-turn only');

  m = blank();
  [[100, 110], [146, 100], [156, 146], [110, 156]].forEach(([x, y]) => put(m, x, y, 7));
  d = BoloSym.detect(m);
  check(d && d.mode === 'rot90', 'detect: quarter-turn orbit');

  m = blank();
  [[100, 100], [156, 100], [100, 156], [156, 156]].forEach(([x, y]) => put(m, x, y, 7));
  m.starts.push({ x: 50, y: 50, dir: 3 });
  d = BoloSym.detect(m);
  check(d && d.mode === 'quad', 'detect: spawns are ignored');

  m = blank();
  m.pills.push(P(100, 100), { ...P(156, 100), armour: 3, owner: 1 });
  put(m, 100, 100, 7);
  put(m, 156, 100, 4); /* different tile under the mirror pill */
  d = BoloSym.detect(m);
  check(!!d, 'detect: under-object tiles and properties ignored');

  m = blank();
  [[100, 100], [150, 90], [105, 95]].forEach(([x, y]) => put(m, x, y, 7));
  check(BoloSym.detect(m) === null, 'detect: asymmetric map yields null');

  m = blank();
  [[100, 100], [156, 100], [100, 156], [156, 156]].forEach(([x, y]) => put(m, x, y, 7));
  m.pills.push(P(110, 110));
  check(BoloSym.detect(m) === null, 'detect: lone unmirrored pill breaks every mode');
}

if (failures === 0) {
  console.log('symmetry tests: PASS');
} else {
  console.log(`symmetry tests: ${failures} FAILURE${failures === 1 ? '' : 'S'}`);
  process.exitCode = 1;
}
