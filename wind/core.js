'use strict';
// ───────────────────────── Core: math, shared noise/terrain (JS + GLSL twins), GL helpers ─────────────────────────
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ── noise (bit-identical hash on CPU and GPU) ──
function hash2(x, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffffff) / 16777216;
}
// the same hash's 32 bits (three independent bytes for the price of one hash)
function hash2u(x, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return h ^ (h >>> 16);
}
function vn(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

// value noise with derivatives → [v, dv/dx, dv/dz] in a shared scratch array
const VND = [0, 0, 0];
function vnd(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  VND[0] = a + k1 * ux + k2 * uz + k4 * ux * uz;
  VND[1] = dux * (k1 + k4 * uz); VND[2] = duz * (k2 + k4 * ux);
  return VND;
}
// Terrain height (m). Landforms: a continent with seas and lakes; rolling lowland hills; eroded mountain ranges
// (ridged noise whose finer octaves are damped where the slope is already steep, so faces stay clean and detail gathers
// in the gullies) stretched so their ridgelines tend to run across the wind, so windward faces give ridge lift; river
// valleys; canyon country (a raised plateau cut by deep meandering gorges with stepped walls, the bigger ones flooded);
// mesas. det: 1 = full detail (CPU); lower values drop the finest octaves (the GPU filters by distance instead).
const TERRAIN_WU = [0.9119, 0.4104]; // = normalize(WORLD.WIND.xz)
function terrainHProc(x, z, det) {
  const minWave = det >= 1 ? 0 : 300 * (1 - det);
  const wx = vn(x * 0.00035 + 3.1, z * 0.00035 + 1.7) - 0.5, wz = vn(x * 0.00035 + 8.3, z * 0.00035 + 4.9) - 0.5;
  const px = x + wx * 1100, pz = z + wz * 1100;
  const c = (0.5 * vn(px * 0.00015 + 0.5, pz * 0.00015 + 0.5) + 0.25 * vn(px * 0.0003 + 2.1, pz * 0.0003 + 7.3)
    + 0.125 * vn(px * 0.0006 + 4.4, pz * 0.0006 + 1.9)) / 0.875;
  const land = ss(0.3, 0.5, c), high = ss(0.46, 0.74, c);
  const rA = vn(px * 0.00009 + 13.1, pz * 0.00009 + 4.2), rB = vn(px * 0.00011 + 2.9, pz * 0.00011 + 17.7);
  const canyonR = ss(0.6, 0.7, rA) * land * (1 - high);
  const mesaR = ss(0.62, 0.72, rB) * land * (1 - high) * (1 - canyonR);
  let hl = 0, amp = 0.5, f = 1 / 1100;
  for (let i = 0; i < 4; i++) { hl += amp * vn(px * f + 11.5, pz * f + 2.2); f *= 2.07; amp *= 0.5; }
  hl /= 0.9375;
  let mtn = 0;
  if (high > 0.001) {
    const u = px * TERRAIN_WU[0] + pz * TERRAIN_WU[1], v = -px * TERRAIN_WU[1] + pz * TERRAIN_WU[0];
    let qx = u / 3750 + 5.3, qz = v / 6750 + 9.1, a = 0, b = 1, dx = 0, dz = 0, wave = 3750, cr = 0;
    for (let i = 0; i < 7; i++) {
      const w = ss(minWave, minWave * 2 + 1e-3, wave);
      if (w <= 0) break;
      const n = vnd(qx, qz);
      const e = i < 3 ? 0.004 : 0.1, s = n[0] * 2 - 1, sa = Math.sqrt(s * s + e), r = 1 - sa + Math.sqrt(e);
      const sg = -2 * s / Math.max(sa, 1e-4);
      dx += sg * n[1] * r; dz += sg * n[2] * r;
      a += w * (i < 3 ? 1 : 1 - 0.7 * cr) * b * r * r / (1 + (dx * dx + dz * dz) * 0.14); // fine detail stays off the main crests: arêtes, not saws
      if (i < 2) cr = Math.max(cr, ss(0.82, 1, r));
      b *= 0.48; wave *= 0.5;
      const nx = qx * 1.6 - qz * 1.2, nz = qx * 1.2 + qz * 1.6;
      qx = nx + 1.7; qz = nz + 8.3;
    }
    mtn = Math.pow(a / 1.35, 1.7);
  }
  let h = -55 + land * 80 + land * hl * 150 + high * (mtn * 1250 + hl * 120);
  const vly = Math.abs(vn(px * 0.00036 + 1.9, pz * 0.00036 + 6.4) - 0.5);
  const valley = 1 - ss(0, 0.13 + 0.03 * (1 - high), vly);
  h -= valley * valley * (30 * land + 380 * high);
  if (canyonR > 0.001) {
    const cw = vn(px * 0.0009 + 2.2, pz * 0.0009 + 7.7) - 0.5;
    const path = Math.abs(vn(px * 0.00032 + cw * 0.5 + 4.6, pz * 0.00032 - cw * 0.4 + 1.2) - 0.5);
    const wall = 1 - ss(0.013, 0.036, path);
    const w4 = wall * 4, steps = (Math.floor(w4) + ss(0.72, 1, w4 - Math.floor(w4))) / 4;
    const plateau = h + 150;
    h = h + canyonR * (plateau - h) - canyonR * steps * (plateau + 12);
  }
  if (mesaR > 0.001) {
    const m = vn(px * 0.0014 + 9.4, pz * 0.0014 + 5.5);
    h += mesaR * (95 * ss(0.54, 0.58, m) + 55 * ss(0.66, 0.7, m));
  }
  let d = 0; amp = 0.5; f = 1 / 160; let w2 = 160;
  for (let i = 0; i < 3; i++) { d += ss(minWave, minWave * 2 + 1e-3, w2) * amp * (vn(px * f + 3.3, pz * f + 7.1) - 0.5); f *= 2.1; amp *= 0.5; w2 /= 2.1; }
  h += d * 24 * (0.35 + land) * (1 + high);
  return h;
}
// terrainH()'s mountain-range factor: 0 in the lowlands, 1 in the heart of a range; varies over kilometres
function terrainHighProc(x, z) {
  const px = x + (vn(x * 0.00035 + 3.1, z * 0.00035 + 1.7) - 0.5) * 1100, pz = z + (vn(x * 0.00035 + 8.3, z * 0.00035 + 4.9) - 0.5) * 1100;
  const c = (0.5 * vn(px * 0.00015 + 0.5, pz * 0.00015 + 0.5) + 0.25 * vn(px * 0.0003 + 2.1, pz * 0.0003 + 7.3)
    + 0.125 * vn(px * 0.0006 + 4.4, pz * 0.0006 + 1.9)) / 0.875;
  return ss(0.46, 0.74, c);
}
function forestMask(x, z) {
  return ss(0.54, 0.66, vn(x * 0.0021 + 7.7, z * 0.0021 + 3.3) * 0.7 + vn(x * 0.009 + 1.1, z * 0.009 + 9.9) * 0.3);
}
// ── the island: a baked heightfield (island.bin, decoded by boot.js into window.ISLAND_DATA) ──
// Stored as 16-bit steps (height = q·step + offset; 8192² at 7.8 m: 128 MB here, the same again on the GPU — a float
// copy would be twice that). Heights between samples are Catmull-Rom bicubic (smooth, and it keeps the ridgelines), plus
// the detail synthesised below the grid's resolution (terrainDetail) — the same function as the GLSL terrainH(), so the
// ground you collide with is the ground you see. Without island data (the model viewer, or a failed load) the old
// procedural world stands in.
const ISLAND = (() => {
  const D = typeof window !== 'undefined' && window.ISLAND_DATA;
  if (!D) return null;
  const { n, dx, origin, q, step, offset, size } = D;
  // a smoothed copy (1 km cells, blurred to ~3 km) for regional questions: how mountainous is it around here?
  const m = 64, b = n / m, sm = new Float32Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    let s = 0;
    for (let y = j * b; y < (j + 1) * b; y += 4) for (let x = i * b; x < (i + 1) * b; x += 4) s += Math.max(q[y * n + x] * step + offset, 0);
    sm[j * m + i] = s / ((b / 4) * (b / 4));
  }
  for (let pass = 0; pass < 3; pass++) {
    const t = sm.slice();
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      let s = 0, w = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj, ii = i + di;
        if (jj < 0 || ii < 0 || jj >= m || ii >= m) continue;
        const k = (di ? 1 : 2) * (dj ? 1 : 2); s += t[jj * m + ii] * k; w += k;
      }
      sm[j * m + i] = s / w;
    }
  }
  return { n, dx, inv: 1 / dx, origin, size, q, step, offset, sm, m, cs: size / m };
})();
const _cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
const _cl = (i, m) => (i < 0 ? 0 : i > m ? m : i);
// the stored heightfield alone (m): Catmull-Rom over the 4×4 samples around (x, z), in steps, then scaled — as hmCubic()
function islandH(x, z) {
  const I = ISLAND, n = I.n, q = I.q, m = n - 1;
  const u = (x - I.origin) * I.inv - 0.5, v = (z - I.origin) * I.inv - 0.5;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const x0 = _cl(iu - 1, m), x1 = _cl(iu, m), x2 = _cl(iu + 1, m), x3 = _cl(iu + 2, m);
  const y0 = _cl(iv - 1, m) * n, y1 = _cl(iv, m) * n, y2 = _cl(iv + 1, m) * n, y3 = _cl(iv + 2, m) * n;
  return _cr(_cr(q[y0 + x0], q[y0 + x1], q[y0 + x2], q[y0 + x3], fu), _cr(q[y1 + x0], q[y1 + x1], q[y1 + x2], q[y1 + x3], fu),
    _cr(q[y2 + x0], q[y2 + x1], q[y2 + x2], q[y2 + x3], fu), _cr(q[y3 + x0], q[y3 + x1], q[y3 + x2], q[y3 + x3], fu), fv) * I.step + I.offset;
}
// islandH at (x, z) and one stored texel to either side in x and in z, from one 6×6 window of steps (the same Catmull-Rom
// with the same weights, then scaled, so out[0] is exactly islandH(x, z)) → out = [h, h(x + dx), h(x − dx), h(z + dx),
// h(z − dx)] in metres
const _hcr = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
function islandHCross(x, z, out) {
  const I = ISLAND, n = I.n, q = I.q, m = n - 1, [rm, r0, rp] = _hcr, st = I.step, of = I.offset;
  const u = (x - I.origin) * I.inv - 0.5, v = (z - I.origin) * I.inv - 0.5;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const c0 = _cl(iu - 2, m), c1 = _cl(iu - 1, m), c2 = _cl(iu, m), c3 = _cl(iu + 1, m), c4 = _cl(iu + 2, m), c5 = _cl(iu + 3, m);
  for (let j = 0; j < 6; j++) {
    const y = _cl(iv - 2 + j, m) * n;
    const a = q[y + c0], b = q[y + c1], c = q[y + c2], d = q[y + c3], e = q[y + c4], f = q[y + c5];
    rm[j] = _cr(a, b, c, d, fu); r0[j] = _cr(b, c, d, e, fu); rp[j] = _cr(c, d, e, f, fu);
  }
  out[0] = _cr(r0[1], r0[2], r0[3], r0[4], fv) * st + of;
  out[1] = _cr(rp[1], rp[2], rp[3], rp[4], fv) * st + of; out[2] = _cr(rm[1], rm[2], rm[3], rm[4], fv) * st + of;
  out[3] = _cr(r0[2], r0[3], r0[4], r0[5], fv) * st + of; out[4] = _cr(r0[0], r0[1], r0[2], r0[3], fv) * st + of;
  return out;
}
// ── terrain detail below the stored grid (JS twin of terrainDetail() in GLSL_COMMON: same numbers, same order) ──
// The stored heights stop at one sample every ISLAND.dx metres, and Catmull-Rom between them is smooth and blobby; below
// that the ground gets the relief real slopes have at 8–32 m, synthesised from the island's own maps (and from the rock:
// the regions stand in for ticket 17's rock-type map until it exists):
//  - gullies and rills: grooves down the fall line (an erosion filter: each cell of a jittered lattice lays a cosine
//    across the slope through its point; the cells' phases are blended as vectors and normalised, so the grooves keep
//    their depth and fork where cells disagree). Each finer octave follows the slope with the coarser grooves in it, so
//    rills run down their flanks into them and the network branches; near the base's own hollows and spurs the octaves
//    lean toward a groove or a rib, so the stored landform's gullies stay clean. V-shaped, deep on steep ground, none on
//    flats, straighter and softer in scree, none in alluvium and river channels.
//  - knobs: the Nordic granite, scoured by the ice into rounded bosses and hollows, streamlined down-glacier.
//  - ledges: the rock's bedding, a soft staircase in the height (plus a dip) with beds of uneven thickness and hardness,
//    in the limestone south, on the plateau and in the volcano's lava; they fade where their spacing on the ground gets
//    finer than the mesh can draw.
// Each octave fades out by the LOD's minWave like the rest of the terrain, and faster: the meshes keep a fixed angle per
// vertex (ticket 14), so fading by minWave alone kept every octave ~10 px across out to 3 km, and far slopes read as
// combed. On the mesh filters (MINWAVE·2^L) the fade wavelength grows as minWave^(1+FADE) (tdetFade): at RK 14 the 8
// and 16 m octaves are gone by 0.9 km and the 32 m one by 1.75 km (it was 3.5 km), and farther slopes keep the stored
// landform. The finest mesh (LOD 0) is a 2 m grid filtered at minWave 4 m, where the two agree, so the finest geometric
// octave is 8 m, and JS (collision) always evaluates at that filter: the same height the nearest mesh is built from.
// Finer relief belongs to the fragment shader: terrainDetailFrag().
// The coarsest octave (c0) is two stored texels, but never under 32 m: the 8192² island (7.8 m) could hold 16–32 m
// relief, yet its slopes carry little of it, and with a 16 m top octave the gullies read as fine texture rather than
// landform. (Once the generator's own rock structure fills that band, ticket 17, the floor can drop to 2 texels.)
const TDET = (() => {
  const texel = ISLAND ? ISLAND.dx : 16, M = typeof window !== 'undefined' && window.ISLAND_MAPS;
  return { MINWAVE: 4, FADE: 1.25, f: [0, 0, 0], c0: Math.max(32, Math.pow(2, Math.round(Math.log2(texel * 2)))), e: texel, M: M || null, m: [0, 0, 0, 1], r: [0, 0, 0, 1], g: [0, 0, 0] };
})();
// bilinear between texel centres of an RGBA8 island map (n², over the island), clamped at the edges, 0…1 → out
function islTex(data, n, x, z, out) {
  if (!data) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; } // as WebGL samples a missing texture
  const I = ISLAND, u = (x - I.origin) * I.inv / I.n * n - 0.5, v = (z - I.origin) * I.inv / I.n * n - 0.5;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv, m = n - 1;
  const x0 = Math.min(Math.max(iu, 0), m) * 4, x1 = Math.min(Math.max(iu + 1, 0), m) * 4;
  const y0 = Math.min(Math.max(iv, 0), m) * n * 4, y1 = Math.min(Math.max(iv + 1, 0), m) * n * 4;
  for (let c = 0; c < 4; c++) {
    const a = data[y0 + x0 + c] / 255, b = data[y0 + x1 + c] / 255, d = data[y1 + x0 + c] / 255, e = data[y1 + x1 + c] / 255;
    const top = a * (1 - fu) + b * fu, bot = d * (1 - fu) + e * fu;
    out[c] = top * (1 - fv) + bot * fv;
  }
  return out;
}
// one octave of grooves: p in cells, (tx, tz) the unit direction across the slope, o the octave (its own lattice).
// The cells' stripes are blended as phase vectors (cos, sin) and normalised, so the grooves keep their full depth where
// neighbouring cells disagree and only fork there; their depth comes from a separate smooth per-cell amplitude.
// → TDET.g = [height −1…1 (the stripe's cosine), its sine (the flank: the slope across is ∝ sine·t), depth 0…1]
function gullyOct(px, pz, tx, tz, o) {
  const ix = Math.floor(px), iz = Math.floor(pz), fx = px - ix, fz = pz - iz, so = 7919 * (o + 1);
  let sc = 0, ssn = 0, sa = 0, sw = 1e-4;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const hh = hash2u(ix + i, iz + j + so);
    const ox = i + 0.2 + 0.6 * ((hh & 255) / 255) - fx, oz = j + 0.2 + 0.6 * (((hh >>> 8) & 255) / 255) - fz;
    const d2 = ox * ox + oz * oz;
    if (d2 >= 1.44) continue;
    // each groove its own depth and spacing (the deeper, the wider; spacing ±35%, so neighbours never fall in step)
    const hm = ((hh >>> 16) & 255) / 255, fr = 6.2831853 * (1.35 - 0.7 * hm);
    const k = 1 - d2 / 1.44, w = k * k * k, ph = fr * (ox * tx + oz * tz);
    sc += w * Math.cos(ph); ssn += w * Math.sin(ph); sa += w * hm * hm; sw += w;
  }
  const g = TDET.g, m = 1 / Math.sqrt(sc * sc + ssn * ssn + 0.01 * sw * sw);
  g[0] = sc * m; g[1] = ssn * m; g[2] = sa / sw;
  return g;
}
// one octave of ice-scoured knobs: bosses of granite on a jittered lattice (itself gently warped, so no rows show), each
// its own height and length and about a third of them missing, streamlined along the ice's flow (ax, az: unit,
// down-glacier): 2–3× longer than wide, long and smooth on the side the ice came from, steep where it plucked the lee.
// The surface is the highest boss at each point (a smooth maximum of the best two, so the hollows between are soft
// creases), with flat floors where the hollows go deep or a boss is missing (bogs and lochans) → height 0…~1.2, mean
// 0.123. (Packed, round and all present, they read as bubble wrap from above.)
function knobOct(px, pz, ax, az, o) {
  const wx = px + 0.7 * (vn(px * 0.37 + 5.1 + o, pz * 0.37 + 1.7) - 0.5), wz = pz + 0.7 * (vn(px * 0.37 + 2.9, pz * 0.37 + 8.3 + o) - 0.5);
  const ix = Math.floor(wx), iz = Math.floor(wz), fx = wx - ix, fz = wz - iz, so = 104729 + 7919 * o;
  let v1 = -9, v2 = -9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const hh = hash2u(ix + i, iz + j + so);
    const ox = fx - i - 0.2 - 0.6 * ((hh & 255) / 255), oz = fz - j - 0.2 - 0.6 * (((hh >>> 8) & 255) / 255);
    let u = ox * ax + oz * az;
    const v = oz * ax - ox * az;
    u *= u > 0 ? 1.8 : 0.7;
    const gap = ((Math.imul(hh, 0x9E3779B1) >>> 24) / 255) < 0.35 ? 0.9 : 0;
    const el = 3 + 3 * (((hh >>> 16) & 255) / 255), val = 0.2 + 0.8 * ((hh >>> 24) / 255) - gap - 1.6 * (u * u + v * v * el);
    if (val > v1) { v2 = v1; v1 = val; } else if (val > v2) v2 = val;
  }
  const s = Math.max(0.35 - (v1 - v2), 0) / 0.35;
  return Math.max(v1 + s * s * 0.0875, 0);
}
// the octaves' fade for a mesh filtered at minWave mw (≥ MINWAVE) → f = [the fade wavelength on the mesh filter below
// mw (MINWAVE·2^L), on the one above, and mw's place between them 0…1]. On a mesh filter an octave c weighs ss(f, 2f, c)
// (tdetW); between two it's linear in mw, as the CDLOD morph blends a mesh's two filters linearly, so one sample at the
// morph's minWave (landmarks, the fragment hook) is the mesh the camera sees, not a steeper fade of its own
function tdetFade(mw) {
  const T = TDET, f = T.f, L = Math.floor(Math.log2(mw / T.MINWAVE));
  f[0] = T.MINWAVE * Math.pow(2, L * (1 + T.FADE)); f[1] = f[0] * Math.pow(2, 1 + T.FADE); f[2] = mw / (T.MINWAVE * Math.pow(2, L)) - 1;
  return f;
}
const tdetW = (c, f) => { const a = ss(f[0], 2 * f[0], c); return a + (ss(f[1], 2 * f[1], c) - a) * f[2]; };
// the detail height (m) at (x, z) for a mesh filtered at minWave (m); hx = islandHCross(x, z)
function terrainDetail(x, z, minWave, hx) {
  const T = TDET, h = hx[0];
  minWave = Math.max(minWave, T.MINWAVE);
  const f = tdetFade(minWave), fw = f[0], land = ss(0.5, 3.0, h);
  if (fw >= T.c0 || land <= 0) return 0;
  const e = T.e, hxp = hx[1], hxm = hx[2], hzp = hx[3], hzm = hx[4];
  const gx = (hxp - hxm) / (2 * e), gz = (hzp - hzm) / (2 * e), sl = Math.sqrt(gx * gx + gz * gz);
  const lap = (hxp + hxm + hzp + hzm - 4 * h) / (e * e);
  const M = T.M, m = islTex(M && M.maps, M ? M.nm : 1, x, z, T.m), r = islTex(M && M.regions, M ? M.nr : 1, x, z, T.r);
  // the rock (ticket 17 will export a rock-type map; until then the regions stand for it)
  const nord = r[0], med = r[1], plat = r[2], volc = r[3], alp = Math.min(Math.max(1 - nord - med - plat - volc, 0), 1);
  const scree = m[2], calm = (1 - ss(0.35, 0.85, m[1])) * (1 - ss(0.3, 0.65, m[0])) * land;
  const gully = (0.5 * nord + 0.75 * med + 0.55 * plat + 0.9 * volc + 1.0 * alp) * (1 - 0.5 * scree);
  const branch = (0.9 * nord + 0.9 * med + 0.8 * plat + 0.3 * volc + 1.0 * alp) * (1 - 0.8 * scree);
  let d = 0;
  // gullies and rills. r: the coarser relief's shape here, −1 in a hollow or gully … +1 on a spur or rib — each octave is
  // drawn toward it where it's strong, so gully floors and crests stay clean and the detail gathers on the flanks.
  // (fx, fz): the coarser grooves' flank direction, which bends the finer ones into them
  // gullied slopes come in patches (a few hundred metres), with smoother stretches of hillside between
  const amp = gully * ss(0.05, 1.0, sl) * calm * (0.4 + 0.6 * ss(0.3, 0.7, vn(x / 170 + 4.1, z / 170 + 8.3)));
  if (amp > 0) {
    let r = Math.min(Math.max(-lap * 20, -1), 1), fx = 0, fz = 0, a = 1;
    const ux = gx / (sl + 1e-6), uz = gz / (sl + 1e-6);
    for (let o = 0; o < 6; o++) {
      const c = T.c0 * Math.pow(2, -o);
      if (c <= fw) break;
      // the flank only turns the fall line (its part along the slope is dropped, so the two can never cancel)
      const fa = fx * ux + fz * uz, px = fx - fa * ux, pz = fz - fa * uz;
      const Gx = gx + 2 * branch * sl * px, Gz = gz + 2 * branch * sl * pz, l = Math.sqrt(Gx * Gx + Gz * Gz + 1e-4);
      const tx = -Gz / l, tz = Gx / l, g = gullyOct(x / c, z / c, tx, tz, o), k = 0.4 * r * r;
      // depth: shallow over most of the slope, deep in patches of a few grooves (g[2] averages the cells around)
      const v = g[0] + (r - g[0]) * k, dep = 0.1 + 0.9 * ss(0.06, 0.5, g[2]);
      // V-shaped gullies, rounded ribs: ~2|cos(θ/2)| − 4/π (zero mean)
      d += tdetW(c, f) * amp * c * 0.35 * a * dep * (2 * Math.sqrt(Math.max(0.5 + 0.5 * v, 0) + 0.03) - 1.355);
      const fl = a * dep * (1 - k) * g[1];
      fx += fl * tx; fz += fl * tz;
      r = v; a *= o < 2 ? 0.55 : 0.8;
    }
  }
  // knobs: the Nordic granite, scoured by the ice sheet into rounded bosses with hollows between (flats too: knock-and-
  // lochan country), streamlined the way the ice flowed: out from the highlands to the north-west coast
  // bare knobby bedrock in patches, smoother till-covered ground between
  const knob = nord * (1 - ss(0.9, 1.5, sl)) * calm * (0.25 + 0.75 * ss(0.35, 0.65, vn(x / 260 + 2.3, z / 260 + 6.7)));
  if (knob > 0) {
    let a = 1;
    for (let o = 0; o < 6; o++) {
      const c = T.c0 * Math.pow(2, -o);
      if (c <= fw) break;
      d += tdetW(c, f) * knob * c * 0.24 * a * (knobOct(x / c, z / c, -0.78, -0.625, o) - 0.123);
      a *= 0.45;
    }
  }
  // ledges: the bedding, where the rock shows through. Beds of uneven thickness (a gentle warp of the level), each its own
  // hardness and bench width, and the ledges die out and return along the strike
  const ledge = (0.2 * nord + 0.7 * med + 1.0 * plat + 0.6 * volc + 0.25 * alp) * Math.max(m[3], ss(0.3, 0.9, sl)) * (1 - scree) * calm;
  if (ledge > 0) {
    const bed = 5 * nord + 7 * med + 8 * plat + 10 * volc + 6 * alp;
    const dx = 0.03 * med + 0.01 * plat + 0.2 * alp, dz = 0.01 * med - 0.005 * plat + 0.08 * alp;
    const lx = gx + dx, lz = gz + dz, P = bed / Math.max(Math.sqrt(lx * lx + lz * lz), 1e-3);
    const w = tdetW(P / 1.5, f);
    if (w > 0) {
      const zl = (h + dx * x + dz * z) / bed, s = zl + 0.35 * (vn(zl * 0.43 + 3.7, 0.5) - 0.5), fl = Math.floor(s), sf = s - fl;
      const thr = 0.3 + 0.4 * hash2(fl, 9173), hard = 0.35 + 0.65 * hash2(fl + 7, 331);
      const lat = 0.3 + 0.7 * ss(0.3, 0.7, vn(x / 97 + 1.3, z / 97 + 7.9));
      // the riser at least two mesh spacings wide (a sharper step would fall between the vertices), and never so wide
      // that it spills into the next bed
      const hw = Math.min(Math.max(0.15, minWave / P), thr, 1 - thr);
      d += ledge * w * bed * hard * lat * (ss(thr - hw, thr + hw, sf) - sf);
    }
  }
  return d;
}
const _hx5 = new Float64Array(5);
function terrainH(x, z, det) {
  if (!ISLAND) return terrainHProc(x, z, det);
  if (det < 1) return islandH(x, z);
  const hx = islandHCross(x, z, _hx5);
  return hx[0] + terrainDetail(x, z, TDET.MINWAVE, hx);
}
// how mountainous the country around (x, z) is, 0 lowland … 1 high mountains (smooth over kilometres)
function terrainHigh(x, z) {
  if (!ISLAND) return terrainHighProc(x, z);
  const I = ISLAND, m = I.m;
  const u = Math.min(Math.max((x - I.origin) / I.cs - 0.5, 0), m - 1.001), v = Math.min(Math.max((z - I.origin) / I.cs - 0.5, 0), m - 1.001);
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, sm = I.sm;
  const a = sm[j * m + i], b = sm[j * m + i + 1], c = sm[(j + 1) * m + i], d = sm[(j + 1) * m + i + 1];
  const hs = (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  return Math.min(Math.max(hs / 1400, 0), 1);
}
const groundH = (x, z) => Math.max(terrainH(x, z, 1), 0);
function terrainN(x, z, out) {
  const e = 1.5, h = terrainH(x, z, 1);
  const nx = h - terrainH(x + e, z, 1), nz = h - terrainH(x, z + e, 1);
  const l = Math.hypot(nx, e, nz);
  out[0] = nx / l; out[1] = e / l; out[2] = nz / l;
  return out;
}

// aerial-perspective froxel volume (shared by ATMOS and the GLSL below)
const ATMOS_AP_SLICES = 32, ATMOS_AP_RANGE_M = 40000;
const GLSL_COMMON = `
float hash2(ivec2 p){
  uint h = uint(p.x)*374761393u + uint(p.y)*668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u; h = h ^ (h >> 16u);
  return float(h & 16777215u) / 16777216.0;
}
uint hash2u(ivec2 p){ uint h = uint(p.x)*374761393u + uint(p.y)*668265263u; h = (h ^ (h >> 13u))*1274126177u; return h ^ (h >> 16u); }
float vn(vec2 p){
  vec2 i = floor(p), f = p - i;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  ivec2 ii = ivec2(i);
  float a = hash2(ii), b = hash2(ii+ivec2(1,0)), c = hash2(ii+ivec2(0,1)), d = hash2(ii+ivec2(1,1));
  return a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
}
vec3 vnd(vec2 p){
  vec2 i = floor(p), f = p - i;
  vec2 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0), du = 30.0*f*f*(f*(f - 2.0) + 1.0);
  ivec2 ii = ivec2(i);
  float a = hash2(ii), b = hash2(ii + ivec2(1, 0)), c = hash2(ii + ivec2(0, 1)), d = hash2(ii + ivec2(1, 1));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1*u.x + k2*u.y + k4*u.x*u.y, du*vec2(k1 + k4*u.y, k2 + k4*u.x));
}
// the old procedural terrain (JS twin terrainHProc); minWave (m) fades out octaves shorter than it
float terrainHProc(vec2 q, float minWave){
  float wx = vn(q*0.00035 + vec2(3.1,1.7)) - 0.5;
  float wz = vn(q*0.00035 + vec2(8.3,4.9)) - 0.5;
  vec2 p = q + vec2(wx, wz)*1100.0;
  float c = (0.5*vn(p*0.00015+vec2(0.5)) + 0.25*vn(p*0.0003+vec2(2.1,7.3)) + 0.125*vn(p*0.0006+vec2(4.4,1.9))) / 0.875;
  float land = smoothstep(0.3, 0.5, c), high = smoothstep(0.46, 0.74, c);
  float rA = vn(p*0.00009 + vec2(13.1, 4.2)), rB = vn(p*0.00011 + vec2(2.9, 17.7));
  float canyonR = smoothstep(0.6, 0.7, rA)*land*(1.0 - high);
  float mesaR = smoothstep(0.62, 0.72, rB)*land*(1.0 - high)*(1.0 - canyonR);
  float hl = 0.0, amp = 0.5, f = 1.0/1100.0;
  for (int i=0;i<4;i++){ hl += amp*vn(p*f + vec2(11.5,2.2)); f *= 2.07; amp *= 0.5; }
  hl /= 0.9375;
  float mtn = 0.0;
  if (high > 0.001) {
    const vec2 WU = vec2(0.9119, 0.4104);
    vec2 uv = vec2(dot(p, WU), dot(p, vec2(-WU.y, WU.x)));
    vec2 qq = uv/vec2(3750.0, 6750.0) + vec2(5.3, 9.1);
    float a = 0.0, b = 1.0, wave = 3750.0, cr = 0.0; vec2 dd = vec2(0.0);
    for (int i = 0; i < 7; i++){
      float w = smoothstep(minWave, minWave*2.0 + 1e-3, wave);
      if (w <= 0.0) break;
      vec3 n = vnd(qq);
      float e = i < 3 ? 0.004 : 0.1, s = n.x*2.0 - 1.0, sa = sqrt(s*s + e), r = 1.0 - sa + sqrt(e);
      float sg = -2.0*s/max(sa, 1e-4);
      dd += sg*n.yz*r;
      a += w*(i < 3 ? 1.0 : 1.0 - 0.7*cr)*b*r*r/(1.0 + dot(dd, dd)*0.14);
      if (i < 2) cr = max(cr, smoothstep(0.82, 1.0, r));
      b *= 0.48; wave *= 0.5;
      qq = vec2(qq.x*1.6 - qq.y*1.2, qq.x*1.2 + qq.y*1.6) + vec2(1.7, 8.3);
    }
    mtn = pow(a/1.35, 1.7);
  }
  float h = -55.0 + land*80.0 + land*hl*150.0 + high*(mtn*1250.0 + hl*120.0);
  float vly = abs(vn(p*0.00036 + vec2(1.9,6.4)) - 0.5);
  float valley = 1.0 - smoothstep(0.0, 0.13 + 0.03*(1.0 - high), vly);
  h -= valley*valley*(30.0*land + 380.0*high);
  if (canyonR > 0.001) {
    float cw = vn(p*0.0009 + vec2(2.2, 7.7)) - 0.5;
    float path = abs(vn(p*0.00032 + vec2(cw*0.5 + 4.6, -cw*0.4 + 1.2)) - 0.5);
    float wall = 1.0 - smoothstep(0.013, 0.036, path);
    float w4 = wall*4.0, steps = (floor(w4) + smoothstep(0.72, 1.0, w4 - floor(w4)))/4.0;
    float plateau = h + 150.0;
    h = h + canyonR*(plateau - h) - canyonR*steps*(plateau + 12.0);
  }
  if (mesaR > 0.001) {
    float m = vn(p*0.0014 + vec2(9.4, 5.5));
    h += mesaR*(95.0*smoothstep(0.54, 0.58, m) + 55.0*smoothstep(0.66, 0.7, m));
  }
  float d = 0.0, w2 = 160.0; amp = 0.5; f = 1.0/160.0;
  for (int i=0;i<3;i++){ d += smoothstep(minWave, minWave*2.0 + 1e-3, w2)*amp*(vn(p*f + vec2(3.3,7.1)) - 0.5); f *= 2.1; amp *= 0.5; w2 /= 2.1; }
  h += d*24.0*(0.35 + land)*(1.0 + high);
  return h;
}
float forestMask(vec2 p){
  return smoothstep(0.54, 0.66, vn(p*0.0021 + vec2(7.7,3.3))*0.7 + vn(p*0.009 + vec2(1.1,9.9))*0.3);
}
// ── the island heightfield (JS twin: terrainH/islandH/islandHCross in core.js): 16-bit steps in an R16UI texture with its
// own mip pyramid, filtered by hand (integer textures don't filter). uHeightP: origin (m), 1/cell (1/m), cells, enabled;
// uHeightQ: metres per step, offset (m). Fine detail: Catmull-Rom bicubic over 16 texels; coarser (minWave, m):
// trilinear over the pyramid, as textureLod would ──
uniform highp usampler2D uHeight; uniform vec4 uHeightP; uniform vec2 uHeightQ;
float hmF(ivec2 i){ int m = int(uHeightP.z) - 1; return float(texelFetch(uHeight, clamp(i, ivec2(0), ivec2(m)), 0).r); }
float crs(float p0, float p1, float p2, float p3, float t){ return p1 + 0.5*t*(p2 - p0 + t*(2.0*p0 - 5.0*p1 + 4.0*p2 - p3 + t*(3.0*(p1 - p2) + p3 - p0))); }
float hmCubic(vec2 q){
  vec2 u = (q - uHeightP.x)*uHeightP.y - 0.5, fi = floor(u), f = u - fi;
  ivec2 b = ivec2(fi);
  float r0 = crs(hmF(b + ivec2(-1, -1)), hmF(b + ivec2(0, -1)), hmF(b + ivec2(1, -1)), hmF(b + ivec2(2, -1)), f.x);
  float r1 = crs(hmF(b + ivec2(-1, 0)), hmF(b + ivec2(0, 0)), hmF(b + ivec2(1, 0)), hmF(b + ivec2(2, 0)), f.x);
  float r2 = crs(hmF(b + ivec2(-1, 1)), hmF(b + ivec2(0, 1)), hmF(b + ivec2(1, 1)), hmF(b + ivec2(2, 1)), f.x);
  float r3 = crs(hmF(b + ivec2(-1, 2)), hmF(b + ivec2(0, 2)), hmF(b + ivec2(1, 2)), hmF(b + ivec2(2, 2)), f.x);
  return crs(r0, r1, r2, r3, f.y)*uHeightQ.x + uHeightQ.y;
}
// pyramid level l, bilinear, in steps; u in level-0 texels
float hmBilin(vec2 u, int l){
  vec2 t = u*exp2(-float(l)) - 0.5, fi = floor(t), f = t - fi;
  ivec2 m = ivec2((int(uHeightP.z) >> l) - 1), a = clamp(ivec2(fi), ivec2(0), m), b = clamp(ivec2(fi) + 1, ivec2(0), m);
  float h00 = float(texelFetch(uHeight, a, l).r), h10 = float(texelFetch(uHeight, ivec2(b.x, a.y), l).r);
  float h01 = float(texelFetch(uHeight, ivec2(a.x, b.y), l).r), h11 = float(texelFetch(uHeight, b, l).r);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
float hmLod(vec2 q, float lod){
  vec2 u = (q - uHeightP.x)*uHeightP.y;
  float top = log2(uHeightP.z);
  lod = clamp(lod, 0.0, top);
  int l = int(lod); float t = lod - float(l);
  float h = hmBilin(u, l);
  if (t > 0.0) h = mix(h, hmBilin(u, min(l + 1, int(top))), t);
  return h*uHeightQ.x + uHeightQ.y;
}
// hmCubic at q and one stored texel to either side in x and in z, from one 6×6 window of steps (32 fetches, not 80; the
// same weights, then scaled, so h is exactly hmCubic(q)) → h, nb = (h(x + dx), h(x − dx), h(z + dx), h(z − dx)) in metres
void hmCross(vec2 q, out float h, out vec4 nb){
  vec2 u = (q - uHeightP.x)*uHeightP.y - 0.5, fi = floor(u), f = u - fi;
  ivec2 b = ivec2(fi);
  float rm[6], r0[6], rp[6];
  for (int j = 0; j < 6; j++) {
    ivec2 y = b + ivec2(0, j - 2);
    float c1 = hmF(y + ivec2(-1, 0)), c2 = hmF(y), c3 = hmF(y + ivec2(1, 0)), c4 = hmF(y + ivec2(2, 0));
    r0[j] = crs(c1, c2, c3, c4, f.x);
    if (j > 0 && j < 5) { float c0 = hmF(y + ivec2(-2, 0)), c5 = hmF(y + ivec2(3, 0)); rm[j] = crs(c0, c1, c2, c3, f.x); rp[j] = crs(c2, c3, c4, c5, f.x); }
  }
  h = crs(r0[1], r0[2], r0[3], r0[4], f.y)*uHeightQ.x + uHeightQ.y;
  nb = vec4(crs(rp[1], rp[2], rp[3], rp[4], f.y), crs(rm[1], rm[2], rm[3], rm[4], f.y), crs(r0[2], r0[3], r0[4], r0[5], f.y), crs(r0[0], r0[1], r0[2], r0[3], f.y))*uHeightQ.x + uHeightQ.y;
}
// the island's data maps: (river flow, sediment, scree, bare rock) and region weights (Nordic, Mediterranean, plateau,
// volcano; the Alpine centre is what's left)
uniform sampler2D uIslMaps, uIslReg;
vec4 islandMaps(vec2 q){ return textureLod(uIslMaps, (q - uHeightP.x)*uHeightP.y/uHeightP.z, 0.0); }
vec4 islandRegions(vec2 q){ return textureLod(uIslReg, (q - uHeightP.x)*uHeightP.y/uHeightP.z, 0.0); }
// ── terrain detail below the stored grid (JS twin: TDET / islTex / gullyOct / terrainDetail in core.js, which explains
// it): gullies and rills down the fall line, ledges along the bedding, driven by the island's maps ──
const float TDET_MINWAVE = 4.0; // the finest mesh's filter (LOD 0: a 2 m grid at minWave 2 cells)
const float TDET_FADE = 1.25;   // on the mesh filters the fade wavelength grows as minWave^(1 + TDET_FADE) (JS: TDET.FADE)
vec3 tdetFade(float mw){
  float L = floor(log2(mw/TDET_MINWAVE)), f0 = TDET_MINWAVE*exp2(L*(1.0 + TDET_FADE));
  return vec3(f0, f0*exp2(1.0 + TDET_FADE), mw/(TDET_MINWAVE*exp2(L)) - 1.0);
}
float tdetW(float c, vec3 f){ float a = smoothstep(f.x, 2.0*f.x, c); return a + (smoothstep(f.y, 2.0*f.y, c) - a)*f.z; }
float tdetC0(){ return max(32.0, exp2(round(log2(2.0/uHeightP.y)))); } // the coarsest octave (m): 2 stored texels, ≥ 32 m
// bilinear between texel centres of an island map, clamped at the edges (texelFetch: exact, so JS matches)
vec4 islTex(sampler2D s, vec2 q){
  int n = max(textureSize(s, 0).x, 1);
  vec2 t = (q - uHeightP.x)*uHeightP.y/uHeightP.z*float(n) - 0.5, fl = floor(t), f = t - fl;
  ivec2 i = ivec2(fl), m = ivec2(n - 1);
  vec4 a = texelFetch(s, clamp(i, ivec2(0), m), 0), b = texelFetch(s, clamp(i + ivec2(1, 0), ivec2(0), m), 0);
  vec4 c = texelFetch(s, clamp(i + ivec2(0, 1), ivec2(0), m), 0), d = texelFetch(s, clamp(i + ivec2(1, 1), ivec2(0), m), 0);
  return (a*(1.0 - f.x) + b*f.x)*(1.0 - f.y) + (c*(1.0 - f.x) + d*f.x)*f.y;
}
// one octave of grooves: p in cells, t the unit direction across the slope → (the stripe's cosine −1…1, its sine,
// depth 0…1): phase vectors blended and normalised
vec3 gullyOct(vec2 p, vec2 t, int o){
  vec2 ip = floor(p), f = p - ip;
  ivec2 b = ivec2(ip); int so = 7919*(o + 1);
  float sc = 0.0, sn = 0.0, sa = 0.0, sw = 1e-4;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    uint hh = hash2u(b + ivec2(i, j + so));
    vec2 of = vec2(float(i) + 0.2 + 0.6*(float(hh & 255u)/255.0) - f.x, float(j) + 0.2 + 0.6*(float((hh >> 8u) & 255u)/255.0) - f.y);
    float d2 = dot(of, of);
    if (d2 >= 1.44) continue;
    float hm = float((hh >> 16u) & 255u)/255.0, fr = 6.2831853*(1.35 - 0.7*hm);
    float k = 1.0 - d2/1.44, w = k*k*k, ph = fr*dot(of, t);
    sc += w*cos(ph); sn += w*sin(ph); sa += w*hm*hm; sw += w;
  }
  float m = 1.0/sqrt(sc*sc + sn*sn + 0.01*sw*sw);
  return vec3(sc*m, sn*m, sa/sw);
}
// one octave of ice-scoured knobs (a: unit, down-glacier) → height 0…~1.2, mean 0.123
float knobOct(vec2 p, vec2 a, int o){
  p += 0.7*(vec2(vn(p*0.37 + vec2(5.1 + float(o), 1.7)), vn(p*0.37 + vec2(2.9, 8.3 + float(o)))) - 0.5);
  vec2 ip = floor(p), f = p - ip;
  ivec2 b = ivec2(ip); int so = 104729 + 7919*o;
  float v1 = -9.0, v2 = -9.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    uint hh = hash2u(b + ivec2(i, j + so));
    vec2 of = vec2(f.x - float(i) - 0.2 - 0.6*(float(hh & 255u)/255.0), f.y - float(j) - 0.2 - 0.6*(float((hh >> 8u) & 255u)/255.0));
    float u = of.x*a.x + of.y*a.y, v = of.y*a.x - of.x*a.y;
    u *= u > 0.0 ? 1.8 : 0.7;
    float gap = float((hh*0x9E3779B1u) >> 24u)/255.0 < 0.35 ? 0.9 : 0.0;
    float el = 3.0 + 3.0*(float((hh >> 16u) & 255u)/255.0), val = 0.2 + 0.8*(float(hh >> 24u)/255.0) - gap - 1.6*(u*u + v*v*el);
    if (val > v1) { v2 = v1; v1 = val; } else if (val > v2) v2 = val;
  }
  float s = max(0.35 - (v1 - v2), 0.0)/0.35;
  return max(v1 + s*s*0.0875, 0.0);
}
// the detail height (m) at q for a mesh filtered at minWave (m); hc, nb from hmCross(q)
float terrainDetail(vec2 q, float minWave, float hc, vec4 nb){
  minWave = max(minWave, TDET_MINWAVE);
  vec3 f = tdetFade(minWave); float fw = f.x, c0 = tdetC0(), land = smoothstep(0.5, 3.0, hc);
  if (fw >= c0 || land <= 0.0) return 0.0;
  float e = 1.0/uHeightP.y;
  vec2 g = vec2(nb.x - nb.y, nb.z - nb.w)/(2.0*e);
  float sl = length(g), lap = (nb.x + nb.y + nb.z + nb.w - 4.0*hc)/(e*e);
  vec4 m = islTex(uIslMaps, q), r = islTex(uIslReg, q);
  float nord = r.x, med = r.y, plat = r.z, volc = r.w, alp = clamp(1.0 - nord - med - plat - volc, 0.0, 1.0);
  float scree = m.z, calm = (1.0 - smoothstep(0.35, 0.85, m.y))*(1.0 - smoothstep(0.3, 0.65, m.x))*land;
  float gully = (0.5*nord + 0.75*med + 0.55*plat + 0.9*volc + 1.0*alp)*(1.0 - 0.5*scree);
  float branch = (0.9*nord + 0.9*med + 0.8*plat + 0.3*volc + 1.0*alp)*(1.0 - 0.8*scree);
  float d = 0.0;
  float amp = gully*smoothstep(0.05, 1.0, sl)*calm*(0.4 + 0.6*smoothstep(0.3, 0.7, vn(q/170.0 + vec2(4.1, 8.3))));
  if (amp > 0.0) {
    float r = clamp(-lap*20.0, -1.0, 1.0), a = 1.0; vec2 fl = vec2(0.0), u = g/(sl + 1e-6);
    for (int o = 0; o < 6; o++) {
      float c = c0*exp2(-float(o));
      if (c <= fw) break;
      vec2 G = g + 2.0*branch*sl*(fl - dot(fl, u)*u); float l = sqrt(dot(G, G) + 1e-4);
      vec2 t = vec2(-G.y, G.x)/l; vec3 gv = gullyOct(q/c, t, o); float k = 0.4*r*r;
      float v = gv.x + (r - gv.x)*k, dep = 0.1 + 0.9*smoothstep(0.06, 0.5, gv.z);
      d += tdetW(c, f)*amp*c*0.35*a*dep*(2.0*sqrt(max(0.5 + 0.5*v, 0.0) + 0.03) - 1.355);
      fl += a*dep*(1.0 - k)*gv.y*t;
      r = v; a *= o < 2 ? 0.55 : 0.8;
    }
  }
  float knob = nord*(1.0 - smoothstep(0.9, 1.5, sl))*calm*(0.25 + 0.75*smoothstep(0.35, 0.65, vn(q/260.0 + vec2(2.3, 6.7))));
  if (knob > 0.0) {
    float a = 1.0;
    for (int o = 0; o < 6; o++) {
      float c = c0*exp2(-float(o));
      if (c <= fw) break;
      d += tdetW(c, f)*knob*c*0.24*a*(knobOct(q/c, vec2(-0.78, -0.625), o) - 0.123);
      a *= 0.45;
    }
  }
  float ledge = (0.2*nord + 0.7*med + 1.0*plat + 0.6*volc + 0.25*alp)*max(m.w, smoothstep(0.3, 0.9, sl))*(1.0 - scree)*calm;
  if (ledge > 0.0) {
    float bed = 5.0*nord + 7.0*med + 8.0*plat + 10.0*volc + 6.0*alp;
    vec2 dip = vec2(0.03*med + 0.01*plat + 0.2*alp, 0.01*med - 0.005*plat + 0.08*alp), lg = g + dip;
    float P = bed/max(length(lg), 1e-3), w = tdetW(P/1.5, f);
    if (w > 0.0) {
      float zl = (hc + dip.x*q.x + dip.y*q.y)/bed, s = zl + 0.35*(vn(vec2(zl*0.43 + 3.7, 0.5)) - 0.5), fl = floor(s), sf = s - fl;
      float thr = 0.3 + 0.4*hash2(ivec2(int(fl), 9173)), hard = 0.35 + 0.65*hash2(ivec2(int(fl) + 7, 331));
      float lat = 0.3 + 0.7*smoothstep(0.3, 0.7, vn(q/97.0 + vec2(1.3, 7.9)));
      float hw = min(max(0.15, minWave/P), min(thr, 1.0 - thr));
      d += ledge*w*bed*hard*lat*(smoothstep(thr - hw, thr + hw, sf) - sf);
    }
  }
  return d;
}
// ── sub-mesh detail, for the terrain's fragment shader (shading only, so no JS twin) ──
// The gully octaves of terrainDetail() that no mesh carries (4 m and finer), continued down to 1 m: rills on soil, scree
// and ash, as a slope to add to the surface's like a bump map. The mesh's own normal steers them: its fall line already
// carries the coarser grooves, so the rills branch into those as the geometric octaves do. They fade as they shrink
// below the pixel, so nothing shimmers, and out across the finest mesh's morph ring (~0.55–0.9 km), where
// terrainDetail()'s distance fade takes the 8 and 16 m octaves away too.
//   q: world xz; n: the interpolated vertex normal (normalised); geoWave: the minWave the vertex heights were filtered
//   at (vGeoWave from the terrain vertex shader); fp: the pixel footprint (m); maps, regions: islandMaps(q), islandRegions(q)
//   → (dh/dx, dh/dz, groove −1 … rib +1). Use: n' = normalize(vec3(n.x/n.y − s.x, 1, n.z/n.y − s.y)), weighted by the
//   ground's softness (rills cut soil, scree and ash, not bare rock or snow).
// a cheap octave of rills for the octaves no mesh ever carries (≤ 4 m): each lattice corner lays stripes across t with
// its own random phase, measured from the corner (so turning t never swings stripes far away), blended bilinearly as
// phase vectors: 4 hashes and 3 sine/cosine pairs instead of gullyOct's 9 cells → (cos, sin) of the stripe
vec2 rillOct(vec2 p, vec2 t, int o){
  vec2 ip = floor(p), f = p - ip, w = f*f*(3.0 - 2.0*f);
  ivec2 b = ivec2(ip); int so = 31337 + 7919*o;
  float ax = -6.2831853*t.x, az = -6.2831853*t.y, th = 6.2831853*dot(f, t);
  vec2 ex = vec2(cos(ax), sin(ax)), ez = vec2(cos(az), sin(az)), acc = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    int kx = k & 1, kz = k >> 1;
    uint hh = hash2u(b + ivec2(kx, kz + so));
    vec2 v = vec2(float(hh & 255u), float((hh >> 8u) & 255u)) - 127.5;
    v /= length(v) + 1.0;                                             // the corner's phase e^{iφ}
    if (kx == 1) v = vec2(v.x*ex.x - v.y*ex.y, v.x*ex.y + v.y*ex.x);  // × e^{−2πi t·(1,0)}
    if (kz == 1) v = vec2(v.x*ez.x - v.y*ez.y, v.x*ez.y + v.y*ez.x);  // × e^{−2πi t·(0,1)}
    acc += v*(kx == 1 ? w.x : 1.0 - w.x)*(kz == 1 ? w.y : 1.0 - w.y);
  }
  vec2 s = vec2(cos(th), sin(th)), r = acc/sqrt(dot(acc, acc) + 0.02);
  return vec2(s.x*r.x - s.y*r.y, s.x*r.y + s.y*r.x);
}
vec3 terrainDetailFrag(vec2 q, vec3 n, float geoWave, float fp, vec4 maps, vec4 regions){
  vec2 g = -n.xz/max(n.y, 0.2);
  float sl = length(g);
  float nord = regions.x, med = regions.y, plat = regions.z, volc = regions.w, alp = clamp(1.0 - nord - med - plat - volc, 0.0, 1.0);
  float scree = maps.z, calm = (1.0 - smoothstep(0.35, 0.85, maps.y))*(1.0 - smoothstep(0.3, 0.65, maps.x));
  float gully = (0.5*nord + 0.75*med + 0.55*plat + 0.9*volc + 1.0*alp)*(1.0 - 0.5*scree);
  float branch = (0.9*nord + 0.9*med + 0.8*plat + 0.3*volc + 1.0*alp)*(1.0 - 0.8*scree);
  float amp = gully*smoothstep(0.05, 1.0, sl)*calm*(0.4 + 0.6*smoothstep(0.3, 0.7, vn(q/170.0 + vec2(4.1, 8.3)))), near = 1.0 - smoothstep(TDET_MINWAVE, 2.0*TDET_MINWAVE, geoWave), c0 = tdetC0(), a = 1.0, sw = 1e-4;
  vec3 res = vec3(0.0); vec2 fl = vec2(0.0), u = g/(sl + 1e-6);
  if (amp <= 0.0 || near <= 0.0) return res;
  for (int o = 0; o < 8; o++) {
    float c = c0*exp2(-float(o));
    float wp = 1.0 - smoothstep(0.25*c, 0.5*c, fp);
    if (c < 0.9 || wp <= 0.0) break;
    if (c <= TDET_MINWAVE) {
      vec2 G = g + 2.0*branch*sl*(fl - dot(fl, u)*u); float l = sqrt(dot(G, G) + 1e-4);
      vec2 t = vec2(-G.y, G.x)/l, gv = rillOct(q/c, t, o);
      // the V's kink rounded to the pixel, so a groove's floor never flips the slope inside one pixel
      float s0 = sqrt(max(0.5 + 0.5*gv.x, 0.0) + 0.03 + 22.0*(fp/c)*(fp/c)), w = near*wp;
      res.xy += w*amp*c*0.35*a*0.65*(0.5/s0)*(6.2831853*gv.y/c)*t;
      res.z += w*a*(2.0*s0 - 1.355); sw += w*a;
      fl += a*0.65*gv.y*t;
    }
    a *= o < 2 ? 0.55 : 0.8;
  }
  res.z /= sw;
  return res;
}
float terrainH(vec2 q, float minWave){
  if (uHeightP.w < 0.5) return terrainHProc(q, minWave);
  float texel = 1.0/uHeightP.y;
  bool fine = minWave <= texel*1.5;
  float coarse = fine ? 0.0 : hmLod(q, log2(minWave/(texel*1.5)));
  if (tdetFade(max(minWave, TDET_MINWAVE)).x < tdetC0()) {  // the detail (and, on the fine path, the height) from one 6×6 window
    float hc; vec4 nb; hmCross(q, hc, nb);
    return (fine ? hc : coarse) + terrainDetail(q, minWave, hc, nb);
  }
  return fine ? hmCubic(q) : coarse;
}
// Lighting is scene-linear HDR. Colours authored in the code are sRGB and go through toLin() before lighting.
// uSunCol = sun irradiance/π at the camera, uAmb = sky irradiance/π on an up-facing surface,
// uZen / uHor = sky radiance at the zenith / mean horizon; all from the atmosphere model (ATMOS).
uniform vec3 uSun, uSunCol, uZen, uHor, uAmb, uCam;
uniform float uFog, uTime;
uniform sampler2D uSkyLut; uniform mediump sampler3D uApLut;
uniform vec4 uAtm; // (1/width, 1/height, aerial-perspective distance scale, camera altitude km)
vec3 toLin(vec3 c){ return pow(max(c, vec3(0.0)), vec3(2.2)); }
// sky-view LUT (sun at azimuth 0, horizon-concentrated latitude mapping, Hillaire 2020)
vec3 skyCol(vec3 d){
  const float PI_ = 3.14159265, Rg_ = 6360.0;
  float r = Rg_ + uAtm.w;
  float vH = sqrt(max(r*r - Rg_*Rg_, 0.0)), beta = acos(clamp(vH/r, -1.0, 1.0)), zh = PI_ - beta;
  float zen = acos(clamp(d.y, -1.0, 1.0)), v;
  if (zen < zh) { float c = zen/zh; v = 0.5*(1.0 - sqrt(max(1.0 - c, 0.0))); }
  else { float c = (zen - zh)/beta; v = 0.5 + 0.5*sqrt(max(c, 0.0)); }
  vec2 sh = normalize(uSun.xz + vec2(1e-5, 0.0));
  float az = atan(d.z, d.x) - atan(sh.y, sh.x);
  return texture(uSkyLut, vec2(fract(az/(2.0*PI_) + 0.5), clamp(v, 0.004, 0.996))).rgb;
}
#ifdef FRAG
// aerial perspective from the froxel volume: in-scattered light added, transmittance multiplied
vec4 aerial(float distM){
  float s = sqrt(clamp(distM*uAtm.z*(1.0/${ATMOS_AP_RANGE_M}.0), 0.0, 1.0));
  vec4 a = texture(uApLut, vec3(gl_FragCoord.xy*uAtm.xy, s));
  float w = clamp(s*${ATMOS_AP_SLICES}.0, 0.0, 1.0);
  return vec4(a.rgb*w, mix(1.0, a.a, w));
}
vec3 fogIt(vec3 col, vec3 rel){ vec4 a = aerial(length(rel)); return col*a.a + a.rgb; }
// ── cloud shadows: the clouds' weather map (CLOUDS), looked up where the sun ray meets the cloud ──
uniform sampler2D uCloudMap; uniform vec4 uMapP; // map origin x, z, 1/size, enabled
float cloudShadow(vec3 rel){
  if (uMapP.w < 0.5 || uSun.y < 0.02) return 1.0;
  vec3 p = rel + uCam;
  float h = 1250.0;
  for (int k = 0; k < 2; k++) { // project to a typical cloud height, then to the height of the cloud found there
    vec3 q = p + uSun*max(h - p.y, 0.0)/uSun.y;
    vec2 uv = (q.xz - uMapP.xy)*uMapP.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
    vec4 m = textureLod(uCloudMap, uv, 0.0);
    if (m.r < 0.01) return 1.0;
    float top = m.g*8000.0, base = (1.0 - m.b)*8000.0;
    base = mix(base, m.a*8000.0, smoothstep(120.0, 300.0, m.a*8000.0 - base)); // no pillars under high clouds (as the clouds do)
    if (k == 1) return exp(-m.r*max(top - base, 0.0)*0.011);
    h = 0.5*(top + base);
  }
  return 1.0;
}
// ── sun shadows (SHADOW): cascaded maps in a depth array, hardware-filtered comparisons ──
uniform mediump sampler2DArrayShadow uShadowMap;
uniform mat4 uCasM[5]; uniform vec4 uCasP[5]; // matrix (camera-relative at render), (camera moved since, texel m)
uniform vec4 uShadowP; // (cascades, pcf taps, enabled, -)
float gShadow = 1.0;   // set by a fragment shader before lightMesh(): sun visibility at this pixel
float shadowTaps(int i, vec3 sc){
  float t = 1.0/float(textureSize(uShadowMap, 0).x);
  if (uShadowP.y < 2.0) return texture(uShadowMap, vec4(sc.xy, float(i), sc.z));
  if (uShadowP.y < 5.0) { // 4 bilinear taps: a smooth 3×3-texel footprint
    return 0.25*(texture(uShadowMap, vec4(sc.xy + vec2(-0.5, -0.5)*t, float(i), sc.z)) + texture(uShadowMap, vec4(sc.xy + vec2(0.5, -0.5)*t, float(i), sc.z))
               + texture(uShadowMap, vec4(sc.xy + vec2(-0.5, 0.5)*t, float(i), sc.z)) + texture(uShadowMap, vec4(sc.xy + vec2(0.5, 0.5)*t, float(i), sc.z)));
  }
  float s = 0.0; // 9 bilinear taps with tent weights: a soft 5×5-texel penumbra
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    float w = (2.0 - abs(float(x)))*(2.0 - abs(float(y)));
    s += w*texture(uShadowMap, vec4(sc.xy + vec2(float(x), float(y))*t*1.2, float(i), sc.z));
  }
  return s/16.0;
}
// cascade i's shadow coordinate for a camera-relative position, with a normal offset that grows with texel size
vec3 shadowCoord(int i, vec3 rel, vec3 n, float nl){
  vec3 p = rel + uCasP[i].xyz + n*uCasP[i].w*(0.8 + 1.6*(1.0 - nl));
  return (uCasM[i]*vec4(p, 1.0)).xyz*0.5 + 0.5;
}
// sun visibility 0..1; casc returns the cascade used (99 = none)
float sunShadowMap(vec3 rel, vec3 n, out float casc);
float sunShadowC(vec3 rel, vec3 n, out float casc){ return sunShadowMap(rel, n, casc)*cloudShadow(rel); }
float sunShadowMap(vec3 rel, vec3 n, out float casc){
  casc = 99.0;
  if (uShadowP.z < 0.5 || uShadowP.x < 1.0) return 1.0;
  float nl = clamp(dot(n, uSun), 0.0, 1.0);
  int nc = int(uShadowP.x);
  for (int i = 0; i < 5; i++){
    if (i >= nc) break;
    vec3 sc = shadowCoord(i, rel, n, nl);
    vec2 e = abs(sc.xy - 0.5);
    float m = max(e.x, e.y);
    if (m < 0.485 && sc.z < 1.0) {
      casc = float(i);
      float s = shadowTaps(i, sc);
      float b = smoothstep(0.4, 0.485, m); // cross-fade into the next cascade near the edge
      if (b > 0.0) {
        float s2 = 1.0;
        if (i + 1 < nc) { vec3 sc2 = shadowCoord(i + 1, rel, n, nl); s2 = sc2.z < 1.0 ? shadowTaps(i + 1, sc2) : 1.0; }
        s = mix(s, s2, b);
      }
      return s;
    }
  }
  return 1.0;
}
float sunShadow(vec3 rel, vec3 n){ float c; return sunShadowC(rel, n, c); }
#endif
uniform float uShadowPass; // 1 while rendering shadow maps: fragment shaders return right after their discards
// ───── wind gusts: one field shared by everything that shows the wind (JS twin: GUST.field) ─────
// Patches of stronger air travel downwind a little faster than the mean wind (WORLD.WIND = (4.0, 0, 1.8) m/s, fixed
// here) and churn as they go: slow spells of gusty air and lulls (~900 m), domain-warped gust fronts (~130 m deep,
// ~210 m wide: they sweep across the land like waves) and smaller cat's-paws riding inside them at their own speed. The direction wobbles slowly (±16°) and veers in gusts.
const vec2 GUST_DIR = vec2(0.9119, 0.4104);        // normalize(WORLD.WIND.xz)
const float GUST_SPEED = 4.386, GUST_MEAN = 0.22;  // |WORLD.WIND| (m/s); mean gust strength over the field
// windGustField(xz, t): the analytic field → (strength 0..1, local wind speed m/s, wind direction xz).
// ~11 noise lookups: use windGust() / gustMap() below, which read it from the gust map, unless you need it off the map.
vec4 windGustField(vec2 xz, float t){
  vec2 q = vec2(dot(xz, GUST_DIR), dot(xz, vec2(-GUST_DIR.y, GUST_DIR.x))); // along / across the wind (m)
  float spell = vn(vec2((q.x - 4.4*t)*(1.0/900.0) + 3.7, q.y*(1.0/600.0) + 8.1));
  float af = q.x - 6.2*t;
  vec2 w = vec2(vn(vec2(af*(1.0/110.0) + 1.3, q.y*(1.0/150.0) + 5.2)), vn(vec2(af*(1.0/110.0) + 7.9, q.y*(1.0/150.0) + 2.4))) - 0.5;
  vec2 f = vec2(af, q.y) + w*80.0;
  float front = vn(f*vec2(1.0/130.0, 1.0/210.0) + vec2(9.2, 2.6))*0.68
              + vn(vec2(f.x*0.8 + f.y*0.6, f.y*0.8 - f.x*0.6)*vec2(1.0/55.0, 1.0/88.0) + vec2(3.1, 6.3))*0.32;
  float thr = 0.55 - 0.22*spell;
  float fm = smoothstep(thr, thr + 0.3, front);
  vec2 pp = vec2(q.x - 8.6*t + w.x*30.0, q.y + 1.3*t + w.y*20.0);
  float paw = vn(vec2(pp.x*0.87 + pp.y*0.5, pp.y*0.87 - pp.x*0.5)*vec2(1.0/28.0, 1.0/40.0) + vec2(4.4, 0.7))*0.62
            + vn(vec2(pp.x*0.87 - pp.y*0.5, pp.y*0.87 + pp.x*0.5)*vec2(1.0/12.0, 1.0/18.0) + vec2(1.9, 5.1))*0.38;
  float g = min(fm*(0.4 + 0.9*paw), 1.0);
  float veer = (vn(vec2((q.x - 3.0*t)*(1.0/650.0) + 6.6, q.y*(1.0/650.0) + 1.9)) - 0.5)*0.55 + (paw - 0.5)*0.35*g;
  vec2 d = GUST_DIR*cos(veer) + vec2(-GUST_DIR.y, GUST_DIR.x)*sin(veer);
  return vec4(g, GUST_SPEED*(0.6 + 0.9*g), d);
}
// The gust map: SCENERY renders windGustField around the camera every frame; any program that calls these gets the
// map's sampler and uniforms from setEnv automatically (vertex or fragment shaders). Off the map: the calm mean.
uniform sampler2D uGustMap; uniform vec4 uGustP; // map origin x, z, 1/size (1/m), enabled
// → (bend 0..1, strength 0..1, wind direction xz). bend is the gust as grass and branches feel it: they lean in quickly
// and spring back more slowly, so a gust leaves a soft wake behind its sharp front.
vec4 gustMap(vec2 xz){
  const vec4 calm = vec4(GUST_MEAN, GUST_MEAN, GUST_DIR);
  if (uGustP.w < 0.5) return calm;
  vec2 uv = (xz - uGustP.xy)*uGustP.z, e = abs(uv - 0.5);
  float edge = smoothstep(0.42, 0.5, max(e.x, e.y));
  return edge >= 1.0 ? calm : mix(textureLod(uGustMap, uv, 0.0), calm, edge);
}
// windGust(xz): the wind here, now → .xy local wind direction (unit, xz plane), .z gust strength 0..1 (0 lull, ~0.2 mean,
// 1 gust core). Local wind speed ≈ GUST_SPEED*(0.6 + 0.9*strength) m/s. One texture fetch.
vec3 windGust(vec2 xz){ vec4 m = gustMap(xz); return vec3(normalize(m.zw + vec2(1e-5, 0.0)), m.y); }
// windBend(xz): how far grass and branches are leaning with the gust right now (0..1)
float windBend(vec2 xz){ return gustMap(xz).x; }
`;

// ── small math ──
const Q = {
  mul(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  },
  rot(out, q, x, y, z) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + qy * tz - qz * ty;
    out[1] = y + qw * ty + qz * tx - qx * tz;
    out[2] = z + qw * tz + qx * ty - qy * tx;
    return out;
  },
  axis(out, x, y, z, a) { const s = Math.sin(a / 2); out[0] = x * s; out[1] = y * s; out[2] = z * s; out[3] = Math.cos(a / 2); return out; },
  norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q; },
  // integrate world-space angular velocity w over dt
  spin(q, wx, wy, wz, dt) {
    const x = q[0], y = q[1], z = q[2], w = q[3], h = 0.5 * dt;
    q[0] += h * (wx * w + wy * z - wz * y);
    q[1] += h * (wy * w + wz * x - wx * z);
    q[2] += h * (wz * w + wx * y - wy * x);
    q[3] += h * (-wx * x - wy * y - wz * z);
    return Q.norm(q);
  },
  fromBasis(out, r, u, b) { // columns r,u,b (b = backward)
    const m00 = r[0], m01 = u[0], m02 = b[0], m10 = r[1], m11 = u[1], m12 = b[1], m20 = r[2], m21 = u[2], m22 = b[2];
    const tr = m00 + m11 + m22;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; out[3] = 0.25 * s; out[0] = (m21 - m12) / s; out[1] = (m02 - m20) / s; out[2] = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s; }
    return Q.norm(out);
  },
  slerp(out, a, b, t) {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let k0 = 1 - t, k1 = t;
    if (d < 0.9995) { const o = Math.acos(d), s = Math.sin(o); k0 = Math.sin(k0 * o) / s; k1 = Math.sin(t * o) / s; }
    out[0] = a[0] * k0 + bx * k1; out[1] = a[1] * k0 + by * k1; out[2] = a[2] * k0 + bz * k1; out[3] = a[3] * k0 + bw * k1;
    return Q.norm(out);
  },
};
const M4 = {
  persp(out, fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = t / aspect; out[5] = t; out[10] = (f + n) / (n - f); out[11] = -1; out[14] = 2 * f * n / (n - f);
    return out;
  },
  // camera-relative view rotation from basis (r,u,f)
  view(out, r, u, f) {
    out.fill(0);
    out[0] = r[0]; out[4] = r[1]; out[8] = r[2];
    out[1] = u[0]; out[5] = u[1]; out[9] = u[2];
    out[2] = -f[0]; out[6] = -f[1]; out[10] = -f[2];
    out[15] = 1;
    return out;
  },
  mul(out, a, b) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  },
  // general inverse (cofactors); out must not alias m
  inv(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const d = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
    return out;
  },
};

// ── GL ──
const GLX = (() => {
  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: true, stencil: false, // the scene renders into POST's own multisampled HDR target
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  function sh(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.error(log, src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
      throw new Error(log);
    }
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, HEAD + vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + '#define FRAG\n' + fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  function buffer(data, target, usage) {
    const b = gl.createBuffer();
    gl.bindBuffer(target || gl.ARRAY_BUFFER, b);
    gl.bufferData(target || gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
    return b;
  }
  // attribs: [[loc, size, stride, offset, divisor]]
  function attribs(buf, list) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, size, stride, off, div] of list) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
      gl.vertexAttribDivisor(loc, div || 0);
    }
  }
  // shared per-frame environment uniforms
  const env = {
    sun: new Float32Array([0.5, 0.55, -0.6]), sunCol: new Float32Array(3), zen: new Float32Array(3),
    hor: new Float32Array(3), amb: new Float32Array(3), cam: new Float32Array(3), fog: 0.00012, time: 0,
    vp: new Float32Array(16), atm: new Float32Array([1, 1, 1, 0.1]), shadowPass: 0,
  };
  // texture units reserved for the atmosphere LUTs (bound once per frame by ATMOS)
  const UNIT_SKY = 15, UNIT_AP = 14;
  // the island heightfield: the 16-bit steps in an R16UI texture, bound once on its own unit, with a mip pyramid of 2×2
  // means made here (8192²: 128 MB + 43 MB; an R32F copy with mips would be 358 MB). A GPU that can't take the full size
  // gets the pyramid from the first level that fits (the ground then renders coarser than it collides).
  const UNIT_HEIGHT = 4, heightP = new Float32Array(4), heightQ = new Float32Array(2);
  if (typeof ISLAND !== 'undefined' && ISLAND) {
    gl.getExtension('OES_texture_float_linear'); gl.getExtension('EXT_color_buffer_float'); // (other modules' float targets count on these)
    const t = gl.createTexture(), max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.activeTexture(gl.TEXTURE0 + UNIT_HEIGHT); gl.bindTexture(gl.TEXTURE_2D, t);
    let lv = ISLAND.q, s = ISLAND.n, skip = 0;
    const halve = () => { // next pyramid level: rounded means of 2×2 steps
      const s2 = s >> 1, d = new Uint16Array(s2 * s2);
      for (let y = 0; y < s2; y++) for (let x = 0, a = 2 * y * s, b = a + s, o = y * s2; x < s2; x++, a += 2, b += 2) d[o + x] = (lv[a] + lv[a + 1] + lv[b] + lv[b + 1] + 2) >> 2;
      lv = d; s = s2;
    };
    while (s > max) { halve(); skip++; }
    if (skip) console.warn(`island heights: ${ISLAND.n}² is over this GPU's ${max} texture limit; rendering from ${s}²`);
    const levels = Math.floor(Math.log2(s)) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.R16UI, s, s);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    for (let l = 0; l < levels; l++) {
      if (l) halve();
      gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, s, s, gl.RED_INTEGER, gl.UNSIGNED_SHORT, lv);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
    const n = ISLAND.n >> skip;
    heightP.set([ISLAND.origin, n / ISLAND.size, n, 1]);
    heightQ.set([ISLAND.step, ISLAND.offset]);
  }
  const UNIT_MAPS = 16, UNIT_REG = 17, M = typeof window !== 'undefined' && window.ISLAND_MAPS;
  for (const [unit, n, data] of M ? [[UNIT_MAPS, M.nm, M.maps], [UNIT_REG, M.nr, M.regions]] : []) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, n, n);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
  }
  function setEnv(pr) {
    const u = pr.u;
    if (u.uSun) gl.uniform3fv(u.uSun, env.sun);
    if (u.uSunCol) gl.uniform3fv(u.uSunCol, env.sunCol);
    if (u.uZen) gl.uniform3fv(u.uZen, env.zen);
    if (u.uHor) gl.uniform3fv(u.uHor, env.hor);
    if (u.uAmb) gl.uniform3fv(u.uAmb, env.amb);
    if (u.uCam) gl.uniform3fv(u.uCam, env.cam);
    if (u.uFog) gl.uniform1f(u.uFog, env.fog);
    if (u.uTime) gl.uniform1f(u.uTime, env.time);
    if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, env.vp);
    if (u.uAtm) gl.uniform4fv(u.uAtm, env.atm);
    if (u.uSkyLut) gl.uniform1i(u.uSkyLut, UNIT_SKY);
    if (u.uApLut) gl.uniform1i(u.uApLut, UNIT_AP);
    if (u.uHeightP) { gl.uniform4fv(u.uHeightP, heightP); if (u.uHeight) gl.uniform1i(u.uHeight, UNIT_HEIGHT); if (u.uHeightQ) gl.uniform2fv(u.uHeightQ, heightQ); }
    if (u.uIslMaps) gl.uniform1i(u.uIslMaps, UNIT_MAPS);
    if (u.uIslReg) gl.uniform1i(u.uIslReg, UNIT_REG);
    if (u.uShadowPass) gl.uniform1f(u.uShadowPass, env.shadowPass);
    if (u.uShadowMap) { if (typeof SHADOW !== 'undefined') SHADOW.setEnvShadow(u); else gl.uniform4f(u.uShadowP, 0, 0, 0, 0); }
    if (u.uCloudMap) { if (typeof CLOUDS !== 'undefined') CLOUDS.setEnvClouds(u); else gl.uniform4f(u.uMapP, 0, 0, 0, 0); }
  }
  // GPU profiler (EXT_disjoint_timer_query_webgl2): prof.mark(name) closes the previous section and opens the next,
  // prof.frame() closes the last one. Results arrive a few frames later; prof.ms holds per-section medians over the last 60 frames.
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const prof = { on: false, ms: {}, samples: {}, total: 0, totals: [], pending: [], pool: [], open: null, frameList: [] };
  const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  prof.mark = name => {
    if (!prof.on || !tq) return;
    if (prof.open) gl.endQuery(tq.TIME_ELAPSED_EXT);
    const q = prof.pool.pop() || gl.createQuery();
    gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    prof.open = q; prof.frameList.push(name, q);
  };
  prof.frame = () => {
    if (!tq) return;
    if (prof.open) { gl.endQuery(tq.TIME_ELAPSED_EXT); prof.open = null; }
    if (prof.frameList.length) { prof.pending.push(prof.frameList); prof.frameList = []; }
    while (prof.pending.length) {
      const f = prof.pending[0], last = f[f.length - 1];
      if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) break;
      prof.pending.shift();
      const disjoint = gl.getParameter(tq.GPU_DISJOINT_EXT);
      let sum = 0;
      for (let i = 0; i < f.length; i += 2) {
        const ms = gl.getQueryParameter(f[i + 1], gl.QUERY_RESULT) / 1e6;
        prof.pool.push(f[i + 1]);
        if (disjoint) continue;
        const a = prof.samples[f[i]] || (prof.samples[f[i]] = []);
        a.push(ms); if (a.length > 60) a.shift();
        prof.ms[f[i]] = median(a);
        sum += ms;
      }
      if (!disjoint) { prof.totals.push(sum); if (prof.totals.length > 60) prof.totals.shift(); prof.total = median(prof.totals); }
    }
  };
  prof.reset = () => { prof.ms = {}; prof.samples = {}; prof.totals = []; prof.total = 0; };
  prof.report = () => Object.entries(prof.ms).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' | ') + ` || total ${prof.total.toFixed(3)} ms`;
  return { gl, canvas, program, buffer, attribs, env, setEnv, UNIT_SKY, UNIT_AP, prof };
})();

// ───── wind gusts: JS twin of windGustField() in GLSL_COMMON (same noise, same numbers) ─────
const GUST = (() => {
  const DX = 0.9119, DZ = 0.4104, SPEED = 4.386, MEAN = 0.22; // normalize(WORLD.WIND.xz), |WORLD.WIND|, mean strength
  // → out = [strength 0..1, local wind speed m/s, direction x, direction z]
  function field(x, z, t, out) {
    const qa = x * DX + z * DZ, qb = -x * DZ + z * DX;
    const spell = vn((qa - 4.4 * t) / 900 + 3.7, qb / 600 + 8.1);
    const af = qa - 6.2 * t;
    const wx = vn(af / 110 + 1.3, qb / 150 + 5.2) - 0.5, wz = vn(af / 110 + 7.9, qb / 150 + 2.4) - 0.5;
    const fa = af + wx * 80, fb = qb + wz * 80;
    const front = vn(fa / 130 + 9.2, fb / 210 + 2.6) * 0.68 + vn((fa * 0.8 + fb * 0.6) / 55 + 3.1, (fb * 0.8 - fa * 0.6) / 88 + 6.3) * 0.32;
    const thr = 0.55 - 0.22 * spell;
    const fm = ss(thr, thr + 0.3, front);
    const pa = qa - 8.6 * t + wx * 30, pb = qb + 1.3 * t + wz * 20;
    const paw = vn((pa * 0.87 + pb * 0.5) / 28 + 4.4, (pb * 0.87 - pa * 0.5) / 40 + 0.7) * 0.62
      + vn((pa * 0.87 - pb * 0.5) / 12 + 1.9, (pb * 0.87 + pa * 0.5) / 18 + 5.1) * 0.38;
    const g = Math.min(fm * (0.4 + 0.9 * paw), 1);
    const veer = (vn((qa - 3 * t) / 650 + 6.6, qb / 650 + 1.9) - 0.5) * 0.55 + (paw - 0.5) * 0.35 * g;
    const c = Math.cos(veer), s = Math.sin(veer);
    out[0] = g; out[1] = SPEED * (0.6 + 0.9 * g); out[2] = DX * c - DZ * s; out[3] = DZ * c + DX * s;
    return out;
  }
  // the gust map SCENERY renders around the camera: its texture unit and uniforms (origin x, z, 1/size, enabled)
  const map = { unit: 11, p: new Float32Array(4), bound: false, off: false };
  return { field, map, DX, DZ, SPEED, MEAN };
})();
// every program that reads the gust map (gustMap / windGust / windBend) gets its sampler and uniforms with the environment
if (GLX) {
  const base = GLX.setEnv, gl = GLX.gl;
  GLX.setEnv = pr => {
    base(pr);
    const u = pr.u;
    if (u.uGustMap) {
      if (!GUST.map.bound) { // no gust map yet (or none at all, e.g. the model viewer): park a 1×1 texture on the unit
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + GUST.map.unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([56, 56, 232, 105]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.activeTexture(gl.TEXTURE0);
        GUST.map.bound = true;
      }
      gl.uniform1i(u.uGustMap, GUST.map.unit); if (u.uGustP) gl.uniform4fv(u.uGustP, GUST.map.p);
    }
  };
}
