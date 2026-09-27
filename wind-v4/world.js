'use strict';
// ───────────────────────── World data: wind, thermals, ridge lift, seed trails, clouds ─────────────────────────
const WORLD = (() => {
  const WIND = [4.0, 0, 1.8];
  const TC = 900, SC = 480, CC = 1600;
  const thermals = new Map(), seedCells = new Map(), cloudCells = new Map();
  const key = (i, j) => (i + 32768) * 65536 + (j + 32768);
  function rng(i, j, salt) {
    let a = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function thermal(i, j) {
    const k = key(i, j);
    let t = thermals.get(k);
    if (t !== undefined) return t;
    const r = rng(i, j, 1);
    t = null;
    if (r() < 0.5) {
      const x = (i + 0.15 + r() * 0.7) * TC, z = (j + 0.15 + r() * 0.7) * TC;
      const g = terrainH(x, z, 1);
      if (g > 4) {
        t = { x, z, r: 70 + r() * 50, w: 4.6 + r() * 3.2, ground: g, top: g + 460 + r() * 440, seed: r() };
        // a spiral of seeds rewards circling up
        const n = 12, s = new Float32Array(n * 3), ph = r() * 6.28;
        for (let q = 0; q < n; q++) {
          const a = ph + q * 0.9, rr = t.r * 0.55;
          s[q * 3] = x + Math.cos(a) * rr; s[q * 3 + 1] = g + 70 + q * 32; s[q * 3 + 2] = z + Math.sin(a) * rr;
        }
        t.seeds = { n, p: s, got: new Uint8Array(n) };
        // cumulus cap marks the thermal
        t.cloud = makeCloud(r, x, t.top + 30, z, 110 + r() * 120);
      }
    }
    thermals.set(k, t);
    return t;
  }

  function makeCloud(r, cx, base, cz, size) {
    const n = 6 + Math.floor(size / 28);
    const p = new Float32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const a = r() * 6.2832, d = Math.sqrt(r()) * size * 0.85;
      const pr = size * (0.3 + r() * 0.32) * (1.15 - d / size * 0.5);
      p[q * 6] = cx + Math.cos(a) * d;
      p[q * 6 + 1] = base + pr * 0.55 + r() * size * 0.55 * (1 - d / size);
      p[q * 6 + 2] = cz + Math.sin(a) * d * 0.75;
      p[q * 6 + 3] = pr;
      p[q * 6 + 4] = base;
      p[q * 6 + 5] = size;
    }
    return p;
  }
  function cloudCell(i, j) {
    const k = key(i, j);
    let c = cloudCells.get(k);
    if (c) return c;
    const r = rng(i, j, 3);
    c = [];
    const n = r() < 0.62 ? 1 + (r() < 0.4 ? 1 : 0) : 0;
    for (let q = 0; q < n; q++) {
      const cx = (i + 0.1 + r() * 0.8) * CC, cz = (j + 0.1 + r() * 0.8) * CC;
      const g = Math.max(0, terrainH(cx, cz, 0));
      const base = Math.max(680 + r() * 380, g + 260);
      c.push(makeCloud(r, cx, base, cz, 160 + r() * 300));
    }
    cloudCells.set(k, c);
    return c;
  }

  function seedCell(i, j) {
    const k = key(i, j);
    let s = seedCells.get(k);
    if (s !== undefined) return s;
    const r = rng(i, j, 2);
    s = null;
    if (r() < 0.45) {
      const n = 10 + Math.floor(r() * 8);
      let x = (i + 0.2 + r() * 0.6) * SC, z = (j + 0.2 + r() * 0.6) * SC, h = r() * 6.2832;
      const a0 = 16 + r() * 45, ph = r() * 6.28, turn = (r() - 0.5) * 0.12;
      const p = new Float32Array(n * 3);
      for (let q = 0; q < n; q++) {
        x += Math.cos(h) * 15; z += Math.sin(h) * 15;
        h += turn + (r() - 0.5) * 0.18;
        p[q * 3] = x; p[q * 3 + 1] = groundH(x, z) + a0 + Math.sin(q * 0.45 + ph) * 14; p[q * 3 + 2] = z;
      }
      s = { n, p, got: new Uint8Array(n) };
    }
    seedCells.set(k, s);
    return s;
  }

  // ── queries ──
  function around(cell, x, z, R, fn, out) {
    const i0 = Math.floor((x - R) / cell), i1 = Math.floor((x + R) / cell);
    const j0 = Math.floor((z - R) / cell), j1 = Math.floor((z + R) / cell);
    out.length = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const v = fn(i, j); if (v) out.push(v); }
    return out;
  }
  const thermalsAround = (x, z, R, out) => around(TC, x, z, R, thermal, out);
  const seedsAround = (x, z, R, out) => around(SC, x, z, R, seedCell, out);
  const cloudsAround = (x, z, R, out) => around(CC, x, z, R, cloudCell, out);

  const tmpN = [0, 0, 0], near = [], ts = [0, 0, 0];
  let realistic = false;
  // realistic thermals are bubbles: born over their source, carried downwind by the mean wind, fading after a few minutes
  const TPER = 420, DRIFT = 1.3;
  // thermals whose current position may be within R of (x, z): in realistic mode, search upwind for drifting bubbles
  function thermalsNear(x, z, R, out) {
    if (!realistic) return thermalsAround(x, z, R, out);
    const reach = Math.hypot(WIND[0], WIND[2]) * DRIFT * TPER * 0.625;
    return thermalsAround(x - WIND[0] * DRIFT * TPER * 0.625, z - WIND[2] * DRIFT * TPER * 0.625, R + reach, out);
  }
  function thermalState(t, time, out) { // → [centreX, centreZ, strength 0..1]
    if (!realistic) { out[0] = t.x; out[1] = t.z; out[2] = 1; return out; }
    const P = TPER * (0.75 + t.seed * 0.5), age = ((time + t.seed * 997) % P + P) % P;
    out[0] = t.x + WIND[0] * DRIFT * age; out[1] = t.z + WIND[2] * DRIFT * age;
    out[2] = ss(0, 45, age) * (1 - ss(P - 70, P, age));
    return out;
  }
  const info = { thermal: 0, ridge: 0, agl: 0, ground: 0 };
  function windAt(x, y, z, out) {
    const g = groundH(x, z);
    const agl = y - g;
    const k = 1 + clamp(agl / 500, 0, 1) * 0.6;
    out[0] = WIND[0] * k; out[1] = 0; out[2] = WIND[2] * k;
    let th = 0, edge = 0;
    thermalsNear(x, z, 360, near);
    for (let q = 0; q < near.length; q++) {
      const t = near[q];
      thermalState(t, GLX.env.time, ts);
      if (ts[2] <= 0) continue;
      const dx = x - ts[0], dz = z - ts[1];
      const r2 = dx * dx + dz * dz;
      if (r2 < t.r * t.r * 9) {
        const core = ts[2] * Math.exp(-r2 / (t.r * t.r)) * ss(t.ground, t.ground + 40, y) * (1 - ss(t.top - 160, t.top, y));
        th += t.w * core;
        const d = Math.sqrt(r2) || 1;
        if (realistic) {
          // entrainment inflow near the base, a sinking ring outside, rough air at the boundary
          th -= t.w * 0.25 * Math.exp(-((d - t.r * 1.9) ** 2) / (t.r * t.r * 0.5)) * ss(t.ground, t.ground + 40, y);
          edge = Math.max(edge, core * (1 - core) * 4);
          out[0] -= dx / d * 0.5 * core; out[2] -= dz / d * 0.5 * core;
        } else {
          // relaxed: the column carries you with it, cancelling drift and drawing gently toward the core
          const keep = 1 - 0.85 * Math.min(1, core * 1.6);
          out[0] = out[0] * keep - dx / d * 1.4 * core * Math.min(1, d / t.r);
          out[2] = out[2] * keep - dz / d * 1.4 * core * Math.min(1, d / t.r);
        }
      }
    }
    if (realistic) {
      // turbulence: mechanical near the ground (scaled by wind), convective at thermal edges; varies across a wingspan
      const t = GLX.env.time, amp = 0.9 * Math.exp(-Math.max(agl, 0) / 180) + 1.4 * edge;
      const gv = (vn(x * 0.045 + t * 0.4, z * 0.045 - t * 0.25) - 0.5) * 2, gh = (vn(x * 0.03 - t * 0.3 + 7.7, z * 0.03 + 3.1) - 0.5) * 2;
      th += gv * amp;
      out[0] += gh * amp * 0.6; out[2] -= gh * amp * 0.4;
    }
    let ridge = 0;
    if (agl < 220) {
      terrainN(x, z, tmpN);
      const gx = -tmpN[0] / tmpN[1], gz = -tmpN[2] / tmpN[1];
      ridge = clamp((WIND[0] * gx + WIND[2] * gz) * 1.4, -1.5, 6) * Math.exp(-Math.max(agl, 0) / 90);
    }
    out[1] = th + ridge;
    info.thermal = th; info.ridge = ridge; info.agl = agl; info.ground = g;
    return out;
  }

  function findStart() {
    for (let k = 0; k < 4000; k++) {
      const a = k * 0.7, d = 200 + k * 40;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = terrainH(x, z, 1);
      if (h > 30 && h < 110 && terrainH(x + 1500, z + 700, 1) > 5) {
        let hi = 0;
        for (let s = 0; s < 8; s++) hi = Math.max(hi, terrainH(x + Math.cos(s) * 900, z + Math.sin(s) * 900, 1));
        if (hi > 180) return [x, z];
      }
    }
    return [0, 0];
  }
  function evict(x, z) {
    for (const [m, cell, lim] of [[thermals, TC, 12], [seedCells, SC, 16], [cloudCells, CC, 10]]) {
      if (m.size < 1500) continue;
      for (const [k] of m) {
        const i = Math.floor(k / 65536) - 32768, j = (k % 65536) - 32768;
        if (Math.abs(i * cell - x) > cell * lim || Math.abs(j * cell - z) > cell * lim) m.delete(k);
      }
    }
  }
  return { WIND, windAt, info, thermalsAround, thermalsNear, thermalState, seedsAround, cloudsAround, findStart, evict,
    get realistic() { return realistic; }, set realistic(v) { realistic = !!v; } };
})();
