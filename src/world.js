'use strict';
// ───────────────────────── World: sectors, palettes, infinite procedural planet field ─────────────────────────
const WORLD = (() => {
  const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const SECTORS = [
    { name: 'NOCTURNE', key: 50, mode: 'lydian',
      base: ['#07061a', '#161336', '#2b2560', '#4d4596', '#8f86cf', '#ece6ff'],
      accA: ['#7a2446', '#f0645a', '#ffd29c'], accB: ['#1b4d6b', '#39b3c9', '#b8f3ff'], light: [-0.55, -0.5, 0.67] },
    { name: 'EMBER VEIL', key: 53, mode: 'mixolydian',
      base: ['#0c0605', '#26110d', '#4a2216', '#80401f', '#c7824a', '#fbe3b6'],
      accA: ['#6e1740', '#e8457e', '#ffc6de'], accB: ['#173d6e', '#3c8fe6', '#c4e6ff'], light: [0.6, -0.45, 0.66] },
    { name: 'VERDIGRIS', key: 48, mode: 'ionian',
      base: ['#030b0b', '#0b211f', '#16403a', '#2a6d5c', '#6fb391', '#e6f5cf'],
      accA: ['#7a2c12', '#f07b2c', '#ffe199'], accB: ['#4a2470', '#b06ee8', '#f0d9ff'], light: [-0.35, 0.6, 0.72] },
    { name: 'GLACIER', key: 52, mode: 'dorian',
      base: ['#02060d', '#0a1727', '#142f4f', '#285c88', '#6ea6cf', '#eef8ff'],
      accA: ['#781d3d', '#ff5c7c', '#ffd3de'], accB: ['#5c4610', '#e5b93e', '#fff3b5'], light: [-0.7, -0.2, 0.68] },
    { name: 'OLD LIGHT', key: 46, mode: 'aeolian',
      base: ['#0e0d08', '#27251a', '#4a472e', '#7f7b4e', '#bdb884', '#f3efc8'],
      accA: ['#6a1d1d', '#d9493c', '#ffc4a3'], accB: ['#1d4859', '#4aa3b6', '#caf3f3'], light: [0.5, 0.5, 0.7] },
    { name: 'ROSE NEBULA', key: 51, mode: 'lydian',
      base: ['#0d0510', '#24102b', '#43204d', '#723a78', '#b86fae', '#fbe0f0'],
      accA: ['#6b3a0e', '#f2a93b', '#fff0b8'], accB: ['#154d52', '#3fc2b0', '#c6fff0'], light: [-0.5, -0.6, 0.62] },
  ];
  SECTORS.forEach(s => {
    s.pBase = new Float32Array(s.base.flatMap(hex));
    s.pA = new Float32Array(s.accA.flatMap(hex));
    s.pB = new Float32Array(s.accB.flatMap(hex));
  });
  const SECTOR_LEN = 8000;

  // live palette (lerped between sectors)
  const pal = { base: new Float32Array(18), accA: new Float32Array(9), accB: new Float32Array(9), light: new Float32Array(3) };
  const palFrom = { base: new Float32Array(18), accA: new Float32Array(9), accB: new Float32Array(9), light: new Float32Array(3) };
  let palT = 1, palTo = SECTORS[0];
  function setPalette(s, instant) {
    palFrom.base.set(pal.base); palFrom.accA.set(pal.accA); palFrom.accB.set(pal.accB); palFrom.light.set(pal.light);
    palTo = s; palT = instant ? 1 : 0;
    if (instant) applyPal(1);
  }
  function applyPal(t) {
    const e = t * t * (3 - 2 * t);
    for (let i = 0; i < 18; i++) pal.base[i] = palFrom.base[i] + (palTo.pBase[i] - palFrom.base[i]) * e;
    for (let i = 0; i < 9; i++) {
      pal.accA[i] = palFrom.accA[i] + (palTo.pA[i] - palFrom.accA[i]) * e;
      pal.accB[i] = palFrom.accB[i] + (palTo.pB[i] - palFrom.accB[i]) * e;
    }
    for (let i = 0; i < 3; i++) pal.light[i] = palFrom.light[i] + (palTo.light[i] - palFrom.light[i]) * e;
    const l = Math.hypot(pal.light[0], pal.light[1], pal.light[2]) || 1;
    pal.light[0] /= l; pal.light[1] /= l; pal.light[2] /= l;
  }
  function updatePal(dt) { if (palT < 1) { palT = Math.min(1, palT + dt / 2.5); applyPal(palT); } }
  const sectorIndexAt = x => Math.max(0, Math.floor(x / SECTOR_LEN));
  const sectorFor = idx => SECTORS[idx % SECTORS.length];

  // ── deterministic hashing ──
  let seed = 1;
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cellRng(i, j) {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return mulberry(h ^ (h >>> 16));
  }

  // ── cells ──
  const CELL = 640;
  const cells = new Map();
  let bodyId = 0;
  const keyOf = (i, j) => (i + 32768) * 65536 + (j + 32768);

  function makeBody(x, y, r, type, s, rnd) {
    return {
      id: ++bodyId, x, y, r, type, seed: s, ring: 0, ringTilt: 0.28, ringRot: 0,
      spin: (rnd() * 0.5 + 0.12) * (rnd() < 0.3 ? -1 : 1), deg: 0, degSeed: rnd(),
      visited: false, moon: null, isMoon: false, host: null, orbitR: 0, orbitW: 0, orbitPh: 0, vx: 0, vy: 0,
    };
  }

  function genCell(i, j) {
    const rnd = cellRng(i, j);
    const cell = { i, j, planet: null, dust: null, alive: null, dustN: 0 };
    const x0 = i * CELL, y0 = j * CELL;
    const diff = Math.min(1, Math.max(0, x0 / 140000));
    let occ = 0.6 - 0.16 * diff;
    const forced = j === 0 && i >= 0 && i <= 2;
    if (i < 0 && Math.abs(j) < 3) occ = 0.35;
    if (forced || rnd() < occ) {
      let R = 34 + Math.pow(rnd(), 1.6) * (112 - 36 * diff);
      const tr = rnd();
      const type = tr < 0.34 ? 0 : tr < 0.58 ? 1 : tr < 0.72 ? 2 : tr < 0.84 ? 3 : 4;
      let ring = type === 0 && R > 70 && rnd() < 0.55;
      let moon = R > 64 && rnd() < 0.28 + 0.22 * diff;
      const moonR = 11 + rnd() * 9, orbitR = R * 1.8 + 34 + rnd() * 30;
      let margin = Math.max(R * (ring ? 2.15 : 1.3), moon ? orbitR + moonR + 8 : 0) + 26;
      if (margin > CELL / 2 - 12) { moon = false; margin = R * (ring ? 2.15 : 1.3) + 26; }
      if (margin > CELL / 2 - 12) { ring = false; margin = R * 1.3 + 26; }
      let x = x0 + margin + rnd() * (CELL - 2 * margin);
      let y = y0 + margin + rnd() * (CELL - 2 * margin);
      if (i === 0 && j === 0) { x = x0 + CELL / 2; y = y0 + CELL / 2; R = 92; }
      const p = makeBody(x, y, R, i === 0 && j === 0 ? 4 : type, rnd() * 10, rnd);
      p.ring = ring ? 1 : 0; p.ringTilt = 0.2 + rnd() * 0.18; p.ringRot = (rnd() - 0.5) * 0.7;
      if (moon && !(i === 0 && j === 0)) {
        const m = makeBody(x, y, moonR, rnd() < 0.7 ? 1 : 2, rnd() * 10, rnd);
        m.isMoon = true; m.host = p; m.orbitR = orbitR; m.orbitW = (0.25 + rnd() * 0.3) * (rnd() < 0.5 ? -1 : 1);
        m.orbitPh = rnd() * Math.PI * 2;
        p.moon = m;
      }
      cell.planet = p;
    }
    // stardust clusters
    const pr = cell.planet;
    if (rnd() < (pr ? 0.32 : 0.62)) {
      const n = 7 + Math.floor(rnd() * 7);
      const kind = rnd();
      const cx = x0 + 120 + rnd() * (CELL - 240), cy = y0 + 120 + rnd() * (CELL - 240);
      const ang = rnd() * Math.PI * 2, rad = 70 + rnd() * 90;
      const pts = [];
      for (let k = 0; k < n; k++) {
        const u = k / (n - 1);
        let px, py;
        if (kind < 0.4) { const a = ang + u * 2.4; px = cx + Math.cos(a) * rad; py = cy + Math.sin(a) * rad; }
        else if (kind < 0.7) { px = cx + Math.cos(ang) * (u - 0.5) * 300; py = cy + Math.sin(ang) * (u - 0.5) * 300 + Math.sin(u * 6.28) * 30; }
        else { const a = ang + u * 7; const rr = 20 + u * rad; px = cx + Math.cos(a) * rr; py = cy + Math.sin(a) * rr; }
        let ok = true;
        if (pr) {
          const clr = (pr.moon ? pr.moon.orbitR + 30 : pr.r * (pr.ring ? 2.2 : 1) + 26);
          if (Math.hypot(px - pr.x, py - pr.y) < Math.max(clr, pr.r + 30)) ok = false;
        }
        if (ok) pts.push(px, py);
      }
      if (pts.length) {
        cell.dust = new Float32Array(pts); cell.dustN = pts.length / 2;
        cell.alive = new Uint8Array(cell.dustN).fill(1);
      }
    }
    return cell;
  }

  function cell(i, j) {
    const k = keyOf(i, j);
    let c = cells.get(k);
    if (!c) { c = genCell(i, j); cells.set(k, c); }
    return c;
  }

  // gather bodies (planets + moons) and cells overlapping a rect
  const bodies = [], near = [];
  function gather(x0, y0, x1, y1, t) {
    bodies.length = 0; near.length = 0;
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL);
    const j0 = Math.floor(y0 / CELL), j1 = Math.floor(y1 / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const c = cell(i, j);
      near.push(c);
      const p = c.planet;
      if (p) {
        bodies.push(p);
        const m = p.moon;
        if (m) {
          const a = m.orbitPh + m.orbitW * t;
          m.x = p.x + Math.cos(a) * m.orbitR; m.y = p.y + Math.sin(a) * m.orbitR;
          m.vx = -Math.sin(a) * m.orbitR * m.orbitW; m.vy = Math.cos(a) * m.orbitR * m.orbitW;
          bodies.push(m);
        }
      }
    }
    return bodies;
  }
  function evict(cx, cy) {
    if (cells.size < 2600) return;
    const ci = Math.floor(cx / CELL), cj = Math.floor(cy / CELL);
    for (const [k, c] of cells) if (Math.abs(c.i - ci) > 16 || Math.abs(c.j - cj) > 16) cells.delete(k);
  }
  function reset(s) { seed = s | 0; cells.clear(); bodyId = 0; }

  return {
    SECTORS, SECTOR_LEN, CELL, pal, setPalette, updatePal, sectorIndexAt, sectorFor,
    gather, evict, reset, cell, bodies, near,
    get seed() { return seed; },
  };
})();
