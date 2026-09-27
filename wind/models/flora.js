'use strict';
// ───────────────────────── Flora: storybook trees, bushes and meadow grass ─────────────────────────
// All geometry is procedural and built once at load. Species × variants:
//   broadleaf (oak, beech, linden) · fir (silver fir, spruce, young fir) · birch (single, clump, poplar) ·
//   bush (round, low box, blossom) + near-camera grass tufts and wildflowers.
// Every tree/bush variant has three LODs built from the same clump/tier layout: near (≤ ~2000 tris, < 110 m),
// mid (~300-470 tris: same clumps as 20-tri balls, < 300 m) and far (≤ ~250 tris: shrink-wrapped crown, < ~1300 m).
// Neighbouring LODs cross-fade with complementary dithering, so each pixel is covered by exactly one of them.
// Placement is deterministic (hash2 + terrain queries) on 128 m tiles cached around the camera and generated a few per
// frame. All instances live in one dynamic buffer that is rebuilt (per-tile frustum culled, per-instance LOD banded)
// only when the camera moves/turns noticeably or near tiles arrive. Grass uses 32 m tiles within ~75 m, near the ground.
// Own instanced shader (MESH.LIGHT lighting): wind sway + gusts matching the terrain's meadow waves, leaf flutter,
// per-instance tint, close-range leafy shading/silhouettes, grass coloured like the terrain beneath it.
// Vertex extra = (ao, sway, material, emissive); material: 0 wood, 1 leaf, 2 grass blade, 3 petal, 4 needles.
// Instance = (x, y, z, scale, rotY, tint (+2 = turning gold), seed, far fade distance).
const FLORA = (() => {
  const { gl, program, buffer, env, setEnv } = GLX;
  const ST = MESH.STRIDE, TAU = Math.PI * 2;

  // ───── small utilities ─────
  function mulberry(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hs = (x, z, s) => hash2((x + Math.imul(s, 7919)) | 0, (z + Math.imul(s, 104729)) | 0);
  const h3 = (x, y, z) => hash2((x + Math.imul(z, 7919)) | 0, (y + Math.imul(z, 3571)) | 0);
  function vn3(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const a = lerp(lerp(h3(ix, iy, iz), h3(ix + 1, iy, iz), fx), lerp(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), fx), fy);
    const b = lerp(lerp(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), fx), lerp(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), fx), fy);
    return lerp(a, b, fz);
  }
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function bezAt(p0, p1, p2, t) {
    const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1], a * p0[2] + b * p1[2] + c * p2[2]];
  }
  const bez = (p0, p1, p2, n) => { const o = []; for (let k = 0; k < n; k++) o.push(bezAt(p0, p1, p2, k / (n - 1))); return o; };

  // ───── geometry primitives ─────
  // icosphere (1 subdivision: 42 verts, 80 tris), wound CCW seen from outside
  const ICO = (() => {
    const t = (1 + Math.sqrt(5)) / 2;
    const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(nrm);
    const f0 = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const mid = new Map(), f = [];
    const m = (a, b) => {
      const k = a < b ? a * 1000 + b : b * 1000 + a;
      if (!mid.has(k)) { v.push(nrm(lerp3(v[a], v[b], 0.5))); mid.set(k, v.length - 1); }
      return mid.get(k);
    };
    for (const [a, b, c] of f0) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); f.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    const orient = F => {
      const [A, B, C] = F[0].map(i => v[i]);
      const n = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
      if (n[0] * A[0] + n[1] * A[1] + n[2] * A[2] < 0) for (const tri of F) { const x = tri[1]; tri[1] = tri[2]; tri[2] = x; }
    };
    orient(f); orient(f0);
    return { v, f, v0: v.slice(0, 12), f0 };
  })();

  // lumpy leaf clump: displaced icosphere (o.lo → plain 20-tri icosahedron for the mid LOD), radii r = [rx, ry, rz];
  // flat squashes the underside. The noise seed is drawn from rnd so near/mid versions of a clump match when
  // built from rngs in the same state.
  function blob(b, c, r, rnd, o) {
    o = o || {};
    const m = b.mark(), amp = o.amp != null ? o.amp : 0.2, fr = o.freq || 1.5, flat = o.flat || 0, sc = o.lo ? 1.07 : 1;
    const sx = rnd() * 40, sy = rnd() * 40, sz = rnd() * 40;
    for (const d of o.lo ? ICO.v0 : ICO.v) {
      const n1 = vn3(d[0] * fr + sx, d[1] * fr + sy, d[2] * fr + sz);
      const n2 = vn3(d[0] * fr * 2.4 + sy, d[1] * fr * 2.4 + sz, d[2] * fr * 2.4 + sx);
      const s = (1 + amp * ((n1 - 0.5) * 2 + (n2 - 0.5) * 0.7)) * sc;
      const fy = d[1] < 0 ? 1 - flat : 1;
      b.vert([c[0] + d[0] * r[0] * s, c[1] + d[1] * r[1] * s * fy, c[2] + d[2] * r[2] * s], d, [1, 1, 1], [1, 0, 1, 0]);
    }
    for (const f of o.lo ? ICO.f0 : ICO.f) b.tri(m.v + f[0], m.v + f[1], m.v + f[2]);
    b.smooth(m);
    return m;
  }
  // UV sphere with single-vertex poles (no degenerate triangles); radius(dir) gives the surface distance
  function sphere(b, c, seg, st, radius) {
    const m = b.mark();
    const P = d => { const r = radius(d); return [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r]; };
    const bot = b.vert(P([0, -1, 0]), [0, -1, 0], [1, 1, 1], [1, 0, 1, 0]);
    for (let k = 1; k < st; k++) {
      const phi = -Math.PI / 2 + k / st * Math.PI;
      for (let s = 0; s < seg; s++) {
        const th = s / seg * TAU, d = [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)];
        b.vert(P(d), d, [1, 1, 1], [1, 0, 1, 0]);
      }
    }
    const top = b.vert(P([0, 1, 0]), [0, 1, 0], [1, 1, 1], [1, 0, 1, 0]);
    const R0 = bot + 1;
    for (let s = 0; s < seg; s++) b.tri(bot, R0 + s, R0 + (s + 1) % seg);
    for (let k = 0; k < st - 2; k++) for (let s = 0; s < seg; s++) {
      const a = R0 + k * seg + s, bb = R0 + k * seg + (s + 1) % seg;
      b.quad(a, a + seg, bb + seg, bb);
    }
    const RL = R0 + (st - 2) * seg;
    for (let s = 0; s < seg; s++) b.tri(top, RL + (s + 1) % seg, RL + s);
    b.smooth(m);
    return m;
  }
  // distance from C along unit dir d to the far surface of a union of ellipsoids {c, rr:[rx,ry,rz]}
  function unionRadius(C, clumps, d, fallback) {
    let best = 0;
    for (const k of clumps) {
      const ox = (k.c[0] - C[0]) / k.rr[0], oy = (k.c[1] - C[1]) / k.rr[1], oz = (k.c[2] - C[2]) / k.rr[2];
      const dx = d[0] / k.rr[0], dy = d[1] / k.rr[1], dz = d[2] / k.rr[2];
      const A = dx * dx + dy * dy + dz * dz, Bq = dx * ox + dy * oy + dz * oz, Cq = ox * ox + oy * oy + oz * oz - 1;
      const disc = Bq * Bq - A * Cq;
      if (disc < 0) continue;
      const t = (Bq + Math.sqrt(disc)) / A;
      if (t > best) best = t;
    }
    return best > 0 ? best : fallback;
  }
  // trunk made of horizontal rings: levels (y list), center(y) → [x, z], rad(y), shape(a, y, s) multiplier,
  // color(a, y, s) → rgb, ex(a, y) → extra
  function trunk(b, o) {
    const rings = [];
    for (const y of o.levels) {
      const c = o.center(y), r = o.rad(y), ring = [];
      for (let s = 0; s < o.sides; s++) {
        const a = s / o.sides * TAU, k = r * o.shape(a, y, s);
        ring.push([c[0] + Math.cos(a) * k, y, c[1] + Math.sin(a) * k]);
      }
      rings.push(ring);
    }
    return b.rings(rings, {
      closed: true, flip: true,
      color: (u, v, p) => o.color(u * TAU, p[1], Math.round(u * o.sides) % o.sides),
      ex: (u, v, p) => o.ex(u * TAU, p[1]),
    });
  }
  // canopy shading. Each clump reads as a soft ball lit from above (its own top light/warm, underside cool/dark),
  // nested in the crown volume (crown top brighter, interior darker). Normals blend the lumpy surface, the clump
  // sphere and the crown ellipsoid so light wraps softly. AO is baked from depth in the crown and from clump
  // faces turned inward. Sway rises from the crown core to its outside. o.clump = {c, rr} (null → far shell).
  function shadeLeaves(b, m, cv, pal, o) {
    const v = b.v, jit = o.jit || [1, 1, 1], seed = o.seed || 0, lc = o.clump || null;
    const s0 = o.sway0 != null ? o.sway0 : 0.4, s1 = o.sway1 != null ? o.sway1 : 1, aoMin = o.aoMin != null ? o.aoMin : 0.3;
    const mat = o.mat || 1, dark = o.far || 0, wG = lc ? 0.25 : 0.35, wL = lc ? 0.4 : 0, wE = lc ? 0.35 : 0.65;
    for (let k = m.v; k < b.count; k++) {
      const q = k * ST, px = v[q], py = v[q + 1], pz = v[q + 2];
      const qx = (px - cv.c[0]) / cv.r[0], qy = (py - cv.c[1]) / cv.r[1], qz = (pz - cv.c[2]) / cv.r[2];
      const rad = Math.hypot(qx, qy, qz) + 1e-6;
      let ex = qx / cv.r[0], ey = qy / cv.r[1], ez = qz / cv.r[2];
      const el = Math.hypot(ex, ey, ez) + 1e-9; ex /= el; ey /= el; ez /= el;
      let lx = ex, ly = ey, lz = ez;
      if (lc) {
        lx = (px - lc.c[0]) / (lc.rr[0] * lc.rr[0]); ly = (py - lc.c[1]) / (lc.rr[1] * lc.rr[1]); lz = (pz - lc.c[2]) / (lc.rr[2] * lc.rr[2]);
        const ll = Math.hypot(lx, ly, lz) + 1e-9; lx /= ll; ly /= ll; lz /= ll;
      }
      const gx = v[q + 3], gy = v[q + 4], gz = v[q + 5];
      const nx = gx * wG + lx * wL + ex * wE, ny = gy * wG + ly * wL + ey * wE + (lc ? 0 : 0.35), nz = gz * wG + lz * wL + ez * wE;
      const nl = Math.hypot(nx, ny, nz) + 1e-9;
      v[q + 3] = nx / nl; v[q + 4] = ny / nl; v[q + 5] = nz / nl;
      const out = lx * ex + ly * ey + lz * ez, hy = clamp(qy * 0.5 + 0.5, 0, 1), lh = lc ? ly * 0.5 + 0.5 : 0.4 + 0.45 * (ey * 0.5 + 0.5), deep = ss(0.2, 0.95, rad);
      const L = clamp(0.05 + 0.36 * hy + 0.3 * lh + 0.2 * Math.max(out, 0) * deep - 0.26 * (1 - deep) - dark, 0, 1);
      let c = L < 0.5 ? mix3(pal.deep, pal.mid, L * 2) : mix3(pal.mid, pal.light, L * 2 - 1);
      c = mix3(c, pal.warm, ss(0.5, 1, hy) * ss(0.45, 1, lh) * deep * 0.45);
      const dn = 0.88 + 0.24 * vn3(px * 0.55 + seed, py * 0.55, pz * 0.55 - seed);
      v[q + 6] = c[0] * dn * jit[0]; v[q + 7] = c[1] * dn * jit[1]; v[q + 8] = c[2] * dn * jit[2];
      v[q + 9] = (aoMin + (1 - aoMin) * deep) * (0.62 + 0.38 * clamp(out * 0.5 + 0.5, 0, 1)) * (0.74 + 0.26 * lh);
      v[q + 10] = s0 + (s1 - s0) * ss(0.2, 1.0, rad);
      v[q + 11] = mat; v[q + 12] = 0;
    }
  }
  function boundsOf(clumps) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const k of clumps) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], k.c[a] - k.rr[a]); hi[a] = Math.max(hi[a], k.c[a] + k.rr[a]); }
    return { lo, hi, cv: { c: lerp3(lo, hi, 0.5), r: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] } };
  }
  // blossom tint over the upper part of a coarse LOD (stands in for the individual flowers)
  function bloomTint(b, m, col, y0, y1, amt) {
    b.each(m, o => {
      const v = b.v, t = ss(y0, y1, v[o + 1]) * amt;
      if (t <= 0) return;
      const c = mix3([v[o + 6], v[o + 7], v[o + 8]], col, t);
      v[o + 6] = c[0]; v[o + 7] = c[1]; v[o + 8] = c[2]; v[o + 12] = 0.05 * t; v[o + 9] = lerp(v[o + 9], 0.9, t);
    });
  }
  // far-LOD canopy for loose crowns: k-means the clumps into G groups, shrink-wrap a small sphere onto each group
  function farClusters(b, clumps, G, seg, st, cv, pal, o) {
    const cen = [clumps[0].c.slice()];
    while (cen.length < G) { // farthest-point seeding
      let best = null, bd = -1;
      for (const k of clumps) { let d = 1e9; for (const c of cen) d = Math.min(d, dist(c, k.c)); if (d > bd) { bd = d; best = k; } }
      cen.push(best.c.slice());
    }
    let groups = [];
    for (let it = 0; it < 8; it++) {
      groups = cen.map(() => []);
      for (const k of clumps) { let bi = 0, bd = 1e9; cen.forEach((c, i) => { const d = dist(c, k.c); if (d < bd) { bd = d; bi = i; } }); groups[bi].push(k); }
      groups.forEach((g, i) => {
        if (!g.length) return;
        let w = 0; const m = [0, 0, 0];
        for (const k of g) { const kw = k.rr[0] * k.rr[1] * k.rr[2]; w += kw; for (let a = 0; a < 3; a++) m[a] += k.c[a] * kw; }
        cen[i] = [m[0] / w, m[1] / w, m[2] / w];
      });
    }
    groups.forEach((g, i) => {
      if (!g.length) return;
      let rm = 0;
      for (const k of g) rm += (k.rr[0] + k.rr[1] + k.rr[2]) / 3 / g.length;
      const m = sphere(b, cen[i], seg, st, d => Math.max(unionRadius(cen[i], g, d, 0), rm * 0.85));
      shadeLeaves(b, m, cv, pal, o);
    });
  }
  // little star-shaped blossom facing direction d (single sided, outward)
  function blossom(b, p, d, size, col, eye, sway) {
    const t1 = nrm(cross(Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], d)), t2 = cross(d, t1);
    const n = nrm([d[0], d[1] + 0.5, d[2]]), c0 = b.count;
    b.vert([p[0] + d[0] * size * 0.25, p[1] + d[1] * size * 0.25, p[2] + d[2] * size * 0.25], n, eye, [1, sway, 3, 0.25]);
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * TAU, r = k % 2 ? size * 0.45 : size;
      b.vert([p[0] + (t1[0] * Math.cos(a) + t2[0] * Math.sin(a)) * r, p[1] + (t1[1] * Math.cos(a) + t2[1] * Math.sin(a)) * r, p[2] + (t1[2] * Math.cos(a) + t2[2] * Math.sin(a)) * r],
        n, col, [1, sway, 3, 0.12]);
    }
    for (let k = 0; k < 10; k++) b.tri(c0, c0 + 1 + (k + 1) % 10, c0 + 1 + k);
    // make it face outward whatever the basis handedness
    const i = b.i.length - 3, A = b.v.slice(b.i[i] * ST, b.i[i] * ST + 3), B = b.v.slice(b.i[i + 1] * ST, b.i[i + 1] * ST + 3), C = b.v.slice(b.i[i + 2] * ST, b.i[i + 2] * ST + 3);
    const fn = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    if (fn[0] * d[0] + fn[1] * d[1] + fn[2] * d[2] < 0) for (let t = i - 27; t <= i; t += 3) { const x = b.i[t + 1]; b.i[t + 1] = b.i[t + 2]; b.i[t + 2] = x; }
  }

  // ───── palettes ─────
  const PAL = {
    oak: { deep: [0.06, 0.17, 0.09], mid: [0.18, 0.37, 0.12], light: [0.42, 0.58, 0.17], warm: [0.64, 0.68, 0.24] },
    beech: { deep: [0.07, 0.19, 0.08], mid: [0.23, 0.43, 0.12], light: [0.5, 0.64, 0.19], warm: [0.72, 0.73, 0.28] },
    linden: { deep: [0.05, 0.16, 0.1], mid: [0.15, 0.36, 0.15], light: [0.36, 0.56, 0.2], warm: [0.58, 0.66, 0.27] },
    fir: { deep: [0.04, 0.11, 0.075], mid: [0.09, 0.245, 0.15], light: [0.2, 0.4, 0.22], warm: [0.38, 0.5, 0.22] },
    spruce: { deep: [0.035, 0.1, 0.09], mid: [0.08, 0.21, 0.17], light: [0.18, 0.35, 0.27], warm: [0.34, 0.46, 0.27] },
    yfir: { deep: [0.045, 0.13, 0.075], mid: [0.11, 0.28, 0.15], light: [0.26, 0.45, 0.22], warm: [0.44, 0.55, 0.22] },
    birch: { deep: [0.09, 0.22, 0.07], mid: [0.28, 0.48, 0.13], light: [0.58, 0.72, 0.24], warm: [0.78, 0.8, 0.34] },
    poplar: { deep: [0.05, 0.16, 0.08], mid: [0.16, 0.38, 0.13], light: [0.4, 0.58, 0.19], warm: [0.58, 0.66, 0.28] },
    bush: { deep: [0.05, 0.16, 0.07], mid: [0.18, 0.4, 0.12], light: [0.42, 0.6, 0.19], warm: [0.62, 0.68, 0.25] },
    box: { deep: [0.05, 0.15, 0.08], mid: [0.15, 0.35, 0.14], light: [0.35, 0.53, 0.2], warm: [0.52, 0.6, 0.25] },
    bloom: { deep: [0.06, 0.17, 0.08], mid: [0.2, 0.41, 0.14], light: [0.45, 0.62, 0.21], warm: [0.64, 0.7, 0.27] },
  };
  const BARK = {
    oak: { base: [0.36, 0.27, 0.2], dark: [0.17, 0.12, 0.09], light: [0.5, 0.42, 0.33], moss: [0.27, 0.34, 0.13] },
    beech: { base: [0.5, 0.5, 0.47], dark: [0.3, 0.29, 0.27], light: [0.62, 0.62, 0.58], moss: [0.3, 0.38, 0.16] },
    linden: { base: [0.33, 0.26, 0.2], dark: [0.16, 0.12, 0.09], light: [0.46, 0.38, 0.3], moss: [0.26, 0.33, 0.13] },
    fir: { base: [0.33, 0.22, 0.16], dark: [0.16, 0.1, 0.08], light: [0.46, 0.33, 0.24], moss: [0.25, 0.3, 0.12] },
    birch: { base: [0.9, 0.88, 0.82], dark: [0.12, 0.11, 0.1], light: [0.97, 0.96, 0.92], moss: [0.3, 0.27, 0.23] },
    poplar: { base: [0.66, 0.66, 0.58], dark: [0.2, 0.19, 0.17], light: [0.78, 0.78, 0.7], moss: [0.32, 0.3, 0.22] },
    twig: { base: [0.3, 0.26, 0.23], dark: [0.16, 0.13, 0.12], light: [0.4, 0.35, 0.3], moss: [0.3, 0.3, 0.2] },
  };

  // ───── species builders (each returns { N (near), M (mid), F (far), top, width, coll }) ─────
  function broadleaf(seed, P) {
    const rnd = mulberry(seed), N = new MESH.Builder(), M = new MESH.Builder(), F = new MESH.Builder();
    const cr = P.crown, tr = P.trunkR, bark = P.bark, pal = P.pal;
    const C = [P.lean[0], P.H - cr[1], P.lean[1]];
    const split = C[1] - cr[1] * P.fork;
    const fork = [P.lean[0] * 0.5, split, P.lean[1] * 0.5];
    const rAvg = (cr[0] + cr[1] + cr[2]) / 3;
    // leaf clumps: a crowning clump + clumps on a jittered spiral over the upper crown shell (+ an inner filler)
    const mk = (c, r, flat) => ({ c, r, rr: [r, r * 0.88, r], flat });
    const clumps = [mk([C[0] + (rnd() - 0.5) * cr[0] * 0.2, C[1] + cr[1] * 0.5, C[2] + (rnd() - 0.5) * cr[2] * 0.2], rAvg * P.cs * 1.05, 0.2)];
    const nS = P.clumps - 2, ga = Math.PI * (3 - Math.sqrt(5)), ph0 = rnd() * TAU;
    for (let q = 0; q < nS; q++) {
      const u = 0.6 - 1.05 * (q + 0.5) / nS + (rnd() - 0.5) * 0.1, s = Math.sqrt(1 - u * u), th = ph0 + q * ga + (rnd() - 0.5) * 0.35;
      const f = P.shell * (0.9 + rnd() * 0.2);
      const c = [C[0] + Math.cos(th) * s * cr[0] * f, C[1] + u * cr[1] * f, C[2] + Math.sin(th) * s * cr[2] * f];
      clumps.push(mk(c, rAvg * P.cs * (0.85 + rnd() * 0.3) * (1 - 0.12 * u), u < -0.1 ? 0.4 : 0.2));
    }
    const filler = mk([C[0], C[1] - cr[1] * 0.05, C[2]], Math.min(cr[0], cr[1], cr[2]) * 0.62, 0.3);
    const all = clumps.concat([filler]);
    const { hi, cv } = boundsOf(all);

    const crownAO = p => {
      const x = (p[0] - cv.c[0]) / cv.r[0], y = (p[1] - cv.c[1]) / cv.r[1], z = (p[2] - cv.c[2]) / cv.r[2];
      return 0.34 + 0.5 * ss(0.15, 1.0, Math.hypot(x, y, z));
    };
    const woodCol = p => mix3(bark.dark, bark.base, 0.45 + 0.45 * vn3(p[0] * 1.1 + seed, p[1] * 1.1, p[2] * 1.1));
    const limb = (path, r0, r1, sides, s0, s1, b) => (b || N).tube(path, t => r0 + (r1 - r0) * t,
      { sides, color: (u, v, p) => woodCol(p), ex: (u, v, p) => [crownAO(p), s0 + (s1 - s0) * v, 0, 0] });

    // trunk with root flare and bark ridges
    const rootPh = rnd() * TAU, mossDir = rnd() * TAU;
    const ys = [-1.2, -0.45, 0.05, 0.45, 0.95, 1.6];
    for (let k = 0; k < 4; k++) ys.push(lerp(2.4, split + 0.5, k / 3));
    const center = y => {
      const t = clamp((y + 1.2) / (split + 1.7), 0, 1);
      return [fork[0] * t * t + Math.sin(t * 2.4 + seed) * 0.12 * t, fork[2] * t * t + Math.cos(t * 2.1 + seed) * 0.1 * t];
    };
    const rad = y => tr * (1 - 0.32 * clamp(y / (split + 0.5), 0, 1));
    const flare = y => P.flare * Math.exp(-Math.max(0, y + 0.15) * 1.5);
    const trunkEx = (a, y) => [(y < 0.2 ? 0.5 : 0.5 + 0.45 * ss(0.2, 2.2, y)) * (1 - 0.42 * ss(split - 3, split + 0.3, y)), 0, 0, 0];
    const roots = a => 0.25 + 0.75 * Math.pow(Math.max(0, Math.cos(P.roots * a + rootPh)), 2);
    const barkCol = (a, y, s) => {
      let c = woodCol([Math.cos(a) * 2, y, Math.sin(a) * 2]);
      c = s % 2 ? mix3(c, bark.light, 0.3) : mul3(c, 0.74);
      return mix3(c, bark.moss, ss(1.6, -0.2, y) * Math.max(0, Math.cos(a - mossDir)) * 0.7);
    };
    trunk(N, {
      levels: ys, center, rad, sides: 12, color: barkCol, ex: trunkEx,
      shape: (a, y, s) => 1 + flare(y) * roots(a) + (s % 2 ? P.ridge : -P.ridge * 0.6),
    });
    trunk(M, {
      levels: [-1.2, -0.2, 0.6, 2.0, split * 0.75, split + 0.5], center, rad, sides: 6, ex: trunkEx,
      shape: (a, y) => 1 + flare(y) * roots(a), color: (a, y) => barkCol(a, y, 1),
    });
    // limbs: a leader to the crowning clump, 3-5 main limbs by sector, a secondary limb into each clump
    const top = clumps[0].c;
    limb(bez(fork, [fork[0], lerp(fork[1], top[1], 0.5), fork[2]], lerp3(fork, top, 0.8), 4), tr * 0.62, tr * 0.2, 6, 0.02, 0.35);
    const nMain = P.limbs, ph = rnd() * TAU, groups = [];
    for (let g = 0; g < nMain; g++) groups.push([]);
    for (let q = 1; q < clumps.length; q++) {
      const k = clumps[q], a = Math.atan2(k.c[2] - fork[2], k.c[0] - fork[0]);
      groups[Math.min(nMain - 1, Math.floor((((a - ph) % TAU + TAU) % TAU) / TAU * nMain))].push(k);
    }
    for (const g of groups) {
      if (!g.length) continue;
      const mc = [0, 0, 0];
      for (const k of g) for (let a = 0; a < 3; a++) mc[a] += k.c[a] / g.length;
      const S = [fork[0], fork[1] - 0.35, fork[2]], E = lerp3(S, mc, 0.62), len = dist(S, E);
      const ctl = lerp3(S, E, 0.45); ctl[1] += len * 0.12;
      limb(bez(S, ctl, E, 5), tr * 0.6, tr * 0.3, 6, 0.0, 0.25);
      limb(bez(S, ctl, E, 3), tr * 0.6, tr * 0.3, 4, 0.0, 0.25, M);
      for (const k of g) {
        const B = bezAt(S, ctl, E, 0.55 + rnd() * 0.4), Eb = lerp3(B, k.c, 0.82), mid = lerp3(B, Eb, 0.5);
        mid[1] += dist(B, Eb) * 0.1;
        limb([B, mid, Eb], tr * 0.3, tr * 0.1, 4, 0.2, 0.5);
      }
    }
    for (const k of all) {
      const j = 0.93 + rnd() * 0.14, hue = (rnd() - 0.5) * 0.08, jit = [j * (1 + hue), j, j * (1 - hue)], cs = rnd() * 1e9;
      shadeLeaves(N, blob(N, k.c, k.rr, mulberry(cs), { amp: 0.13, flat: k.flat, freq: 1.3 }), cv, pal, { jit, seed, clump: k });
      shadeLeaves(M, blob(M, k.c, k.rr, mulberry(cs), { amp: 0.13, flat: k.flat, freq: 1.3, lo: true }), cv, pal, { jit, seed, clump: k });
    }
    // far LOD: 6-sided trunk + one sphere shrink-wrapped onto the clump union
    trunk(F, {
      levels: [-1.2, 0.4, split + 0.6], center, rad, sides: 5, shape: (a, y) => 1 + flare(y) * 0.5,
      color: (a, y) => woodCol([0, y, 0]), ex: trunkEx,
    });
    const mf = sphere(F, filler.c, 11, 6, d => unionRadius(filler.c, all, d, filler.r));
    shadeLeaves(F, mf, cv, pal, { seed });
    return {
      N, M, F, top: hi[1], width: Math.max(cv.r[0], cv.r[2]) * 2 + Math.hypot(cv.c[0], cv.c[2]),
      coll: { trunkR: tr * 1.05, trunkTop: cv.c[1], cy: cv.c[1], cR: Math.min(cv.r[0], cv.r[2]) * 0.62, cRy: cv.r[1] * 0.62, cone: 0, top: hi[1] },
    };
  }

  function conifer(seed, P) {
    const rnd = mulberry(seed), N = new MESH.Builder(), M = new MESH.Builder(), F = new MESH.Builder(), pal = P.pal, bark = BARK.fir;
    const H = P.H, y0 = P.base, n = P.tiers;
    const trunkRad = y => P.trunkR * Math.max(0.1, 1 - y / (H * 1.02));
    const tiers = [];
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const Ya = y0 + (H - 1.5 - y0) * (1 - Math.pow(1 - (k + (k ? (rnd() - 0.5) * 0.35 : 0)) / n, 1.3));
      const R = P.R * Math.pow(1 - f * 0.88, 0.95) * (0.9 + rnd() * 0.2) + 0.3;
      const jag = [], dr = [];
      for (let s = 0; s < 12; s++) { const j = 1 + P.jag * (s % 2 ? 0.5 : -0.45) * (0.6 + 0.8 * rnd()); jag.push(j); dr.push((s % 2 ? 1.08 : 0.78) * (0.9 + 0.2 * rnd())); }
      tiers.push({ Ya, R, D: R * P.droop + 0.4, f, rot: rnd() * TAU, jag, dr });
    }
    const woodCol = y => mix3(bark.dark, bark.base, 0.5 + 0.4 * vn3(y * 1.3, seed, 0.5));
    const trunkEx = (a, y) => [0.42 + 0.3 * ss(-0.6, 1.2, y) * (1 - ss(y0 - 0.5, y0 + 1.5, y)) + 0.1, 0, 0, 0];
    const rootPh = rnd() * TAU;
    const tShape = (a, y) => 1 + 0.5 * Math.exp(-Math.max(0, y + 0.1) * 2) * (0.3 + 0.7 * Math.pow(Math.max(0, Math.cos(3 * a + rootPh)), 2));
    trunk(N, {
      levels: [-1, -0.3, 0.3, 1.2, Math.max(1.8, y0 + 0.5), H * 0.45, H * 0.75, H - 1.8], center: () => [0, 0], rad: trunkRad, sides: 7,
      shape: tShape, color: (a, y) => woodCol(y), ex: trunkEx,
    });
    // one skirt of branches: profile rings from the under-collar, out to the drooping tips, back over the top to the
    // upper collar. near: 12 jagged sides × 6 rings; mid: 8 sides × 4 rings.
    function tier(b, t, S, full) {
      const rc = trunkRad(t.Ya) + 0.06, Yb = t.Ya - t.D * 0.4, nL = full ? 6 : 4, rings = [];
      for (let L = 0; L < nL; L++) rings.push([]);
      const jagAt = s => (full ? t.jag[s] : 1 + P.jag * (s % 2 ? 0.45 : -0.4)), drAt = s => (full ? t.dr[s] : s % 2 ? 1.05 : 0.8);
      for (let s = 0; s < S; s++) {
        const a = t.rot + s / S * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const Rj = t.R * jagAt(s), Yt = t.Ya - t.D * drAt(s), top = [0.5 * Rj, t.Ya - (t.Ya - Yt) * 0.36];
        const prof = full ? [[rc, Yb], [0.5 * Rj, lerp(Yb, Yt, 0.5) + 0.12 * t.D], [0.9 * Rj, Yt + 0.12 * t.D], [Rj, Yt], top, [rc, t.Ya]]
          : [[rc, Yb], [Rj, Yt], top, [rc, t.Ya]];
        for (let L = 0; L < nL; L++) rings[L].push([ca * prof[L][0], prof[L][1], sa * prof[L][0]]);
      }
      const m = b.rings(rings, { closed: true, flip: true }), v = b.v;
      const swK = 0.55 + 0.45 * t.R / P.R, up = 0.84 + 0.3 * t.f;
      for (let L = 0; L < nL; L++) for (let s = 0; s < S; s++) {
        const q = (m.v + L * S + s) * ST, p = [v[q], v[q + 1], v[q + 2]], tip = jagAt(s) > 1 ? 1 : 0.55;
        const lv = full ? L : [0, 3, 4, 5][L];
        let c, ao, sw;
        if (lv === 0) { c = mul3(pal.deep, 0.75); ao = 0.32; sw = 0.02; }
        else if (lv === 1) { c = mul3(pal.deep, 0.9); ao = 0.42; sw = 0.2; }
        else if (lv === 2) { c = mix3(pal.deep, pal.mid, 0.6); ao = 0.6; sw = 0.5; }
        else if (lv === 3) { c = mix3(mix3(pal.mid, pal.light, 0.3 + 0.5 * tip), pal.warm, 0.3 * t.f); ao = 0.95; sw = 0.62; }
        else if (lv === 4) { c = mix3(mix3(pal.deep, pal.mid, 0.82), pal.warm, 0.12 * t.f); ao = 0.72; sw = 0.25; }
        else { c = pal.deep; ao = 0.46; sw = 0.02; }
        c = mul3(c, up * (0.88 + 0.24 * vn3(p[0] * 0.8 + seed, p[1] * 0.8, p[2] * 0.8)));
        v[q + 6] = c[0]; v[q + 7] = c[1]; v[q + 8] = c[2]; v[q + 9] = ao; v[q + 10] = sw * swK; v[q + 11] = 4; v[q + 12] = 0;
        if (lv >= 3) { const nn = nrm([v[q + 3], v[q + 4] + 0.45, v[q + 5]]); v[q + 3] = nn[0]; v[q + 4] = nn[1]; v[q + 5] = nn[2]; }
      }
    }
    for (const t of tiers) { tier(N, t, 12, true); tier(M, t, 8, false); }
    const leaderCol = (u, v) => mix3(pal.mid, pal.light, 0.35 + 0.4 * v);
    N.lathe([[0.42, H - 2.7], [0.22, H - 1.3], [0.02, H]], { sides: 7, color: leaderCol, ex: (u, v) => [0.7 + 0.3 * v, 0.2 + 0.5 * v, 4, 0] });
    M.lathe([[0.42, H - 2.7], [0.02, H]], { sides: 5, color: leaderCol, ex: (u, v) => [0.75 + 0.25 * v, 0.25 + 0.4 * v, 4, 0] });
    trunk(M, { levels: [-1, 0.3, Math.max(1.8, y0 + 0.5), H * 0.6], center: () => [0, 0], rad: trunkRad, sides: 5, shape: tShape, color: (a, y) => woodCol(y), ex: trunkEx });
    // far LOD: same tiers as simple 6-sided skirts
    trunk(F, { levels: [-1, Math.max(1.5, y0)], center: () => [0, 0], rad: trunkRad, sides: 4, shape: () => 1.15, color: (a, y) => woodCol(y), ex: trunkEx });
    for (const t of tiers) {
      const S = 6, rc = trunkRad(t.Ya) + 0.06, Yb = t.Ya - t.D * 0.4, Yt = t.Ya - t.D, rings = [[], [], []];
      for (let s = 0; s < S; s++) {
        const a = t.rot + s / S * TAU, ca = Math.cos(a), sa = Math.sin(a);
        rings[0].push([ca * rc, Yb, sa * rc]); rings[1].push([ca * t.R * 1.04, Yt, sa * t.R * 1.04]); rings[2].push([ca * rc, t.Ya, sa * rc]);
      }
      const m = F.rings(rings, { closed: true, flip: true });
      const up = 0.84 + 0.3 * t.f;
      for (let L = 0; L < 3; L++) for (let s = 0; s < S; s++) {
        const q = (m.v + L * S + s) * ST, v = F.v;
        const c = mul3(L === 0 ? mul3(pal.deep, 0.8) : L === 1 ? mix3(mix3(pal.mid, pal.light, 0.5), pal.warm, 0.25 * t.f) : mix3(pal.deep, pal.mid, 0.4), up);
        v[q + 6] = c[0]; v[q + 7] = c[1]; v[q + 8] = c[2]; v[q + 9] = L === 1 ? 0.92 : L === 0 ? 0.38 : 0.55; v[q + 10] = L === 1 ? 0.5 : 0.05; v[q + 11] = 4; v[q + 12] = 0;
        if (L === 1) { const nn = nrm([v[q + 3], v[q + 4] + 0.5, v[q + 5]]); v[q + 3] = nn[0]; v[q + 4] = nn[1]; v[q + 5] = nn[2]; }
      }
    }
    F.lathe([[0.42, H - 2.7], [0.02, H]], { sides: 4, color: leaderCol, ex: (u, v) => [0.8, 0.3, 4, 0] });
    return {
      N, M, F, top: H, width: P.R * 2.2,
      coll: { trunkR: P.trunkR * 1.1, trunkTop: H, cy0: y0 - tiers[0].D * 0.6, cR: tiers[0].R * 0.5, cone: 1, top: H },
    };
  }

  function birch(seed, P) {
    const rnd = mulberry(seed), N = new MESH.Builder(), M = new MESH.Builder(), F = new MESH.Builder(), pal = P.pal, bark = P.bark, tw = BARK.twig;
    const clumps = [], stems = [];
    const mk = (c, r, ry) => ({ c, r, rr: [r, ry, r] });
    for (let s = 0; s < P.stems; s++) {
      const a = s / P.stems * TAU + rnd() * 0.6, off = P.stems > 1 ? 0.3 : 0;
      const lean = P.stems > 1 ? 0.07 + rnd() * 0.05 : 0.015 + rnd() * 0.02;
      const Hs = P.H * (s === 0 ? 1 : 0.8 + rnd() * 0.12), ph = rnd() * TAU;
      const bx = Math.cos(a) * off, bz = Math.sin(a) * off;
      const center = y => [bx + Math.cos(a) * lean * y + Math.sin(y * 0.33 + ph) * 0.14, bz + Math.sin(a) * lean * y + Math.cos(y * 0.29 + ph) * 0.12];
      stems.push({ a, Hs, center, r0: P.trunkR * (s === 0 ? 1 : 0.8), ph });
    }
    const pt = (st, y) => { const c = st.center(y); return [c[0], y, c[1]]; };
    const twigCol = p => mix3(tw.dark, tw.base, 0.5 + 0.4 * vn3(p[0] * 2 + seed, p[1] * 2, p[2] * 2));
    // crown: clumps on ascending limbs (birch) or a stacked spindle (poplar)
    const limbs = [];
    for (const st of stems) {
      if (P.columnar) {
        const n = P.clumps;
        for (let k = 0; k < n; k++) {
          const f = k / (n - 1), y = st.Hs * (0.26 + 0.7 * f);
          const Rk = P.crown * (0.32 + 0.68 * Math.sin(Math.PI * Math.min(1, 0.14 + 0.86 * f)));
          const a = k * 2.4 + rnd() * 0.8, off = Rk * 0.38, c0 = pt(st, y);
          const c = [c0[0] + Math.cos(a) * off, y, c0[2] + Math.sin(a) * off];
          clumps.push(mk(c, Rk * 0.72, Rk * 1.05));
          if (k % 2 === 0 && f < 0.8) limbs.push({ path: [pt(st, y - 1.2), lerp3(pt(st, y - 0.6), c, 0.5), lerp3(c0, c, 0.8)], r0: 0.07, r1: 0.025 });
        }
        continue;
      }
      const multi = P.stems > 1, nL = multi ? 3 : 6;
      for (let k = 0; k < nL; k++) {
        const hf = 0.4 + 0.44 * k / (nL - 1) + (rnd() - 0.5) * 0.05, y = st.Hs * hf;
        const az = (multi ? st.a + (k - 1) * 1.1 : k * 2.4) + (rnd() - 0.5) * 0.5, el = 0.6 + rnd() * 0.35; // angle from vertical
        const L = P.crown * (0.8 + 0.35 * rnd()) * (1.2 - 0.5 * hf);
        const S = pt(st, y), dir = [Math.cos(az) * Math.sin(el), Math.cos(el), Math.sin(az) * Math.sin(el)];
        const E = [S[0] + dir[0] * L, S[1] + dir[1] * L - 0.3, S[2] + dir[2] * L];
        const Mp = lerp3(S, E, 0.55); Mp[1] += 0.3;
        limbs.push({ path: [S, Mp, E], r0: 0.085, r1: 0.025 });
        const r = P.clumpR * (0.85 + 0.3 * rnd());
        clumps.push(mk([E[0], E[1] - 0.2 * r, E[2]], r, r * 1.22));
        if (rnd() < (multi ? 0.35 : 0.7)) { const r2 = r * 0.75; clumps.push(mk(lerp3(S, E, 0.48 + rnd() * 0.15), r2, r2 * 1.2)); }
      }
      const r = P.clumpR * 0.95;
      clumps.push(mk(pt(st, st.Hs - r * 0.55), r, r * 1.25));
      if (!multi) { clumps.push(mk(pt(st, st.Hs - r * 2.1), r * 1.1, r * 1.2)); clumps.push(mk(pt(st, st.Hs - r * 3.6), r * 1.05, r * 1.15)); }
    }
    const { hi, cv } = boundsOf(clumps);
    // trunks
    for (const st of stems) {
      const levels = [-1, -0.3, 0.2];
      for (let y = 0.8; y < st.Hs * 0.55; y += 0.62) levels.push(y);
      for (let y = st.Hs * 0.55 + 1.2; y < st.Hs - 0.6; y += 1.5) levels.push(y);
      levels.push(st.Hs - 0.4);
      const sides = P.stems > 1 ? 6 : 7;
      const rad = y => st.r0 * Math.max(0.12, 1 - 0.85 * y / st.Hs) * (y < 0.8 ? 1 + 0.4 * (0.8 - Math.max(y, -0.4)) : 1);
      const ex = (a, y) => [0.55 + 0.4 * ss(-0.2, 1.8, y) - 0.25 * ss(st.Hs * 0.5, st.Hs * 0.8, y), 0.12 * ss(st.Hs * 0.5, st.Hs, y), 0, 0];
      const barkCol = (a, y, s, marks) => {
        const band = Math.floor(y * 1.6 + st.ph * 3);
        let c = mix3(bark.base, bark.light, vn3(a * 1.5, y * 0.7, seed));
        if (marks && y > 0.9 && hash2(band * 7 + s + seed, band) > (P.columnar ? 0.8 : 0.62)) c = mix3(c, bark.dark, 0.85);
        return mix3(c, mix3(bark.dark, bark.moss, 0.5), ss(1.5, 0.1, y) * (0.75 + 0.25 * hash2(s + seed, 3)));
      };
      trunk(N, {
        levels, center: st.center, sides, rad, ex,
        shape: (a, y, s) => 1 + (y < 0.6 ? 0.08 * Math.sin(3 * a + st.ph) : 0), color: (a, y, s) => barkCol(a, y, s, true),
      });
      trunk(M, {
        levels: [-1, 0.2, 1.4, st.Hs * 0.3, st.Hs * 0.6, st.Hs - 0.4], center: st.center, sides: 5, rad, ex,
        shape: () => 1, color: (a, y, s) => mix3(barkCol(a, y, s, false), bark.dark, y > 1 ? 0.12 : 0),
      });
    }
    for (const l of limbs) {
      N.tube(l.path, t => l.r0 + (l.r1 - l.r0) * t, { sides: 4, color: (u, v, p) => twigCol(p), ex: (u, v) => [0.55 + 0.2 * v, 0.1 + 0.4 * v, 0, 0] });
      M.tube([l.path[0], l.path[2]], t => l.r0 + (l.r1 - l.r0) * t, { sides: 3, color: (u, v, p) => twigCol(p), ex: (u, v) => [0.6, 0.1 + 0.4 * v, 0, 0] });
    }
    for (const k of clumps) {
      const j = 0.93 + rnd() * 0.14, hue = (rnd() - 0.5) * 0.1, jit = [j * (1 + hue), j, j * (1 - hue)], cs = rnd() * 1e9;
      shadeLeaves(N, blob(N, k.c, k.rr, mulberry(cs), { amp: 0.16, flat: 0.1, freq: 1.5 }), cv, pal, { jit, seed, sway0: 0.5, aoMin: 0.4, clump: k });
      shadeLeaves(M, blob(M, k.c, k.rr, mulberry(cs), { amp: 0.16, flat: 0.1, freq: 1.5, lo: true }), cv, pal, { jit, seed, sway0: 0.5, aoMin: 0.4, clump: k });
    }
    // far LOD
    for (const st of stems) {
      trunk(F, {
        levels: [-1, 1.5, st.Hs * 0.62], center: st.center, sides: 5, rad: y => st.r0 * Math.max(0.2, 1 - 0.8 * y / st.Hs),
        shape: () => 1, color: (a, y) => (y < 0.5 ? mix3(bark.dark, bark.base, 0.45) : bark.base), ex: () => [0.8, 0, 0, 0],
      });
    }
    farClusters(F, clumps, P.columnar ? 3 : 4, 6, 4, cv, pal, { seed, sway0: 0.5 });
    return {
      N, M, F, top: hi[1], width: Math.max(cv.r[0], cv.r[2]) * 2 + Math.hypot(cv.c[0], cv.c[2]),
      coll: { trunkR: P.trunkR * (P.stems > 1 ? 2.2 : 1.1), trunkTop: cv.c[1], cy: cv.c[1], cR: Math.min(cv.r[0], cv.r[2]) * 0.5, cRy: cv.r[1] * 0.55, cone: 0, top: hi[1] },
    };
  }

  function bush(seed, P) {
    const rnd = mulberry(seed), N = new MESH.Builder(), M = new MESH.Builder(), F = new MESH.Builder(), pal = P.pal;
    const R = P.R, Hh = P.Hh;
    const clumps = [{ c: [0, Hh * 0.45, 0], rr: [R * 0.68, Hh * 0.52, R * 0.68] }];
    for (let k = 0; k < P.n - 1; k++) {
      const a = k / (P.n - 1) * TAU + rnd() * 0.7, d = R * (0.42 + rnd() * 0.12), s = 0.8 + rnd() * 0.35;
      clumps.push({ c: [Math.cos(a) * d, Hh * (0.25 + rnd() * 0.18), Math.sin(a) * d], rr: [R * 0.44 * s, Hh * 0.4 * s, R * 0.44 * s] });
    }
    const cv = { c: [0, Hh * 0.42, 0], r: [R, Hh * 0.6, R] };
    for (const k of clumps) {
      const j = 0.92 + rnd() * 0.16, hue = (rnd() - 0.5) * 0.1, jit = [j * (1 + hue), j, j * (1 - hue)], cs = rnd() * 1e9;
      const o = { jit, seed, sway0: 0.15, sway1: 0.8, aoMin: 0.3, clump: k };
      const flat = P.flat != null ? P.flat : 0.45;
      shadeLeaves(N, blob(N, k.c, k.rr, mulberry(cs), { amp: 0.16, flat, freq: 1.5 }), cv, pal, o);
      const mm = blob(M, k.c, k.rr, mulberry(cs), { amp: 0.16, flat, freq: 1.5, lo: true });
      shadeLeaves(M, mm, cv, pal, o);
      if (P.flowers) bloomTint(M, mm, P.flowers.avg, Hh * 0.5, Hh * 0.95, 0.62);
    }
    if (P.flowers) {
      const fl = P.flowers;
      for (let q = 0; q < fl.n; q++) {
        const u = 0.05 + rnd() * 0.9, th = rnd() * TAU, s = Math.sqrt(1 - u * u), d = [Math.cos(th) * s, u, Math.sin(th) * s];
        const rr = unionRadius(cv.c, clumps, d, 0.5) * 0.99;
        const p = [cv.c[0] + d[0] * rr, cv.c[1] + d[1] * rr, cv.c[2] + d[2] * rr];
        blossom(N, p, nrm([d[0], d[1] + 0.3, d[2]]), fl.size * (0.8 + rnd() * 0.4), fl.cols[Math.floor(rnd() * fl.cols.length)], fl.eye, 0.7);
      }
    }
    const mf = sphere(F, cv.c, 8, 5, d => unionRadius(cv.c, clumps, d, R * 0.5));
    shadeLeaves(F, mf, cv, pal, { seed, sway0: 0.15, sway1: 0.8, aoMin: 0.3 });
    if (P.flowers) bloomTint(F, mf, P.flowers.avg, Hh * 0.5, Hh * 0.95, 0.62);
    return { N, M, F, top: Hh * 1.1, width: R * 2.1, coll: { trunkR: 0, trunkTop: 0, cy: Hh * 0.42, cR: R * 0.5, cRy: Hh * 0.35, cone: 0, top: Hh } };
  }

  // grass tuft: thin 2-segment blades (terrain-matched colour in the shader)
  function tuft(seed, P) {
    const rnd = mulberry(seed), b = new MESH.Builder();
    for (let k = 0; k < P.blades; k++) {
      const a = k / P.blades * TAU + rnd() * 0.8, r0 = P.spread * (0.15 + rnd() * 0.6);
      const h = P.h * (0.6 + rnd() * 0.55), w = P.w * (0.7 + rnd() * 0.6), lean = P.lean * (0.4 + rnd());
      const dir = [Math.cos(a), 0, Math.sin(a)], sd = [-Math.sin(a + 0.9), 0, Math.cos(a + 0.9)];
      const base = [dir[0] * r0, -0.06, dir[2] * r0];
      const mid = [base[0] + dir[0] * lean * h * 0.3, h * 0.5, base[2] + dir[2] * lean * h * 0.3];
      const tip = [base[0] + dir[0] * lean * h, h, base[2] + dir[2] * lean * h];
      const n = nrm([dir[0] * 0.35, 1, dir[2] * 0.35]), tone = 0.9 + rnd() * 0.2;
      const i0 = b.vert([base[0] - sd[0] * w, base[1], base[2] - sd[2] * w], n, mul3([0.7, 0.7, 0.64], tone), [0.62, 0, 2, 0]);
      b.vert([base[0] + sd[0] * w, base[1], base[2] + sd[2] * w], n, mul3([0.7, 0.7, 0.64], tone), [0.62, 0, 2, 0]);
      b.vert([mid[0] - sd[0] * w * 0.75, mid[1], mid[2] - sd[2] * w * 0.75], n, mul3([0.92, 0.94, 0.86], tone), [0.82, 0.3, 2, 0]);
      b.vert([mid[0] + sd[0] * w * 0.75, mid[1], mid[2] + sd[2] * w * 0.75], n, mul3([0.92, 0.94, 0.86], tone), [0.82, 0.3, 2, 0]);
      b.vert(tip, n, mul3([1.22, 1.16, 0.86], tone), [1, 1, 2, 0]);
      b.tri(i0, i0 + 1, i0 + 3).tri(i0, i0 + 3, i0 + 2).tri(i0 + 2, i0 + 3, i0 + 4);
    }
    return b;
  }
  // a few wildflowers on grass-coloured stems
  function wildflower(seed, P) {
    const rnd = mulberry(seed), b = new MESH.Builder();
    for (let k = 0; k < P.n; k++) {
      const a = rnd() * TAU, r0 = rnd() * 0.18, h = P.h * (0.7 + rnd() * 0.5), w = 0.012;
      const bx = Math.cos(a) * r0, bz = Math.sin(a) * r0, lx = (rnd() - 0.5) * 0.12, lz = (rnd() - 0.5) * 0.12;
      const n = [0, 1, 0], i0 = b.vert([bx - w, -0.05, bz], n, [0.6, 0.6, 0.55], [0.6, 0, 2, 0]);
      b.vert([bx + w, -0.05, bz], n, [0.6, 0.6, 0.55], [0.6, 0, 2, 0]);
      b.vert([bx + lx, h, bz + lz], n, [1, 1, 0.9], [1, 1, 2, 0]);
      b.tri(i0, i0 + 1, i0 + 2);
      const d = nrm([lx * 2 + (rnd() - 0.5) * 0.3, 1, lz * 2 + (rnd() - 0.5) * 0.3]), c0 = b.count, s = P.size * (0.8 + rnd() * 0.4);
      const t1 = nrm(cross([1, 0, 0], d)), t2 = cross(d, t1), p = [bx + lx, h, bz + lz], col = P.cols[k % P.cols.length];
      b.vert([p[0] + d[0] * s * 0.2, p[1] + d[1] * s * 0.2, p[2] + d[2] * s * 0.2], d, P.eye, [1, 1, 3, 0.2]);
      const np = P.petals;
      for (let q = 0; q < np * 2; q++) {
        const aa = q / (np * 2) * TAU, r = q % 2 ? s * P.notch : s;
        b.vert([p[0] + (t1[0] * Math.cos(aa) + t2[0] * Math.sin(aa)) * r, p[1] + (t1[1] * Math.cos(aa) + t2[1] * Math.sin(aa)) * r + (q % 2 ? 0 : s * P.cup),
          p[2] + (t1[2] * Math.cos(aa) + t2[2] * Math.sin(aa)) * r], d, col, [1, 1, 3, 0.1]);
      }
      for (let q = 0; q < np * 2; q++) b.tri(c0, c0 + 1 + q, c0 + 1 + (q + 1) % (np * 2));
    }
    return b;
  }

  // ───── kinds ─────
  const KINDS = [];
  // LOD bands (3D distance): near < R1 < mid < R2 < far < per-instance limit (≤ FAR); W = dithered cross-fade width
  // W: LOD cross-fade width (m) — kept narrow so few trees are mid-dither at once
  const TREE = { R1: 110, R2: 300, W: 14, FAR: 1300, sway: 0.3 }, CONI = { R1: 110, R2: 300, W: 14, FAR: 1300, sway: 0.22 },
    SHRUB = { R1: 45, R2: 120, W: 8, FAR: 440, sway: 0.14 };
  function addKind(name, species, built, meta) {
    const lods = [built.N.upload(), built.M.upload(), built.F.upload()];
    const K = Object.assign({ name, species, lods, tris: lods.map(m => m.count / 3), top: built.top, width: built.width, coll: built.coll }, meta);
    K.band = [[-1e5, K.R1], [K.R1, K.R2], [K.R2, -1]];
    // the mid LOD's bounding cylinder (centre x, z, radius, bottom, top): the impostor's quad is its outline from the viewer
    const v = built.M.v, lo = lods[1].bounds.lo, hi = lods[1].bounds.hi, ccx = (lo[0] + hi[0]) / 2, ccz = (lo[2] + hi[2]) / 2;
    let rh = 0;
    for (let o = 0; o < v.length; o += ST) rh = Math.max(rh, Math.hypot(v[o] - ccx, v[o + 2] - ccz));
    K.cyl = [ccx, ccz, rh, Math.max(lo[1], -0.5), hi[1]]; // roots below the ground never show
    KINDS.push(K);
  }
  addKind('oak', 'broadleaf', broadleaf(11, { H: 13, crown: [7.6, 5.2, 7.2], fork: 0.62, shell: 0.62, cs: 0.4, trunkR: 0.56, clumps: 14, limbs: 5, lean: [0.5, -0.3], roots: 5, flare: 0.9, ridge: 0.075, pal: PAL.oak, bark: BARK.oak }), TREE);
  addKind('beech', 'broadleaf', broadleaf(23, { H: 16, crown: [5.8, 6.4, 5.6], fork: 0.55, shell: 0.6, cs: 0.4, trunkR: 0.44, clumps: 14, limbs: 4, lean: [-0.2, 0.3], roots: 4, flare: 0.6, ridge: 0.02, pal: PAL.beech, bark: BARK.beech }), TREE);
  addKind('linden', 'broadleaf', broadleaf(37, { H: 11, crown: [4.8, 5.2, 4.8], fork: 0.62, shell: 0.58, cs: 0.42, trunkR: 0.38, clumps: 13, limbs: 4, lean: [0.3, 0.2], roots: 4, flare: 0.7, ridge: 0.06, pal: PAL.linden, bark: BARK.linden }), TREE);
  addKind('fir', 'conifer', conifer(51, { H: 19, base: 1.6, R: 4.3, tiers: 8, droop: 0.62, jag: 0.5, trunkR: 0.38, pal: PAL.fir }), CONI);
  addKind('spruce', 'conifer', conifer(63, { H: 23, base: 2.4, R: 4.0, tiers: 9, droop: 0.85, jag: 0.42, trunkR: 0.42, pal: PAL.spruce }), CONI);
  addKind('young fir', 'conifer', conifer(77, { H: 12, base: 0.8, R: 3.6, tiers: 6, droop: 0.55, jag: 0.55, trunkR: 0.26, pal: PAL.yfir }), CONI);
  addKind('birch', 'birch', birch(89, { H: 13.5, stems: 1, crown: 2.9, clumpR: 1.5, trunkR: 0.21, pal: PAL.birch, bark: BARK.birch }), TREE);
  addKind('clump birch', 'birch', birch(97, { H: 12, stems: 3, crown: 2.5, clumpR: 1.3, trunkR: 0.16, pal: PAL.birch, bark: BARK.birch }), TREE);
  addKind('poplar', 'birch', birch(105, { H: 16, stems: 1, columnar: true, crown: 2.3, clumps: 12, trunkR: 0.3, pal: PAL.poplar, bark: BARK.poplar }), TREE);
  addKind('round bush', 'bush', bush(121, { R: 1.5, Hh: 1.9, n: 5, pal: PAL.bush }), SHRUB);
  addKind('low bush', 'bush', bush(131, { R: 2.0, Hh: 1.5, n: 6, flat: 0.3, pal: PAL.box }), SHRUB);
  addKind('blossom bush', 'bush', bush(141, { R: 1.4, Hh: 1.8, n: 5, pal: PAL.bloom,
    flowers: { n: 46, size: 0.17, cols: [[0.96, 0.45, 0.62], [1.0, 0.7, 0.8], [0.93, 0.36, 0.55], [1.0, 0.93, 0.95]], eye: [1.0, 0.86, 0.4], avg: [1.0, 0.6, 0.74] } }), SHRUB);
  const NK = KINDS.length;
  const K_OAK = 0, K_BEECH = 1, K_LINDEN = 2, K_FIR = 3, K_SPRUCE = 4, K_YFIR = 5, K_BIRCH = 6, K_BIRCH3 = 7, K_POPLAR = 8, K_BUSH = 9, K_LOWBUSH = 10, K_BLOSSOM = 11;

  const GKINDS = [
    tuft(201, { blades: 9, h: 0.62, w: 0.042, spread: 0.26, lean: 0.4 }),
    tuft(211, { blades: 11, h: 0.95, w: 0.036, spread: 0.3, lean: 0.45 }),
    tuft(221, { blades: 8, h: 0.42, w: 0.05, spread: 0.32, lean: 0.6 }),
    wildflower(231, { n: 4, h: 0.42, size: 0.11, petals: 6, notch: 0.55, cup: 0.0, cols: [[0.98, 0.97, 0.93]], eye: [1.0, 0.8, 0.2] }),        // daisy
    wildflower(241, { n: 5, h: 0.36, size: 0.075, petals: 5, notch: 0.75, cup: 0.35, cols: [[1.0, 0.84, 0.16]], eye: [0.95, 0.7, 0.1] }),     // buttercup
    wildflower(251, { n: 3, h: 0.5, size: 0.12, petals: 4, notch: 0.8, cup: 0.3, cols: [[0.92, 0.2, 0.12]], eye: [0.12, 0.08, 0.08] }),       // poppy
    wildflower(261, { n: 3, h: 0.45, size: 0.085, petals: 7, notch: 0.45, cup: 0.1, cols: [[0.36, 0.48, 0.95], [0.55, 0.42, 0.9]], eye: [0.25, 0.2, 0.55] }), // cornflower
  ].map(b => b.upload());
  const NG = GKINDS.length;

  // ───── shader ─────
  const PR = program(GLSL_COMMON + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
layout(location=4) in vec4 iA; layout(location=5) in vec4 iB;
uniform mat4 uVP; uniform vec4 uLod; uniform float uSway, uMode, uStiff; uniform vec4 uG;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec4 vEx; out vec2 vFade; out vec2 vWind;
void main(){
  vWind = vec2(0.0, GUST_MEAN);
  vec3 rel0 = iA.xyz - uCam;
  float d = length(rel0);
  // LOD band [uLod.x, uLod.y] on a 4x4 dither: this LOD draws thresholds in [lo, hi) and its neighbour the rest, so
  // cross-fading LODs never overlap or leave holes. uLod.y < 0: fade out at the per-instance distance iB.w.
  float lo = clamp((uLod.x - d)/uLod.z, 0.0, 1.0);
  float hi = uLod.y < 0.0 ? clamp((iB.w - d)/25.0, 0.0, 1.0) : clamp((uLod.y - d)/uLod.z, 0.0, 1.0);
  vFade = uLod.w > 0.5 ? vec2(0.0, 2.0) : vec2(lo, hi);
  float sc = iA.w, wide = 1.0;
  if (uMode > 0.5) {
    // grass & flowers: full density out to uLod.y, then each tuft stays while its seed is under (uLod.y/d)² and the
    // survivors widen (and grow a little) to keep the meadow's cover; all gone by uLod.x
    float f = min(1.0, uLod.y*uLod.y/(d*d));
    wide = min(inversesqrt(f), 3.5);
    sc *= clamp((f - iB.z)/(0.25*f), 0.0, 1.0)*(1.0 - smoothstep(uLod.x - uLod.z, uLod.x, d));
    vFade = vec2(0.0, sc > 0.01 ? 2.0 : 0.0);
  }
  vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vRel = rel0; vEx = vec4(0.0);
  if (vFade.y <= vFade.x + 0.01) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float c = cos(iB.x), s = sin(iB.x);
  vec3 lp = aP*sc*vec3(wide, pow(wide, 0.35), wide);
  vec3 p = vec3(lp.x*c + lp.z*s, lp.y, -lp.x*s + lp.z*c);
  vec3 n = vec3(aN.x*c + aN.z*s, aN.y, -aN.x*s + aN.z*c);
  float mat = aX.z;
  float fol = abs(mat - 1.0) < 0.5 ? 1.0 : abs(mat - 2.0) < 0.5 ? 0.85 : abs(mat - 3.0) < 0.5 ? 0.4 : abs(mat - 4.0) < 0.5 ? 0.6 : 0.0;
  if (aX.y > 0.0) {
    // the shared gust field (gustMap, core.js) — the same gusts that roll across the meadow shading: each plant leans
    // with the gust at its spot (bend: quick to lean in, slow to spring back) and sways about that lean, harder in a
    // gust. Conifers (uStiff) are stiffer: less travel, quicker sway. Big trees sway slower than small ones.
    vec4 gm = gustMap(iA.xz);
    float bend = gm.x, gust = gm.y;
    vec2 wd = normalize(gm.zw + vec2(1e-5, 0.0));
    float k = 1.0 - 0.3*uStiff;
    float t = uTime*(1.5 + uMode*1.3)*(1.0 + 0.45*uStiff)*inversesqrt(clamp(iA.w, 0.4, 2.0))
            + iB.z*3.1416 - dot(iA.xz, GUST_DIR)*0.22;
    float osc = sin(t)*0.45 + sin(t*2.3 + p.y*0.35)*0.2;
    float amt = (0.2 + bend*1.05 + osc*(0.4 + 0.9*gust))*aX.y*uSway*sc*k;
    p.xz += wd*amt + vec2(-wd.y, wd.x)*sin(t*0.61 + iB.z*9.0)*amt*0.2; // a little cross-wind roll
    p.y -= abs(amt)*0.18;
    // leaves flutter, much harder when the gust is on them
    float fl = sin(uTime*(6.0 + 5.0*gust) + iB.z*50.0 + dot(aP, vec3(3.1, 2.3, 2.7)));
    p += n*fl*fol*aX.y*uSway*(0.035 + 0.075*gust)*sc*k;
    vWind = vec2(fl*gust*fol*aX.y, bend);
    if (uMode > 0.5 && uG.w > 0.0) {
      vec2 dg = iA.xz + p.xz - uG.xz; float r2 = dot(dg, dg);
      float push = uG.w*exp(-r2/14.0);
      p.xz += dg/sqrt(r2 + 0.3)*push*aX.y*0.7; p.y -= push*aX.y*0.25*sc;
    }
  }
  vec3 col = aC;
  if (abs(mat - 2.0) < 0.5) { // grass: match the terrain's meadow colour at this spot
    float vv = vn(iA.xz*0.004 + vec2(5.5, 2.5)), vv2 = vn(iA.xz*0.021 + vec2(1.5, 8.5));
    vec3 g = mix(vec3(0.33,0.58,0.22), vec3(0.62,0.72,0.28), smoothstep(0.3, 0.78, vv));
    col *= mix(g, vec3(0.22,0.46,0.20), smoothstep(0.5, 0.85, vv2)*0.55);
  }
  float tint = iB.y;
  col *= mix(vec3(0.88, 0.93, 0.98), vec3(1.1, 1.05, 0.86), fract(tint));
  if (tint > 1.5 && fol > 0.9) { // a few trees already turning gold
    float l = dot(col, vec3(0.35, 0.55, 0.1));
    col = mix(col, l*vec3(1.95, 1.5, 0.42), 0.5 + 0.3*sin(dot(aP, vec3(1.3, 0.7, 1.1))));
  }
  vec3 rel = iA.xyz + p - uCam;
  vN = n; vCol = col; vRel = rel; vEx = vec4(aX.x, aX.y, fol, aX.w);
  gl_Position = uVP*vec4(rel, 1.0);
}`, GLSL_COMMON + MESH.LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec4 vEx; in vec2 vFade; in vec2 vWind; out vec4 o;
void main(){
  float b = bayer4(gl_FragCoord.xy);
  if (b < vFade.x || b >= vFade.y) discard;
  vec3 n = normalize(vN); vec3 v = normalize(vRel);
  if (uShadowPass > 0.5 && vEx.z < 0.95) { o = vec4(0.0); return; }
  vec3 alb = toLin(vCol);
  // wind: fluttering leaves flash their paler undersides and crowns lighten a touch as a gust rolls through; grass
  // blades bent by a gust show the same sheen as the meadow under them (terrain shader)
  float isGrass = step(0.8, vEx.z)*step(vEx.z, 0.9);
  alb *= 1.0 + vWind.x*0.2 + mix((vWind.y - GUST_MEAN)*0.12*step(0.5, vEx.z), (vWind.y - 0.1)*0.9, isGrass);
  // close up, leaves get leaf-sized bumps in shading and colour, and facets seen edge-on are nibbled away in the
  // same pattern so clump silhouettes read as ragged foliage instead of polygons (fades out long before the mid LOD)
  float close = 1.0 - smoothstep(30.0, 80.0, length(vRel));
  float leaf = step(0.95, vEx.z)*close, needle = step(0.55, vEx.z)*step(vEx.z, 0.65)*close*0.8;
  if (leaf + needle > 0.0) {
    vec3 q = (vRel + uCam)*(2.1 + needle*2.0);
    vec3 h = sin(q.yzx*1.31 + sin(q.zxy*1.73)*1.6), h2 = sin(q.zxy*3.7 + h*2.0);
    float lf = h.x*h.y*h.z, lf2 = h2.x*h2.y;
    if (leaf > 0.0) {
      vec3 fn = normalize(cross(dFdx(vRel), dFdy(vRel)));
      if (abs(dot(fn, v)) < leaf*(0.12 + 0.3*(0.5 + 0.5*lf) + 0.18*lf2)) discard;
    }
    if (uShadowPass > 0.5) { o = vec4(0.0); return; }
    n = normalize(n + (h*0.36 + h2*0.2)*(leaf + needle));
    alb *= 1.0 + (lf*0.2 + lf2*0.08)*(leaf + needle);
  }
  if (uShadowPass > 0.5) { o = vec4(0.0); return; }
  gShadow = sunShadow(vRel, n);
  vec3 col = lightMesh(alb, n, v, vEx.x, vEx.w, vEx.z);
  o = vec4(fogIt(col, vRel), 1.0);
}`);
  const U = PR.u;

  // ───── instance batches: one dynamic buffer, one range (slot) per mesh ─────
  function makeVao(mesh, buf) {
    const a = gl.createVertexArray();
    gl.bindVertexArray(a);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]]) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, ST * 4, off * 4); gl.vertexAttribDivisor(loc, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, off] of [[4, 0], [5, 4]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off * 4); gl.vertexAttribDivisor(loc, 1); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    return a;
  }
  function makeBatch(cap, meshes) {
    const data = new Float32Array(cap * 8), buf = buffer(data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    return { cap, data, buf, meshes, vaos: meshes.map(m => makeVao(m, buf)), off: new Int32Array(meshes.length), n: new Int32Array(meshes.length), cur: new Int32Array(meshes.length), total: 0 };
  }
  function uploadBatch(B) {
    if (!B.total) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, B.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, B.data, 0, B.total * 8);
  }
  function drawSlot(B, s) {
    const n = B.n[s];
    if (!n) return;
    gl.bindVertexArray(B.vaos[s]);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.buf);
    const o = B.off[s] * 32;
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 32, o);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 32, o + 16);
    gl.drawElementsInstanced(gl.TRIANGLES, B.meshes[s].count, gl.UNSIGNED_INT, 0, n);
  }
  const DBG = { lod: [true, true, true], grass: true, farFilter: true };
  const slotMeshes = [];
  for (const K of KINDS) slotMeshes.push(...K.lods);
  function beginDraw() {
    gl.useProgram(PR.p); setEnv(PR);
    gl.uniform1f(U.uSpec, 0.035); gl.uniform1f(U.uNoFog, 0);
  }
  function drawTrees(B, force) {
    gl.uniform1f(U.uMode, 0);
    gl.enable(gl.CULL_FACE);
    for (let lod = 0; lod < 3; lod++) for (let k = 0; k < NK; k++) {
      const s = k * 3 + lod, K = KINDS[k];
      if (!B.n[s] || !DBG.lod[lod]) continue;
      gl.uniform4f(U.uLod, K.band[lod][0], K.band[lod][1], K.W, force ? 1 : 0);
      gl.uniform1f(U.uSway, K.sway); gl.uniform1f(U.uStiff, K.species === 'conifer' ? 1 : K.species === 'bush' ? 0.4 : 0);
      drawSlot(B, s);
    }
    gl.disable(gl.CULL_FACE);
  }
  function drawGrass(B, gx, gy, gz, gw) {
    gl.uniform1f(U.uMode, 1);
    gl.uniform4f(U.uLod, GR, GR_FULL, FF.on ? 40 : 22, 0);
    gl.uniform1f(U.uSway, 0.13); gl.uniform1f(U.uStiff, 0);
    if (U.uG) gl.uniform4f(U.uG, gx, gy, gz, gw);
    for (let s = 0; s < NG; s++) drawSlot(B, s);
  }

  // ───── world tiles ─────
  // The near tiles draw meshes out to the mid LOD's reach (trees 300 m, bushes 120 m) and carry the crash test; beyond,
  // the far forest (below) draws the same plants as impostors
  const TILE = 128, CELL = 8, NC = TILE / CELL, GS = 16, GN = TILE / GS + 1;
  // FAR_MAX: the near tiles' reach — the mid LOD's with the far forest on (High), the far meshes' otherwise (Medium, Low)
  const CAPS = [1500, 5000, 12000], MARGIN = 20, FAR_MESH = 1300; // MARGIN > camera travel between rebuilds (16 m)
  let FAR_MAX = Math.max(TREE.R2, SHRUB.R2) + MARGIN;
  const tiles = new Map();
  const tkey = (i, j) => (i + 32768) * 65536 + (j + 32768);
  // coarse grids on a 16 m lattice: height, forest mask, copse / altitude-jitter / grove noises; candidates read them
  // bilinearly, and only accepted plants pay for an exact terrainH. A near tile fills its 9×9 points up front; the far
  // forest's tiles (up to 1 km, 65×65 points, sparse cells) evaluate the points their candidates touch, on demand
  const LMAX = 65 * 65;
  const hgrid = new Float64Array(LMAX), fgrid = new Float64Array(LMAX), cgrid = new Float64Array(LMAX);
  const agrid = new Float64Array(LMAX), vgrid = new Float64Array(LMAX), GRIDS = [hgrid, fgrid, cgrid, agrid, vgrid];
  function latVal(g, x, z) {
    if (g === 0) return terrainH(x, z, 1);
    if (g === 1) return forestMask(x, z);
    // copses: small domain-warped blobs of trees in open country
    if (g === 2) return vn(x * 0.0105 + 17.3 + (vn(x * 0.021 + 3.1, z * 0.021) - 0.5) * 1.2, z * 0.0105 + 5.9 + (vn(x * 0.021, z * 0.021 + 7.7) - 0.5) * 1.2);
    if (g === 3) return vn(x * 0.0037 + 2.2, z * 0.0037 + 6.1);
    return vn(x * 0.013 + 4.4, z * 0.013 + 1.3);
  }
  const LZ = { on: false, x0: 0, z0: 0, n: 0, gen: 0, stamp: GRIDS.map(() => new Int32Array(LMAX)) };
  function lazyGrid(g) { // lazy mode: evaluate the four corners of GI's lattice cell in grid g
    if (!LZ.on) return;
    const st = LZ.stamp[g], arr = GRIDS[g], n = LZ.n;
    for (let c = 0; c < 4; c++) {
      const i = GI.i + (c & 1) + (c >> 1) * n;
      if (st[i] === LZ.gen) continue;
      st[i] = LZ.gen;
      const a = i % n;
      arr[i] = latVal(g, LZ.x0 + a * GS, LZ.z0 + (i - a) / n * GS);
    }
  }
  const GI = { i: 0, n: 0, tx: 0, tz: 0, cell: 1 };
  function gridAt(x0, z0, x, z, cell, n) {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    const ia = Math.min(n - 2, Math.max(0, Math.floor(fx))), ib = Math.min(n - 2, Math.max(0, Math.floor(fz)));
    GI.i = ib * n + ia; GI.n = n; GI.tx = fx - ia; GI.tz = fz - ib; GI.cell = cell;
  }
  function bil(g) {
    const i = GI.i, n = GI.n, a = g[i], b = g[i + 1], c = g[i + n], d = g[i + n + 1];
    return a + (b - a) * GI.tx + (c - a) * GI.tz + (a - b - c + d) * GI.tx * GI.tz;
  }
  function slopeNy(g) { // normal.y of the bilinear height patch
    const i = GI.i, n = GI.n, a = g[i], b = g[i + 1], c = g[i + n], d = g[i + n + 1], tx = GI.tx, tz = GI.tz;
    const gx = ((b - a) * (1 - tz) + (d - c) * tz) / GI.cell, gz = ((c - a) * (1 - tx) + (d - b) * tx) / GI.cell;
    return 1 / Math.sqrt(1 + gx * gx + gz * gz);
  }
  const scratch = [];
  for (let k = 0; k < NK; k++) scratch.push(new Float32Array(NC * NC * 8));
  const scount = new Int32Array(NK), collScratch = new Float32Array(NC * NC * 2 * 5);
  let nColl = 0, tyMin = 0, tyMax = 0;
  function push(k, x, y, z, s, rot, tint, seed, far) {
    if (LZ.on) { // a far-forest tile: (x, y, z, scale, rotation, tint, rank, kind)
      if ((farN + 1) * 8 > farOut.length) { const t = new Float32Array(farOut.length * 2); t.set(farOut); farOut = t; }
      const o = farN++ * 8;
      farOut[o] = x; farOut[o + 1] = y; farOut[o + 2] = z; farOut[o + 3] = s; farOut[o + 4] = rot; farOut[o + 5] = tint; farOut[o + 6] = farRank; farOut[o + 7] = k;
      return;
    }
    const d = scratch[k], o = scount[k]++ * 8;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = s; d[o + 4] = rot; d[o + 5] = tint; d[o + 6] = seed; d[o + 7] = far;
    const K = KINDS[k];
    if (y < tyMin) tyMin = y;
    if (y + K.top * s > tyMax) tyMax = y + K.top * s;
    if (K.coll.cR > 0 && (K.species !== 'bush' || s > 1.0)) {
      const c = nColl++ * 5;
      collScratch[c] = x; collScratch[c + 1] = y; collScratch[c + 2] = z; collScratch[c + 3] = k; collScratch[c + 4] = s;
    }
  }
  const pick3 = (r, a, b) => (r < a ? 0 : r < a + b ? 1 : 2);
  const BROAD_FOREST = [K_BEECH, K_LINDEN, K_OAK], BROAD_OPEN = [K_OAK, K_LINDEN, K_BEECH];
  function placeTree(gx, gz, x, z, h, ny, fm, place) {
    const alt = h + (bil(agrid) - 0.5) * 140;
    const conP = ss(170, 330, alt);
    const rs = hs(gx, gz, 8), rv = hs(gx, gz, 9), rsc = hs(gx, gz, 10);
    let k;
    if (place === 0) { // forest: conifers take over with altitude, birch groves and birch-rich edges, else broadleaf
      const pCon = conP * 0.93 + 0.04;
      const pBir = (0.05 + 0.28 * (1 - ss(0.3, 0.8, fm)) + 0.35 * ss(0.62, 0.75, bil(vgrid))) * (1 - conP * 0.8);
      if (rs < pCon) k = K_FIR + (h > 470 ? pick3(rv, 0.3, 0.2) : pick3(rv, 0.45, 0.37));
      else if (rs < pCon + pBir) k = rv < 0.64 ? K_BIRCH : K_BIRCH3;
      else k = BROAD_FOREST[pick3(rv, 0.4, 0.3)];
    } else if (place === 1) { // copse
      if (rs < conP * 0.85) k = K_FIR + pick3(rv, 0.35, 0.3);
      else if (rs < conP * 0.85 + 0.3) k = K_BIRCH + pick3(rv, 0.5, 0.3);
      else k = BROAD_OPEN[pick3(rv, 0.45, 0.35)];
    } else { // lone tree in a meadow
      if (rs < conP * 0.85) k = K_FIR + pick3(rv, 0.45, 0.25);
      else if (rs > 0.84) k = rv < (h < 140 ? 0.45 : 0.1) ? K_POPLAR : rv < 0.75 ? K_BIRCH : K_BIRCH3;
      else k = BROAD_OPEN[pick3(rv, 0.6, 0.25)];
    }
    const sp = KINDS[k].species;
    let s = sp === 'conifer' ? 0.72 + rsc * 0.5 : sp === 'birch' ? 0.8 + rsc * 0.4 : 0.78 + rsc * 0.42;
    if (place === 2 && sp === 'broadleaf') s *= 1.14;
    s *= 1 - 0.32 * ss(460, 620, h);
    let tint = hs(gx, gz, 12);
    if (sp === 'broadleaf' && place === 0 && hs(gx, gz, 13) < 0.016) tint += 2;
    const far = place === 0 ? 560 + 700 * hs(gx, gz, 15) : FAR_MESH;
    push(k, x, h - 0.45 - (1 - ny) * 6, z, s, hs(gx, gz, 11) * TAU, tint, hs(gx, gz, 14), far);
  }
  // keep plants off buildings, ruins and walls (LANDMARKS loads after this file and may be absent in isolated builds)
  const occupied = (x, z, pad) => { try { return LANDMARKS.occupied(x, z, pad); } catch (e) { return false; } };
  // one 8 m cell's tree candidate: forest, copse or lone meadow tree (shared by the near tiles and the far forest)
  function treeCand(gx, gz, x0, z0, n) {
    const r1 = hs(gx, gz, 1);
    if (r1 >= 0.9) return;
    const x = (gx + 0.5 + (hs(gx, gz, 2) - 0.5) * 0.9) * CELL, z = (gz + 0.5 + (hs(gx, gz, 3) - 0.5) * 0.9) * CELL;
    gridAt(x0, z0, x, z, GS, n); lazyGrid(1);
    const fm = bil(fgrid);
    let p = ss(0.1, 0.65, fm) * 0.9, place = 0;
    if (p < 0.6) {
      lazyGrid(2);
      const pc = ss(0.72, 0.82, bil(cgrid)) * 0.62 * (1 - fm);
      if (pc > p) { p = pc; place = 1; }
      if (p < 0.011) { p = 0.011; place = 2; }
    }
    if (r1 >= p) return;
    lazyGrid(0);
    const hc = bil(hgrid);
    if (!(hc > 1.5 && hc < 640 && slopeNy(hgrid) > 0.8)) return;
    const h = terrainH(x, z, 1);
    if (h > 3 + hs(gx, gz, 6) * 2.5 && hs(gx, gz, 7) < ss(625, 520, h)) {
      const ex = h - terrainH(x + 1.5, z, 1), ez = h - terrainH(x, z + 1.5, 1), ny = 1.5 / Math.sqrt(ex * ex + 2.25 + ez * ez);
      if (ny > 0.84 + (hs(gx, gz, 5) - 0.5) * 0.03 && !occupied(x, z, 4.5)) { lazyGrid(3); lazyGrid(4); placeTree(gx, gz, x, z, h, ny, fm, place); }
    }
  }
  // one cell's bush candidate: meadows, forest edges and copse fringes
  function bushCand(gx, gz, x0, z0, n) {
    const rb = hs(gx, gz, 20);
    if (rb >= 0.4) return;
    const x = (gx + 0.5 + (hs(gx, gz, 21) - 0.5) * 0.95) * CELL, z = (gz + 0.5 + (hs(gx, gz, 22) - 0.5) * 0.95) * CELL;
    gridAt(x0, z0, x, z, GS, n); lazyGrid(1);
    const fm = bil(fgrid);
    if (fm >= 0.8) return;
    lazyGrid(2);
    const edge = ss(0.02, 0.25, fm) * (1 - ss(0.45, 0.8, fm));
    const p = 0.045 + 0.32 * edge + 0.3 * ss(0.66, 0.76, bil(cgrid)) * (1 - fm);
    if (rb >= p) return;
    lazyGrid(0);
    const hc = bil(hgrid), ny = slopeNy(hgrid);
    if (!(hc > 2 && hc < 620 && ny > 0.82)) return;
    const h = terrainH(x, z, 1);
    if (h > 3.5 + hs(gx, gz, 23) * 2 && h < 600 && !occupied(x, z, 1.5)) {
      const k = hs(gx, gz, 24) < (fm < 0.05 ? 0.3 : 0.1) ? K_BLOSSOM : hs(gx, gz, 25) < 0.4 ? K_LOWBUSH : K_BUSH;
      push(k, x, h - 0.25 - (1 - ny) * 3, z, (0.6 + 0.75 * hs(gx, gz, 26)) * (1 - 0.3 * ss(450, 600, h)), hs(gx, gz, 27) * TAU,
        hs(gx, gz, 28), hs(gx, gz, 29), 280 + 160 * hs(gx, gz, 30));
    }
  }
  function genTile(ti, tj) {
    const x0 = ti * TILE, z0 = tj * TILE;
    let gmin = 1e9, gmax = -1e9;
    for (let b = 0; b < GN; b++) for (let a = 0; a < GN; a++) {
      const h = latVal(0, x0 + a * GS, z0 + b * GS);
      hgrid[b * GN + a] = h;
      if (h < gmin) gmin = h;
      if (h > gmax) gmax = h;
    }
    scount.fill(0); nColl = 0; tyMin = 1e9; tyMax = -1e9;
    if (gmax > 2 && gmin < 650) {
      for (let b = 0; b < GN; b++) for (let a = 0; a < GN; a++) {
        const x = x0 + a * GS, z = z0 + b * GS, q = b * GN + a;
        fgrid[q] = latVal(1, x, z); cgrid[q] = latVal(2, x, z); agrid[q] = latVal(3, x, z); vgrid[q] = latVal(4, x, z);
      }
      for (let b = 0; b < NC; b++) for (let a = 0; a < NC; a++) {
        const gx = ti * NC + a, gz = tj * NC + b;
        treeCand(gx, gz, x0, z0, GN);
        bushCand(gx, gz, x0, z0, GN);
      }
    }
    const lists = [], mems = [], minFar = [];
    let n = 0;
    for (let k = 0; k < NK; k++) if (scount[k]) {
      const arr = scratch[k].slice(0, scount[k] * 8);
      let mf = 1e9;
      for (let o = 7; o < arr.length; o += 8) mf = Math.min(mf, arr[o]);
      lists.push(k, arr); mems.push(new Uint8Array(scount[k])); minFar.push(mf); n += scount[k];
    }
    return { x0, z0, lists, mems, minFar, flags: new Uint8Array(lists.length / 2), n, coll: collScratch.slice(0, nColl * 5), nColl, yMin: n ? tyMin - 1 : 0, yMax: n ? tyMax + 1 : 0, vis: 0 };
  }

  // needed tiles around the camera, nearest first
  const NEEDMAX = 1024;
  const need = { n: 0, key: new Float64Array(NEEDMAX), i: new Int32Array(NEEDMAX), j: new Int32Array(NEEDMAX), d: new Float32Array(NEEDMAX), ti: 1e9, tj: 1e9, band: -1, first: 0 };
  const needTmp = { d: new Float32Array(NEEDMAX), i: new Int32Array(NEEDMAX), j: new Int32Array(NEEDMAX) }, needIdx = new Int32Array(NEEDMAX);
  const byNeedDist = (a, b) => needTmp.d[a] - needTmp.d[b];
  function computeNeeded(cx, cy, cz) {
    const dy = Math.max(0, cy - 660), R = FAR_MAX + 40, Rh = dy >= R ? 0 : Math.sqrt(R * R - dy * dy);
    const i0 = Math.floor((cx - Rh) / TILE), i1 = Math.floor((cx + Rh) / TILE), j0 = Math.floor((cz - Rh) / TILE), j1 = Math.floor((cz + Rh) / TILE);
    let n = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const dx = Math.max(i * TILE - cx, 0, cx - (i + 1) * TILE), dz = Math.max(j * TILE - cz, 0, cz - (j + 1) * TILE);
      const d = Math.hypot(dx, dz);
      if (d < Rh && n < NEEDMAX) { needTmp.d[n] = d; needTmp.i[n] = i; needTmp.j[n] = j; needIdx[n] = n; n++; }
    }
    needIdx.subarray(0, n).sort(byNeedDist);
    need.n = n;
    for (let q = 0; q < n; q++) {
      const o = needIdx[q];
      need.d[q] = needTmp.d[o]; need.i[q] = needTmp.i[o]; need.j[q] = needTmp.j[o]; need.key[q] = tkey(needTmp.i[o], needTmp.j[o]);
    }
    need.first = 0;
  }
  let tilesDirty = true, tilesLate = false; // new tiles near the camera force a rebuild; far ones ride along with the next one
  function generate(urgentOnly) {
    const t0 = performance.now();
    let made = 0;
    for (let q = need.first; q < need.n; q++) {
      if (tiles.has(need.key[q])) { if (q === need.first) need.first++; continue; }
      // near the camera never leave holes; farther out spend at most a sliver of the frame (none on rebuild frames)
      const urgent = need.d[q] < 420;
      if (!urgent && urgentOnly) break;
      if (made > 0 && (performance.now() - t0 > (urgent ? 3 : 0.25) || made >= (urgent ? 8 : 3))) break;
      tiles.set(need.key[q], genTile(need.i[q], need.j[q]));
      made++; if (urgent) tilesDirty = true; else tilesLate = true;
    }
    return made;
  }
  function evict(cx, cz) {
    if (tiles.size < 800) return;
    for (const [k, t] of tiles) if (Math.abs(t.x0 + TILE / 2 - cx) > 2000 || Math.abs(t.z0 + TILE / 2 - cz) > 2000) tiles.delete(k);
  }

  // conservative view frustum (widened so small turns between rebuilds stay covered)
  const planes = new Float64Array(20);
  function setPlane(p, x, y, z) { const l = Math.hypot(x, y, z) || 1; planes[p * 4] = x / l; planes[p * 4 + 1] = y / l; planes[p * 4 + 2] = z / l; }
  function setPlanes(cam, widen) {
    const tx = cam.tanX * widen + 0.05, ty = cam.tanY * widen + 0.05, f = cam.f, r = cam.r, u = cam.u;
    setPlane(0, f[0] * tx - r[0], f[1] * tx - r[1], f[2] * tx - r[2]); setPlane(1, f[0] * tx + r[0], f[1] * tx + r[1], f[2] * tx + r[2]);
    setPlane(2, f[0] * ty - u[0], f[1] * ty - u[1], f[2] * ty - u[2]); setPlane(3, f[0] * ty + u[0], f[1] * ty + u[1], f[2] * ty + u[2]);
    setPlane(4, f[0], f[1], f[2]);
  }
  function boxVisible(x0, y0, z0, x1, y1, z1, cx, cy, cz, m) {
    for (let p = 0; p < 5; p++) {
      const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2];
      if (a * ((a > 0 ? x1 : x0) - cx) + b * ((b > 0 ? y1 : y0) - cy) + c * ((c > 0 ? z1 : z0) - cz) < -m) return false;
    }
    return true;
  }

  const WB = makeBatch(CAPS[0] + CAPS[1] + CAPS[2], slotMeshes);
  const last = { x: 1e9, y: 0, z: 0, f: [0, 0, 0], ty: 0, t: 0, lod: [0, 0, 0], ms: 0, gen: 0 };
  const lodT = new Int32Array(3);
  // Per-instance LOD membership for tiles that straddle a band edge: one distance test per instance sets a bit per
  // LOD (near / mid / far, the far band also ending at each instance's own fade distance); counts go to cnt3.
  const cnt3 = new Int32Array(3);
  function classify(arr, mem, K, cx, cy, cz, want) {
    cnt3[0] = cnt3[1] = cnt3[2] = 0;
    const b = K.band, W = K.W + MARGIN;
    const n1 = (b[0][1] + MARGIN) ** 2, m0 = Math.max(0, b[1][0] - W) ** 2, m1 = (b[1][1] + MARGIN) ** 2;
    const f0 = Math.max(0, b[2][0] - W) ** 2, f1 = (K.FAR + MARGIN) ** 2;
    for (let i = 0, o = 0; o < arr.length; i++, o += 8) {
      const dx = arr[o] - cx, dy = arr[o + 1] - cy, dz = arr[o + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
      let bits = 0;
      if ((want & 1) && d2 <= n1) { bits |= 1; cnt3[0]++; }
      if ((want & 2) && d2 >= m0 && d2 <= m1) { bits |= 2; cnt3[1]++; }
      if ((want & 4) && d2 >= f0 && d2 <= f1) { const fe = arr[o + 7] + MARGIN; if (d2 <= fe * fe) { bits |= 4; cnt3[2]++; } }
      mem[i] = bits;
    }
  }
  function rebuild(cx, cy, cz) {
    const B = WB;
    B.n.fill(0); lodT.fill(0);
    for (let q = 0; q < need.n; q++) {
      const t = tiles.get(need.key[q]);
      if (!t) continue;
      t.vis = 0;
      if (!t.n) continue;
      const x0 = t.x0, z0 = t.z0, x1 = x0 + TILE, z1 = z0 + TILE;
      const dx = Math.max(x0 - cx, 0, cx - x1), dy = Math.max(t.yMin - cy, 0, cy - t.yMax), dz = Math.max(z0 - cz, 0, cz - z1);
      const minD = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (minD > FAR_MAX + MARGIN) continue;
      // widened by how far a tree's shadow can reach, so casters just off-screen still shadow what is on it
      if (!boxVisible(x0, t.yMin, z0, x1, t.yMax, z1, cx, cy, cz, 18 + Math.min(35 / Math.max(GLX.env.sun[1], 0.2), 140))) continue;
      const ex = Math.max(cx - x0, x1 - cx), ey = Math.max(cy - t.yMin, t.yMax - cy), ez = Math.max(cz - z0, z1 - cz);
      const maxD = Math.sqrt(ex * ex + ey * ey + ez * ez);
      t.vis = 1;
      for (let l = 0; l < t.lists.length; l += 2) {
        const li = l >> 1, k = t.lists[l], K = KINDS[k], arr = t.lists[l + 1], n = arr.length >> 3;
        // per LOD: 0 = not needed, 1 = whole list (tile inside the band), 2 = per instance
        let bulk = 0, want = 0;
        for (let lod = 0; lod < (FF.on ? 2 : 3); lod++) { // with the far forest on, its impostors replace the far meshes
          const d0 = K.band[lod][0] - K.W - MARGIN, d1 = (lod === 2 ? K.FAR : K.band[lod][1]) + MARGIN;
          if (maxD < d0 || minD > d1) continue;
          if (minD >= d0 && maxD <= (lod === 2 ? Math.min(d1, t.minFar[li] + MARGIN) : d1)) bulk |= 1 << lod; else want |= 1 << lod;
        }
        if (want) classify(arr, t.mems[li], K, cx, cy, cz, want);
        let f = 0;
        for (let lod = 0; lod < 3; lod++) {
          const c = bulk & (1 << lod) ? n : want & (1 << lod) ? cnt3[lod] : 0;
          if (!c || lodT[lod] + c > CAPS[lod]) continue;
          f |= (bulk & (1 << lod) ? 1 : 2) << (lod * 2); B.n[k * 3 + lod] += c; lodT[lod] += c;
        }
        t.flags[li] = f;
      }
    }
    let o = 0;
    for (let s = 0; s < B.n.length; s++) { B.off[s] = o; B.cur[s] = o; o += B.n[s]; }
    B.total = o;
    const data = B.data, cur = B.cur;
    for (let q = 0; q < need.n; q++) {
      const t = tiles.get(need.key[q]);
      if (!t || !t.vis) continue;
      for (let l = 0; l < t.lists.length; l += 2) {
        const li = l >> 1, f = t.flags[li];
        if (!f) continue;
        const k = t.lists[l], arr = t.lists[l + 1], s0 = k * 3;
        let per = 0;
        for (let lod = 0; lod < 3; lod++) {
          const m = (f >> (lod * 2)) & 3;
          if (m === 1) { data.set(arr, cur[s0 + lod] * 8); cur[s0 + lod] += arr.length >> 3; }
          else if (m === 2) per |= 1 << lod;
        }
        if (!per) continue;
        const mem = t.mems[li];
        for (let i = 0, o2 = 0; o2 < arr.length; i++, o2 += 8) {
          const bits = mem[i] & per;
          if (!bits) continue;
          for (let lod = 0; lod < 3; lod++) {
            if (!(bits & (1 << lod))) continue;
            const w = cur[s0 + lod]++ * 8;
            data[w] = arr[o2]; data[w + 1] = arr[o2 + 1]; data[w + 2] = arr[o2 + 2]; data[w + 3] = arr[o2 + 3];
            data[w + 4] = arr[o2 + 4]; data[w + 5] = arr[o2 + 5]; data[w + 6] = arr[o2 + 6]; data[w + 7] = arr[o2 + 7];
          }
        }
      }
    }
    uploadBatch(B);
    last.lod[0] = lodT[0]; last.lod[1] = lodT[1]; last.lod[2] = lodT[2];
  }

  // ───── impostors (view range, ticket 14): every tree and bush kind seen from 64 directions over the upper hemisphere ─────
  // Frames sit on a hemi-octahedral grid (IG×IG, the grid's edge is the horizon, its centre looks straight down), each
  // an orthographic view of the kind's mid LOD fitted to its bounding sphere. Two texture arrays, one layer per frame
  // (no bleeding between frames at any mip): premultiplied colour + coverage, and premultiplied normal (the tree's own
  // frame) + ambient occlusion. Captured once at load with 4× MSAA, so edges and mips carry fractional coverage.
  const IG = 8, IF = 64, NFR = IG * IG;
  const impK = new Float32Array(NK * 4); // per kind: bounding-sphere centre (x, y, z) and radius, unscaled
  const impC = new Float32Array(NK * 8); // per kind: bounding cylinder (centre x, bottom, centre z, radius), (top, -, -, -)
  KINDS.forEach((K, k) => { const c = K.cyl; impC.set([c[0], c[3], c[1], c[2], c[4], 0, 0, 0], k * 8); });
  const IMP_GLSL = `
const float IG = ${IG}.0;
vec2 hemiOct(vec3 d){ d.y = max(d.y, 0.0); d /= abs(d.x) + d.y + abs(d.z); return vec2(d.x + d.z, d.x - d.z); }
vec3 hemiOctDec(vec2 e){ vec3 d = vec3((e.x + e.y)*0.5, 0.0, (e.x - e.y)*0.5); d.y = 1.0 - abs(d.x) - abs(d.z); return normalize(d); }
// frame (i, j)'s view direction (toward the viewer) and image axes
vec3 frameDir(vec2 ij){ return hemiOctDec(ij/(IG - 1.0)*2.0 - 1.0); }
void frameBasis(vec3 d, out vec3 r, out vec3 u){ r = normalize(cross(vec3(0.0, 1.0, 0.0), d)); u = cross(d, r); }
`;
  const impAlb = gl.createTexture(), impNrm = gl.createTexture(), UNIT_IA = 20, UNIT_IN = 21;
  (function captureImpostors() {
    const T = gl.TEXTURE_2D_ARRAY, layers = NK * NFR, lv = Math.log2(IF) + 1;
    // colour in sRGB storage so the MSAA resolve and the mips average in linear light (in gamma space a crown's bright
    // tops and dark gaps average ~40% too dark)
    for (const [t, u, f] of [[impAlb, UNIT_IA, gl.SRGB8_ALPHA8], [impNrm, UNIT_IN, gl.RGBA8]]) {
      gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(T, t);
      gl.texStorage3D(T, lv, f, IF, IF, layers);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(T, k, v);
    }
    const CP = program(`
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
uniform vec3 uR, uU, uD; uniform vec4 uS; out vec3 vN; out vec3 vC; out float vAO;
void main(){ vec3 q = aP - uS.xyz; vN = aN; vC = aC; vAO = aX.x;
  gl_Position = vec4(dot(q, uR)/uS.w, dot(q, uU)/uS.w, -dot(q, uD)/uS.w, 1.0); }`, `
in vec3 vN; in vec3 vC; in float vAO; layout(location=0) out vec4 oA; layout(location=1) out vec4 oN;
void main(){ oA = vec4(pow(clamp(vC, 0.0, 1.0), vec3(2.2)), 1.0); oN = vec4(normalize(vN)*0.5 + 0.5, vAO); }`);
    const fbM = gl.createFramebuffer(), fbL = gl.createFramebuffer(), rb = [0, 1, 2].map(() => gl.createRenderbuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbM);
    [gl.SRGB8_ALPHA8, gl.RGBA8, gl.DEPTH_COMPONENT24].forEach((f, i) => {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb[i]); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, f, IF, IF);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, i < 2 ? gl.COLOR_ATTACHMENT0 + i : gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb[i]);
    });
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const vao = gl.createVertexArray();
    gl.useProgram(CP.p); gl.viewport(0, 0, IF, IF);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    const dec = (i, j) => { // frameDir() in JS
      const ex = i / (IG - 1) * 2 - 1, ey = j / (IG - 1) * 2 - 1, x = (ex + ey) / 2, z = (ex - ey) / 2;
      return nrm([x, 1 - Math.abs(x) - Math.abs(z), z]);
    };
    for (let k = 0; k < NK; k++) {
      const m = KINDS[k].lods[1], lo = m.bounds.lo, hi = m.bounds.hi;
      const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], R = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 * 1.02;
      impK.set([c[0], c[1], c[2], R], k * 4);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
      for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, ST * 4, off * 4); gl.vertexAttribDivisor(loc, 0); }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
      gl.uniform4f(CP.u.uS, c[0], c[1], c[2], R);
      for (let j = 0; j < IG; j++) for (let i = 0; i < IG; i++) {
        const d = dec(i, j), r = nrm(cross([0, 1, 0], d)), u = cross(d, r), layer = k * NFR + j * IG + i;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbM);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform3fv(CP.u.uR, r); gl.uniform3fv(CP.u.uU, u); gl.uniform3fv(CP.u.uD, d);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
        // resolve each attachment into its layer
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbM); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbL);
        for (let a = 0; a < 2; a++) {
          gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, a ? impNrm : impAlb, 0, layer);
          gl.readBuffer(gl.COLOR_ATTACHMENT0 + a); gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.blitFramebuffer(0, 0, IF, IF, 0, 0, IF, IF, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        }
      }
    }
    gl.bindVertexArray(null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.CULL_FACE); gl.clearColor(0, 0, 0, 1);
    for (const r of rb) gl.deleteRenderbuffer(r);
    gl.deleteFramebuffer(fbM); gl.deleteFramebuffer(fbL);
    for (const [t, u] of [[impAlb, UNIT_IA], [impNrm, UNIT_IN]]) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(T, t); gl.generateMipmap(T); }
    gl.activeTexture(gl.TEXTURE0);
  })();

  // ───── far forest (view range, ticket 14): the same trees and bushes as the near tiles, out to FF.end, as impostors ─────
  // Quadtree tiles: level k is 256·2^k m and covers its 32×32 cells of 8·2^k m, each standing for one 8 m cell of the
  // near grid — the one it designates, chosen by hash level by level, so the cells a level designates are among those
  // the level below designates (the coarser a tile, the sparser the same plants). A plant's rank r falls in its top
  // designated level's band (level L: 4^-(L+1) ≤ r < 4^-L); the vertex shader keeps it while r < (d0/d)² and widens
  // what it keeps by d/d0 so a forest's cover holds as it thins. A level-k tile serves where the camera is ≥ d0·2^k
  // away, so it has every rank the thinning can keep there. Plants are placed by the near tiles' own code (treeCand,
  // bushCand), so where the impostors take over from the meshes (trees 300 m, bushes 120 m) they're the same plants.
  const FF = { d0: 1600, end: 10000, bushD0: 450, bushEnd: 2000, levels: 3, on: true, shadows: true, a2c: true };
  const FT0 = 256, KMAX = 3, FCAP = 524288; // the GPU pool holds up to FCAP instances, each drawn tile in one range
  let farOut = new Float32Array(4096 * 8), farN = 0, farRank = 1;
  // is the island's stored ground anywhere inside [x0, x0+S]² within the heights plants grow at? (sea and high mountain
  // tiles skip their 1024 candidates; the margins cover the bicubic's overshoot and the micro-relief)
  function farTileLive(x0, z0, S) {
    const I = typeof ISLAND !== 'undefined' && ISLAND;
    if (!I) return true;
    const n = I.n, h = I.h, a0 = Math.max(0, Math.floor((x0 - I.origin) * I.inv) - 2), a1 = Math.min(n - 1, Math.ceil((x0 + S - I.origin) * I.inv) + 2);
    const b0 = Math.max(0, Math.floor((z0 - I.origin) * I.inv) - 2), b1 = Math.min(n - 1, Math.ceil((z0 + S - I.origin) * I.inv) + 2);
    if (a0 > a1 || b0 > b1) return false;
    for (let b = b0; b <= b1; b++) for (let a = a0, o = b * n; a <= a1; a++) { const v = h[o + a]; if (v > -12 && v < 680) return true; }
    return false;
  }
  function genFarTile(k, ti, tj) {
    const S = FT0 << k, cs = CELL << k, x0 = ti * S, z0 = tj * S, c0x = x0 / cs, c0z = z0 / cs;
    if (!farTileLive(x0, z0, S)) return { data: new Float32Array(0), n: 0, off: -1, live: false, used: 0, x0, z0, S, y0: 0, y1: 0 };
    LZ.on = true; LZ.gen++; LZ.x0 = x0; LZ.z0 = z0; LZ.n = S / GS + 1;
    farN = 0;
    for (let b = 0; b < 32; b++) for (let a = 0; a < 32; a++) {
      let gx = c0x + a, gz = c0z + b;
      for (let j = k; j >= 1; j--) { const c = (hs(gx, gz, 60 + j) * 4) | 0; gx = gx * 2 + (c & 1); gz = gz * 2 + (c >> 1); }
      let L = k;
      while (L < KMAX && ((hs(gx >> (L + 1), gz >> (L + 1), 61 + L) * 4) | 0) === ((gx >> L) & 1) + 2 * ((gz >> L) & 1)) L++;
      farRank = L >= KMAX ? Math.pow(4, -KMAX) * hs(gx, gz, 59) : Math.pow(4, -(L + 1)) * (1 + 3 * hs(gx, gz, 59));
      treeCand(gx, gz, x0, z0, LZ.n);
      if (k === 0) bushCand(gx, gz, x0, z0, LZ.n);
    }
    LZ.on = false;
    let y0 = 1e9, y1 = -1e9;
    for (let o = 1; o < farN * 8; o += 8) { y0 = Math.min(y0, farOut[o]); y1 = Math.max(y1, farOut[o]); }
    return { data: farOut.slice(0, farN * 8), n: farN, off: -1, live: false, used: 0, x0, z0, S, y0: y0 - 5, y1: y1 + 80 };
  }
  const fkey = (k, i, j) => (k * 8192 + i + 4096) * 8192 + j + 4096;
  const ftiles = new Map(), fwant = [], fqueue = [];
  const fpoolBuf = buffer(new Float32Array(FCAP * 8), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  const ffree = [[0, FCAP]]; // free ranges [start, length], sorted by start
  let fzero = new Float32Array(8192 * 8), fFrame = 0;
  const fstat = { tiles: 0, active: 0, instances: 0, drawn: 0, runs: 0, gen: 0, ms: 0, queue: 0, tileMax: 0 };
  function falloc(n) {
    for (let q = 0; q < ffree.length; q++) {
      const r = ffree[q];
      if (r[1] < n) continue;
      const s0 = r[0]; r[0] += n; r[1] -= n;
      if (!r[1]) ffree.splice(q, 1);
      return s0;
    }
    return -1;
  }
  function frelease(s0, n) {
    let q = 0;
    while (q < ffree.length && ffree[q][0] < s0) q++;
    ffree.splice(q, 0, [s0, n]);
    if (q + 1 < ffree.length && s0 + n === ffree[q + 1][0]) { ffree[q][1] += ffree[q + 1][1]; ffree.splice(q + 1, 1); }
    if (q > 0 && ffree[q - 1][0] + ffree[q - 1][1] === s0) { ffree[q - 1][1] += ffree[q][1]; ffree.splice(q, 1); }
  }
  function fupload(t) {
    t.live = true;
    if (!t.n) return;
    t.off = falloc(t.n);
    if (t.off < 0) return; // pool full: this tile stays out
    gl.bindBuffer(gl.ARRAY_BUFFER, fpoolBuf); gl.bufferSubData(gl.ARRAY_BUFFER, t.off * 32, t.data, 0, t.n * 8);
    fstat.instances += t.n;
  }
  function funload(t) {
    t.live = false;
    if (!t.n || t.off < 0) return;
    // zeroed, so a draw run spanning the hole draws nothing there
    if (fzero.length < t.n * 8) fzero = new Float32Array(t.n * 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, fpoolBuf); gl.bufferSubData(gl.ARRAY_BUFFER, t.off * 32, fzero, 0, t.n * 8);
    frelease(t.off, t.n); t.off = -1; fstat.instances -= t.n;
  }
  // which tiles the camera wants: each level's tiles where it's at least d0·2^level away, finer ones nearer
  function fselect(cx, cy, cz) {
    fwant.length = 0; fqueue.length = 0;
    const dyc = Math.max(0, cy - 720), top = FF.levels - 1, S2 = FT0 << top, E = FF.end;
    const visit = (k, i, j) => {
      const S = FT0 << k, dx = Math.max(i * S - cx, 0, cx - (i + 1) * S), dz = Math.max(j * S - cz, 0, cz - (j + 1) * S);
      const d = Math.hypot(dx, dz, dyc);
      if (d > E) return;
      if (k > 0 && d < FF.d0 * (1 << k)) { for (let q = 0; q < 4; q++) visit(k - 1, i * 2 + (q & 1), j * 2 + (q >> 1)); return; }
      const key = fkey(k, i, j), t = ftiles.get(key);
      fwant.push(key);
      if (!t) fqueue.push(d / (1 + k * 0.5), k, i, j); // coarse tiles first at equal distance
    };
    for (let i = Math.floor((cx - E) / S2); i <= Math.floor((cx + E) / S2); i++)
      for (let j = Math.floor((cz - E) / S2); j <= Math.floor((cz + E) / S2); j++) visit(top, i, j);
  }
  // the tiles to draw: every wanted tile that's ready, and for one that isn't, its nearest ready ancestor (until it is:
  // an ancestor's plants are a subset of its descendants', so the overlap only draws some trees twice for a moment)
  const factive = new Set();
  function fresolve() {
    const act = new Set();
    for (const key of fwant) {
      if (ftiles.has(key)) { act.add(key); continue; }
      let k = Math.floor(key / 67108864), i = Math.floor(key / 8192) % 8192 - 4096, j = key % 8192 - 4096;
      // moving away, its four children are usually still there (a superset of its plants): keep them until it's ready
      if (k > 0) {
        const ch = [0, 1, 2, 3].map(q => fkey(k - 1, i * 2 + (q & 1), j * 2 + (q >> 1)));
        if (ch.every(c => ftiles.has(c))) { for (const c of ch) act.add(c); continue; }
      }
      while (k < FF.levels - 1) { k++; i = Math.floor(i / 2); j = Math.floor(j / 2); const a = fkey(k, i, j); if (ftiles.has(a)) { act.add(a); break; } }
    }
    for (const key of factive) if (!act.has(key)) { const t = ftiles.get(key); if (t && t.live) funload(t); }
    for (const key of act) { const t = ftiles.get(key); if (!t.live) fupload(t); t.used = fFrame; }
    factive.clear(); for (const k of act) factive.add(k);
  }
  let fcx = 1e9, fcz = 1e9, fcy = 0, fdirty = true;
  function farUpdate(cx, cy, cz, budgetMs) {
    fFrame++;
    const t0 = performance.now();
    if (fdirty || Math.abs(cx - fcx) > 32 || Math.abs(cz - fcz) > 32 || Math.abs(cy - fcy) > 32) {
      fcx = cx; fcy = cy; fcz = cz; fdirty = false;
      fselect(cx, cy, cz);
      // nearest first
      const order = [];
      for (let q = 0; q < fqueue.length; q += 4) order.push(q);
      order.sort((a, b) => fqueue[a] - fqueue[b]);
      fqueue.order = order;
      fresolve();
    }
    let made = 0;
    const order = fqueue.order || [];
    while (order.length && (made === 0 || performance.now() - t0 < budgetMs)) {
      const q = order.shift(), k = fqueue[q + 1], i = fqueue[q + 2], j = fqueue[q + 3], key = fkey(k, i, j);
      if (ftiles.has(key)) continue;
      const tg = performance.now();
      ftiles.set(key, genFarTile(k, i, j));
      fstat.tileMax = Math.max(fstat.tileMax, performance.now() - tg);
      made++;
    }
    if (made) fresolve();
    // cache: forget the least recently used tiles that aren't drawn
    if (ftiles.size > 2600) {
      const old = [...ftiles].filter(([k, t]) => !t.live).sort((a, b) => a[1].used - b[1].used);
      for (let q = 0; q < old.length - 2000; q++) ftiles.delete(old[q][0]);
    }
    fstat.tiles = ftiles.size; fstat.active = factive.size; fstat.gen = made; fstat.queue = order.length; fstat.ms = performance.now() - t0;
  }

  const FP = program(GLSL_COMMON + IMP_GLSL + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 iA; layout(location=2) in vec4 iB;
uniform mat4 uVP; uniform vec4 uImp[${NK}], uCyl[${NK * 2}];
uniform vec4 uBand[2];  // trees, bushes: (meshes' reach, their cross-fade width, thinning distance d0, end)
uniform vec4 uSph;      // shadow pass: the cascade's sphere (world centre, radius)
out vec3 vUV0; out vec3 vUV1; out vec3 vUV2; flat out vec3 vW; out vec3 vRel; flat out vec4 vRotT; out float vLo;
void cull(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vLo = 2.0; }
vec3 frameUV(vec2 f, vec3 pl, float R, float base){
  vec3 fx, fy; frameBasis(frameDir(f), fx, fy);
  return vec3(vec2(dot(pl, fx), dot(pl, fy))/(2.0*R) + 0.5, base + f.y*IG + f.x);
}
void main(){
  vUV0 = vec3(0.0); vUV1 = vec3(0.0); vUV2 = vec3(0.0); vW = vec3(0.0); vRel = vec3(0.0); vRotT = vec4(0.0);
  float s0 = iA.w;
  int k = int(iB.w + 0.5);
  vec4 band = k >= 9 ? uBand[1] : uBand[0];
  float d = length(iA.xyz - uCam);
  // thinning: kept while its rank is under (d0/d)², shrinking away over the last stretch; widened by d/d0 beyond d0
  float f = min(1.0, band.z*band.z/(d*d)), r = iB.z;
  float keep = clamp((f - r)/(0.25*f), 0.0, 1.0)*clamp((band.w - d)/(band.w*0.1), 0.0, 1.0);
  float lo = clamp((band.x - d)/band.y, 0.0, 1.0);
  bool sh = uShadowPass > 0.5;
  if (s0 <= 0.0 || keep <= 0.0 || lo >= 1.0 || (sh && distance(iA.xyz, uSph.xyz) > uSph.w + 40.0)) { cull(); return; }
  float sw = max(1.0, d/band.z), shh = sqrt(sw), sc = s0*keep;
  vec4 K = uImp[k], C = uCyl[k*2];
  float y1 = uCyl[k*2 + 1].x, c = cos(iB.x), s = sin(iB.x);
  vec3 ks = vec3(K.x*sw, K.y*shh, K.z*sw)*sc, cs = vec3(C.x*sw, 0.5*(C.y + y1)*shh, C.z*sw)*sc;
  vec3 sph = iA.xyz + vec3(ks.x*c + ks.z*s, ks.y, -ks.x*s + ks.z*c);   // bounding sphere's centre: the frames' origin
  vec3 cyl = iA.xyz + vec3(cs.x*c + cs.z*s, cs.y, -cs.x*s + cs.z*c);   // bounding cylinder's centre
  float rh = C.w*sw*sc, hy = 0.5*(y1 - C.y)*shh*sc;
  vec3 dv = sh ? uSun : normalize(uCam - cyl);
  // the quad: the cylinder's outline seen along dv (its axis foreshortened, its caps seen as ellipses)
  float hh = hy*sqrt(max(1.0 - dv.y*dv.y, 0.0)) + rh*abs(dv.y), hw = rh;
  if (!sh) { vec4 cp = uVP*vec4(cyl - uCam, 1.0); float m = max(hw, hh)*1.5 + cp.w*0.05; if (cp.w < -m || abs(cp.x) > cp.w + m || abs(cp.y) > cp.w + m) { cull(); return; } }
  vec3 rv = cross(vec3(0.0, 1.0, 0.0), dv); rv = dot(rv, rv) < 1e-6 ? vec3(1.0, 0.0, 0.0) : normalize(rv);
  vec3 uv = cross(dv, rv);
  vec3 Pw = cyl + aC.x*hw*rv + aC.y*hh*uv, P = Pw - sph;
  // the view direction and the corner in the plant's own frame (unrotated, unscaled, from the sphere's centre)
  vec3 dl = vec3(dv.x*c - dv.z*s, dv.y, dv.x*s + dv.z*c);
  vec3 pl = vec3(P.x*c - P.z*s, P.y, P.x*s + P.z*c)/(sc*vec3(sw, shh, sw));
  // the three frames around the view direction on the grid, and their weights (the shadow pass takes the nearest)
  vec2 g = (hemiOct(dl)*0.5 + 0.5)*(IG - 1.0), i0 = min(floor(g), vec2(IG - 2.0)), fr = g - i0;
  float base = float(k)*IG*IG;
  if (sh) { vUV0 = frameUV(i0 + step(0.5, fr), pl, K.w, base); vW = vec3(1.0, 0.0, 0.0); }
  else {
    vec2 f0, f1, f2;
    if (fr.x + fr.y <= 1.0) { f0 = i0; f1 = i0 + vec2(1.0, 0.0); f2 = i0 + vec2(0.0, 1.0); vW = vec3(1.0 - fr.x - fr.y, fr.x, fr.y); }
    else { f0 = i0 + 1.0; f1 = i0 + vec2(0.0, 1.0); f2 = i0 + vec2(1.0, 0.0); vW = vec3(fr.x + fr.y - 1.0, 1.0 - fr.x, 1.0 - fr.y); }
    vUV0 = frameUV(f0, pl, K.w, base); vUV1 = frameUV(f1, pl, K.w, base); vUV2 = frameUV(f2, pl, K.w, base);
  }
  vRotT = vec4(c, s, iB.y, rh);
  vLo = lo;
  vRel = Pw - uCam;
  gl_Position = uVP*vec4(vRel, 1.0);
}`, GLSL_COMMON + MESH.LIGHT + `
uniform mediump sampler2DArray uIA, uIN; uniform float uA2C;
in vec3 vUV0; in vec3 vUV1; in vec3 vUV2; flat in vec3 vW; in vec3 vRel; flat in vec4 vRotT; in float vLo; out vec4 o;
// sun visibility for an impostor pixel: one hardware-filtered tap of the finest cascade that holds it, looked up a
// crown's radius toward the sun (the quad is flat: without the offset half of every tree would sit behind its own
// sun-facing caster), times the cloud shadow
float impShadow(vec3 rel, float rh){
  float cl = cloudShadow(rel);
  if (uShadowP.z < 0.5 || uShadowP.x < 1.0) return cl;
  vec3 p = rel + uSun*rh;
  int nc = int(uShadowP.x);
  for (int i = 0; i < 5; i++) {
    if (i >= nc) break;
    vec3 sc = (uCasM[i]*vec4(p + uCasP[i].xyz, 1.0)).xyz*0.5 + 0.5;
    vec2 e = abs(sc.xy - 0.5);
    if (max(e.x, e.y) < 0.485 && sc.z < 1.0) return texture(uShadowMap, vec4(sc.xy, float(i), sc.z))*cl;
  }
  return cl;
}
void main(){
  if (bayer4(gl_FragCoord.xy) < vLo) discard;       // the mesh LOD draws the rest of the cross-fade
  if (uShadowPass > 0.5) { if (texture(uIA, vUV0).a < 0.5) discard; o = vec4(0.0); return; }
  vec4 A = texture(uIA, vUV0)*vW.x + texture(uIA, vUV1)*vW.y + texture(uIA, vUV2)*vW.z;
  if (A.a < (uA2C < 0.5 ? 0.5 : 0.02)) discard;
  vec4 N = texture(uIN, vUV0)*vW.x + texture(uIN, vUV1)*vW.y + texture(uIN, vUV2)*vW.z;
  vec3 col = pow(A.rgb/A.a, vec3(1.0/2.2)), nl = normalize(N.rgb/A.a*2.0 - 1.0); // back to the authored (sRGB) colour
  float ao = N.a/A.a, c = vRotT.x, s = vRotT.y, tint = vRotT.z;
  vec3 n = vec3(nl.x*c + nl.z*s, nl.y, -nl.x*s + nl.z*c);
  float fol = smoothstep(-0.02, 0.06, col.g - col.r);  // leaves are green, bark brown or white
  col *= mix(vec3(0.88, 0.93, 0.98), vec3(1.1, 1.05, 0.86), fract(tint));
  if (tint > 1.5) col = mix(col, dot(col, vec3(0.35, 0.55, 0.1))*vec3(1.95, 1.5, 0.42), 0.5*fol);
  vec3 v = normalize(vRel);
  gShadow = impShadow(vRel, vRotT.w);
  vec3 lit = lightMesh(toLin(col), n, v, ao, 0.0, fol*0.9);
  o = vec4(fogIt(lit, vRel), A.a);
}`);
  const FU = FP.u;
  const fvao = gl.createVertexArray();
  gl.bindVertexArray(fvao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])));
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, fpoolBuf);
  for (const [loc, off] of [[1, 0], [2, 16]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off); gl.vertexAttribDivisor(loc, 1); }
  gl.bindVertexArray(null);
  // Draw runs: the ranges of the drawn tiles that touch the view frustum (or a shadow cascade's sphere), sorted and merged
  // across small holes. Besides saving the vertex work, this keeps each pass well under ~2^18 instances: past that, the
  // same draws into a depth-only shadow target cost ~10× more on an RX 7900 XT (ANGLE/D3D11)
  const fplanes = new Float64Array(24), runs = [];
  function farRuns(shadow, cx, cy, cz) {
    let sp = null;
    if (shadow) sp = SHADOW.sphere(shadow - 1);
    else {
      const m = GLX.env.vp;
      for (let p = 0; p < 6; p++) {
        const row = p >> 1, sg = (p & 1) ? -1 : 1;
        fplanes[p * 4] = m[3] + sg * m[row]; fplanes[p * 4 + 1] = m[7] + sg * m[4 + row];
        fplanes[p * 4 + 2] = m[11] + sg * m[8 + row]; fplanes[p * 4 + 3] = m[15] + sg * m[12 + row];
      }
    }
    const vis = [], M = 60; // margin: the widest a thinned, widened crown can reach past its tile
    for (const key of factive) {
      const t = ftiles.get(key);
      if (!t.live || !t.n || t.off < 0) continue;
      const x0 = t.x0 - M, x1 = t.x0 + t.S + M, z0 = t.z0 - M, z1 = t.z0 + t.S + M;
      if (sp) {
        const dx = Math.max(x0 - sp[0], 0, sp[0] - x1), dy = Math.max(t.y0 - sp[1], 0, sp[1] - t.y1), dz = Math.max(z0 - sp[2], 0, sp[2] - z1);
        if (dx * dx + dy * dy + dz * dz > (sp[3] + 40) * (sp[3] + 40)) continue;
      } else {
        let out = false;
        for (let p = 0; p < 5 && !out; p++) { // the far plane never clips a 10 km forest
          const a = fplanes[p * 4], b = fplanes[p * 4 + 1], c = fplanes[p * 4 + 2], d = fplanes[p * 4 + 3];
          out = a * ((a > 0 ? x1 : x0) - cx) + b * ((b > 0 ? t.y1 : t.y0) - cy) + c * ((c > 0 ? z1 : z0) - cz) + d < 0;
        }
        if (out) continue;
      }
      vis.push(t);
    }
    vis.sort((a, b) => a.off - b.off);
    runs.length = 0;
    let drawn = 0;
    for (const t of vis) {
      const L = runs.length;
      if (L && t.off - (runs[L - 2] + runs[L - 1]) < 2048) runs[L - 1] = t.off + t.n - runs[L - 2];
      else runs.push(t.off, t.n);
    }
    for (let q = 1; q < runs.length; q += 2) drawn += runs[q];
    if (!shadow) { fstat.drawn = drawn; fstat.runs = runs.length / 2; }
  }
  // shadow: 0 view pass, 1+ the shadow cascade's index + 1
  function drawFar(shadow) {
    if (!FF.on || !fstat.instances) return;
    const cp = GLX.env.cam;
    farRuns(shadow, cp[0], cp[1], cp[2]);
    if (!runs.length) return;
    gl.useProgram(FP.p); setEnv(FP);
    gl.activeTexture(gl.TEXTURE0 + UNIT_IA); gl.bindTexture(gl.TEXTURE_2D_ARRAY, impAlb);
    gl.activeTexture(gl.TEXTURE0 + UNIT_IN); gl.bindTexture(gl.TEXTURE_2D_ARRAY, impNrm); gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(FU.uIA, UNIT_IA); gl.uniform1i(FU.uIN, UNIT_IN);
    gl.uniform4fv(FU.uImp, impK); gl.uniform4fv(FU.uCyl, impC);
    gl.uniform4fv(FU.uBand, [FF.treeFrom || TREE.R2, TREE.W, FF.d0, FF.end, FF.bushFrom || SHRUB.R2, SHRUB.W, FF.bushD0, FF.bushEnd]);
    if (FU.uSpec) gl.uniform1f(FU.uSpec, 0.035);
    if (FU.uNoFog) gl.uniform1f(FU.uNoFog, 0);
    const a2c = FF.a2c && !shadow && typeof POST !== 'undefined' && POST.targets && POST.targets.samples > 1;
    gl.uniform1f(FU.uA2C, a2c ? 1 : 0);
    if (shadow) { const sp = SHADOW.sphere(shadow - 1); gl.uniform4f(FU.uSph, sp[0], sp[1], sp[2], sp[3]); }
    gl.disable(gl.CULL_FACE);
    if (a2c) { gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE); gl.colorMask(true, true, true, false); }
    gl.bindVertexArray(fvao); gl.bindBuffer(gl.ARRAY_BUFFER, fpoolBuf);
    for (let q = 0; q < runs.length; q += 2) {
      const o = runs[q];
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, o * 32); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, o * 32 + 16);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, runs[q + 1]);
    }
    gl.bindVertexArray(null);
    if (a2c) { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); gl.colorMask(true, true, true, true); }
  }

  // ───── near-camera grass & wildflowers ─────
  // (view range, ticket 14) full density to GR_FULL, thinning and widening out to GR (it was 75 m); each tile's lists are
  // sorted by seed, so a rebuild copies just the prefix its distance can keep
  const GT = 32, GC = 1.25, GNC = GT / GC, GGS = 4, GGN = GT / GGS + 1, GRASS_CAP = 40000, GTR_MAX = Math.ceil((200 + 12) / GT);
  let GR = 200, GR_FULL = 60, GTR = GTR_MAX; // (Medium, Low: 75 m, all full density)
  const gtiles = new Map(), ggrid = new Float64Array(GGN * GGN), gfm = new Float64Array(GGN * GGN), gpat = new Float64Array(GGN * GGN);
  const gspc = new Float64Array(GGN * GGN), gtall = new Float64Array(GGN * GGN);
  const gscratch = [];
  for (let k = 0; k < NG; k++) gscratch.push(new Float32Array(GNC * GNC * 8));
  const gcount = new Int32Array(NG);
  const GB = makeBatch(GRASS_CAP, GKINDS);
  const GNM = (2 * GTR_MAX + 1) ** 2;
  const gneed = { n: 0, key: new Float64Array(GNM), i: new Int32Array(GNM), j: new Int32Array(GNM), d: new Float32Array(GNM), ti: 1e9, tj: 1e9 };
  const glast = { x: 1e9, y: 0, z: 0, f: [0, 0, 0], active: false, dirty: true, count: 0 };
  function sortBySeed(src, n) { // n instances (8 floats each), ascending by seed (float 6)
    const idx = new Int32Array(n);
    for (let q = 0; q < n; q++) idx[q] = q;
    idx.sort((a, b) => src[a * 8 + 6] - src[b * 8 + 6]);
    const out = new Float32Array(n * 8);
    for (let q = 0; q < n; q++) out.set(src.subarray(idx[q] * 8, idx[q] * 8 + 8), q * 8);
    return out;
  }
  function genGrassTile(ti, tj) {
    const x0 = ti * GT, z0 = tj * GT;
    let gmin = 1e9, gmax = -1e9;
    for (let b = 0; b < GGN; b++) for (let a = 0; a < GGN; a++) {
      const h = terrainH(x0 + a * GGS, z0 + b * GGS, 1);
      ggrid[b * GGN + a] = h;
      if (h < gmin) gmin = h;
      if (h > gmax) gmax = h;
    }
    gcount.fill(0);
    if (gmax > 3 && gmin < 650) {
      for (let b = 0; b < GGN; b++) for (let a = 0; a < GGN; a++) {
        const x = x0 + a * GGS, z = z0 + b * GGS, q = b * GGN + a;
        gfm[q] = (a & 1) || (b & 1) ? -1 : forestMask(x, z);          // mask is smooth: sample every 8 m, fill below
        gpat[q] = vn(x * 0.045 + 3.3, z * 0.045 + 7.7);               // wildflower patches
        gspc[q] = vn(x * 0.018 + 9.1, z * 0.018 + 1.7);               // which flowers
        gtall[q] = vn(x * 0.03 + 5.1, z * 0.03 + 2.9);                // tall-grass patches
      }
      for (let b = 0; b < GGN; b++) for (let a = 0; a < GGN; a++) {
        const q = b * GGN + a;
        if (gfm[q] >= 0) continue;
        const a0 = a & ~1, b0 = b & ~1, a1 = Math.min(a0 + 2, GGN - 1), b1 = Math.min(b0 + 2, GGN - 1), tx = (a - a0) / 2, tz = (b - b0) / 2;
        gfm[q] = lerp(lerp(gfm[b0 * GGN + a0], gfm[b0 * GGN + a1], tx), lerp(gfm[b1 * GGN + a0], gfm[b1 * GGN + a1], tx), tz);
      }
      for (let b = 0; b < GNC; b++) for (let a = 0; a < GNC; a++) {
        const gx = ti * GNC + a, gz = tj * GNC + b, r = hs(gx, gz, 31);
        const x = (gx + hs(gx, gz, 32)) * GC, z = (gz + hs(gx, gz, 33)) * GC;
        gridAt(x0, z0, x, z, GGS, GGN);
        const fm = bil(gfm);
        if (fm > 0.55 || r < fm * 1.8) continue;
        const h = bil(ggrid);
        if (h < 3.2 + hs(gx, gz, 34) * 1.5 || h > 600 + hs(gx, gz, 42) * 30 || slopeNy(ggrid) < 0.8 || occupied(x, z, 0.3)) continue;
        let k;
        const patch = ss(0.5, 0.78, bil(gpat));
        if (hs(gx, gz, 35) < patch * 0.5 + 0.03) {
          const sp = bil(gspc) * 0.8 + hs(gx, gz, 36) * 0.2;
          k = sp < 0.34 ? 3 : sp < 0.5 ? 4 : sp < 0.62 ? 5 : 6;
        } else {
          const r2 = hs(gx, gz, 37);
          k = r2 < bil(gtall) * 0.8 ? 1 : r2 < 0.75 ? 0 : 2;
        }
        const d = gscratch[k], o = gcount[k]++ * 8;
        d[o] = x; d[o + 1] = h - 0.04; d[o + 2] = z; d[o + 3] = (0.75 + 0.5 * hs(gx, gz, 38)) * (1 - 0.3 * ss(450, 640, h));
        d[o + 4] = hs(gx, gz, 39) * TAU; d[o + 5] = 0.3 + 0.4 * hs(gx, gz, 40); d[o + 6] = hs(gx, gz, 41); d[o + 7] = 0;
      }
    }
    const lists = [];
    let n = 0;
    for (let k = 0; k < NG; k++) if (gcount[k]) { lists.push(k, sortBySeed(gscratch[k], gcount[k])); n += gcount[k]; }
    return { x0, z0, lists, n, yMin: gmin - 1, yMax: gmax + 1.2, vis: 0, keep: new Int32Array(lists.length / 2) };
  }
  function grassUpdate(cam, agl) {
    const cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
    glast.active = agl < GR + 20;
    if (!glast.active) return;
    const ti = Math.floor(cx / GT), tj = Math.floor(cz / GT);
    if (ti !== gneed.ti || tj !== gneed.tj) {
      gneed.ti = ti; gneed.tj = tj;
      const R = GR + 12;
      let n = 0;
      for (let i = ti - GTR; i <= ti + GTR; i++) for (let j = tj - GTR; j <= tj + GTR; j++) {
        const dx = Math.max(i * GT - cx, 0, cx - (i + 1) * GT), dz = Math.max(j * GT - cz, 0, cz - (j + 1) * GT), d = Math.hypot(dx, dz);
        if (d < R) { needTmp.d[n] = d; needTmp.i[n] = i; needTmp.j[n] = j; needIdx[n] = n; n++; }
      }
      needIdx.subarray(0, n).sort(byNeedDist);
      for (let q = 0; q < n; q++) { const o = needIdx[q]; gneed.d[q] = needTmp.d[o]; gneed.i[q] = needTmp.i[o]; gneed.j[q] = needTmp.j[o]; gneed.key[q] = tkey(needTmp.i[o], needTmp.j[o]); }
      gneed.n = n;
      glast.dirty = true;
    }
    let made = 0;
    for (let q = 0; q < gneed.n && made < 2; q++) {
      if (gtiles.has(gneed.key[q])) continue;
      gtiles.set(gneed.key[q], genGrassTile(gneed.i[q], gneed.j[q]));
      made++; glast.dirty = true;
    }
    const mdx = cx - glast.x, mdy = cy - glast.y, mdz = cz - glast.z, f = cam.f;
    if (!glast.dirty && mdx * mdx + mdy * mdy + mdz * mdz < 64 && f[0] * glast.f[0] + f[1] * glast.f[1] + f[2] * glast.f[2] > 0.9962) return;
    glast.dirty = false; glast.x = cx; glast.y = cy; glast.z = cz; glast.f[0] = f[0]; glast.f[1] = f[1]; glast.f[2] = f[2];
    const B = GB;
    B.n.fill(0);
    let tot = 0;
    for (let q = 0; q < gneed.n; q++) {
      const t = gtiles.get(gneed.key[q]);
      if (!t) continue;
      t.vis = 0;
      if (!t.n || !boxVisible(t.x0, t.yMin, t.z0, t.x0 + GT, t.yMax, t.z0 + GT, cx, cy, cz, 12)) continue;
      // the seeds this tile's nearest point can keep (a margin for the camera's travel until the next rebuild)
      const dx = Math.max(t.x0 - cx, 0, cx - t.x0 - GT), dz = Math.max(t.z0 - cz, 0, cz - t.z0 - GT), dy = Math.max(t.yMin - cy, 0, cy - t.yMax);
      const dn = Math.max(Math.hypot(dx, dy, dz) - 10, 1), fk = Math.min(1, (GR_FULL * GR_FULL) / (dn * dn));
      let m = 0;
      for (let l = 0; l < t.lists.length; l += 2) {
        const arr = t.lists[l + 1], n = arr.length >> 3;
        let c = 0;
        while (c < n && arr[c * 8 + 6] < fk) c++;
        t.keep[l >> 1] = c; m += c;
      }
      if (tot + m > GRASS_CAP) break;
      t.vis = 1; tot += m;
      for (let l = 0; l < t.lists.length; l += 2) B.n[t.lists[l]] += t.keep[l >> 1];
    }
    let o = 0;
    for (let s = 0; s < NG; s++) { B.off[s] = o; B.cur[s] = o; o += B.n[s]; }
    B.total = o;
    for (let q = 0; q < gneed.n; q++) {
      const t = gtiles.get(gneed.key[q]);
      if (!t || !t.vis) continue;
      for (let l = 0; l < t.lists.length; l += 2) { const k = t.lists[l], c = t.keep[l >> 1]; B.data.set(t.lists[l + 1].subarray(0, c * 8), B.cur[k] * 8); B.cur[k] += c; }
    }
    uploadBatch(B);
    glast.count = o;
    if (gtiles.size > 900) for (const [k, t] of gtiles) if (Math.abs(t.x0 - cx) > GR + 150 || Math.abs(t.z0 - cz) > GR + 150) gtiles.delete(k);
  }

  // High: the far forest, and grass to 200 m; Medium and Low keep the old reach (far meshes to 1.3 km, grass 75 m)
  // until they're derived again (view range, ticket 14)
  function setRange(high) {
    high = !!high;
    if (high === FF.on && FAR_MAX === (high ? Math.max(TREE.R2, SHRUB.R2) + MARGIN : FAR_MESH)) return;
    FF.on = high;
    FAR_MAX = high ? Math.max(TREE.R2, SHRUB.R2) + MARGIN : FAR_MESH;
    GR = high ? 200 : 75; GR_FULL = high ? 60 : 75; GTR = Math.ceil((GR + 12) / GT);
    need.ti = need.tj = 1e9; gneed.ti = gneed.tj = 1e9; tilesDirty = true; glast.dirty = true;
  }
  // ───── per-frame ─────
  let camAgl = 0, gWash = 0;
  function update(dt, ctx) {
    const t0 = performance.now();
    const cam = ctx.cam, cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
    const ti = Math.floor(cx / TILE), tj = Math.floor(cz / TILE), band = Math.round(Math.max(0, cy - 660) / 80);
    if (ti !== need.ti || tj !== need.tj || band !== need.band) { need.ti = ti; need.tj = tj; need.band = band; computeNeeded(cx, cy, cz); tilesLate = true; }
    const f = cam.f, mdx = cx - last.x, mdy = cy - last.y, mdz = cz - last.z;
    const moved = mdx * mdx + mdy * mdy + mdz * mdz > 256 || f[0] * last.f[0] + f[1] * last.f[1] + f[2] * last.f[2] < 0.9962 || Math.abs(cam.tanY - last.ty) > 0.01;
    last.gen = generate(moved);
    setPlanes(cam, 1.18);
    if (moved || tilesDirty || (tilesLate && t0 - last.t > 400)) {
      tilesDirty = tilesLate = false; last.t = t0;
      last.x = cx; last.y = cy; last.z = cz; last.f[0] = f[0]; last.f[1] = f[1]; last.f[2] = f[2]; last.ty = cam.tanY;
      rebuild(cx, cy, cz);
    }
    camAgl = cy - Math.max(terrainH(cx, cz, 1), 0);
    grassUpdate(cam, camAgl);
    const g = ctx.g;
    gWash = g && g.live !== false ? clamp(1 - (g.agl - 1) / 9, 0, 1) * clamp((g.V || 0) / 25, 0, 1) * 0.55 : 0;
    evict(cx, cz);
    if (FF.on) farUpdate(cx, cy, cz, fstat.instances ? 1.5 : 6); // ms of tile generation per frame (more while nothing is in)
    last.ms = performance.now() - t0;
  }
  function drawOpaque(ctx) {
    const sh = ctx.shadow >= 0;
    if (WB.total || (glast.active && GB.total)) {
      beginDraw();
      drawTrees(WB, false);
      if (glast.active && GB.total && DBG.grass && !sh) { const g = ctx.g; drawGrass(GB, g.pos[0], g.pos[1], g.pos[2], gWash); }
      gl.bindVertexArray(null);
    }
    // impostors: in the view, and in the shadow cascades that reach past the meshes
    if (!sh) drawFar(0);
    else {
      const sp = SHADOW.sphere(ctx.shadow), p = ctx.cam.pos;
      if (FF.shadows && Math.hypot(sp[0] - p[0], sp[1] - p[1], sp[2] - p[2]) + sp[3] > SHRUB.R2 - SHRUB.W) drawFar(ctx.shadow + 1);
    }
  }

  // crash test: trunk cylinders and the dense canopy core of nearby trees (only the tile(s) around the point)
  function hit(x, y, z) {
    if (y > 700) return false;
    const i = Math.floor(x / TILE), j = Math.floor(z / TILE), fx = x - i * TILE, fz = z - j * TILE, E = 12;
    const ia = fx < E ? -1 : 0, ib = fx > TILE - E ? 1 : 0, ja = fz < E ? -1 : 0, jb = fz > TILE - E ? 1 : 0;
    for (let a = ia; a <= ib; a++) for (let b = ja; b <= jb; b++) {
      const t = tiles.get(tkey(i + a, j + b));
      if (!t || !t.nColl || y > t.yMax || y < t.yMin) continue;
      const c = t.coll;
      for (let q = 0; q < t.nColl; q++) {
        const o = q * 5, s = c[o + 4], K = KINDS[c[o + 3]].coll, R = Math.max(K.cR, K.trunkR) * s;
        const dx = x - c[o], dz = z - c[o + 2];
        if (dx > R || dx < -R || dz > R || dz < -R) continue;
        const dy = y - c[o + 1];
        if (dy < -0.5 || dy > K.top * s) continue;
        const r2 = dx * dx + dz * dz;
        if (dy < K.trunkTop * s && r2 < K.trunkR * K.trunkR * s * s) return true;
        if (K.cone) {
          const yb = K.cy0 * s, yt = K.top * s;
          if (dy > yb) { const rr = K.cR * s * (yt - dy) / (yt - yb); if (r2 < rr * rr) return true; }
        } else {
          const cr = K.cR * s, cy = (dy - K.cy * s) / (K.cRy * s);
          if (r2 / (cr * cr) + cy * cy < 1) return true;
        }
      }
    }
    return false;
  }

  // ───── viewer showcase ─────
  let PV = null;
  function setupPreview() {
    PV = { row: makeBatch(64, slotMeshes), patch: makeBatch(1200, slotMeshes), grass: makeBatch(8000, GKINDS) };
    // row: every variant's near, mid and far LOD side by side (LOD fades disabled)
    const row = PV.row, items = [];
    let x = 0;
    for (let k = 0; k < NK; k++) {
      const w = KINDS[k].width;
      items.push([k * 3, x, 0], [k * 3 + 1, x + w * 1.05, 0], [k * 3 + 2, x + w * 2.1, 0]);
      x += w * 3.15 + 3;
    }
    const x0 = -x / 2;
    for (const [s] of items) row.n[s]++;
    let o = 0;
    for (let s = 0; s < row.n.length; s++) { row.off[s] = o; row.cur[s] = o; o += row.n[s]; }
    row.total = o;
    for (const [s, px, pz] of items) { const q = row.cur[s]++ * 8; row.data.set([x0 + px, 0, pz, 1, 0.4, 0.5, 0.3 + s * 0.07, 5000], q); }
    uploadBatch(row);
    PV.rowX = [x0, x0 + x];
    // forest patch behind (real LOD fades): firs on the -x side, broadleaf/birch on the +x side, bushes along the edge
    const patch = PV.patch, pl = [];
    for (let a = 0; a < 18; a++) for (let b = 0; b < 12; b++) {
      const px = -85 + a * 10 + (hash2(a, b) - 0.5) * 6, pz = 40 + b * 9 + (hash2(b, a + 7) - 0.5) * 6, r = hash2(a + 3, b + 11);
      const side = px + (hash2(a, b + 99) - 0.5) * 50;
      const k = side < -10 ? (r < 0.45 ? K_FIR : r < 0.8 ? K_SPRUCE : K_YFIR) : r < 0.12 ? K_BIRCH : r < 0.2 ? K_BIRCH3 : r < 0.24 ? K_POPLAR : r < 0.52 ? K_BEECH : r < 0.78 ? K_OAK : K_LINDEN;
      pl.push([k, px, pz, 0.8 + hash2(b, a) * 0.4]);
    }
    for (let a = 0; a < 30; a++) pl.push([K_BUSH + (a % 3), -85 + a * 6 + hash2(a, 5) * 3, 31 - hash2(a, 9) * 4, 0.7 + hash2(a, 1) * 0.6]);
    for (const [k] of pl) for (let lod = 0; lod < 3; lod++) patch.n[k * 3 + lod]++;
    o = 0;
    for (let s = 0; s < patch.n.length; s++) { patch.off[s] = o; patch.cur[s] = o; o += patch.n[s]; }
    patch.total = o;
    pl.forEach(([k, px, pz, s], q) => {
      const tint = hash2(q, 77) + (KINDS[k].species === 'broadleaf' && q % 23 === 5 ? 2 : 0);
      for (let lod = 0; lod < 3; lod++) patch.data.set([px, -0.4, pz, s, hash2(q, 3) * TAU, tint, hash2(q, 4), 1300], patch.cur[k * 3 + lod]++ * 8);
    });
    uploadBatch(patch);
    // meadow strip of grass tufts and wildflowers in front of the row
    const gr = PV.grass, gl2 = [];
    for (let a = 0; a < 110; a++) for (let b = 0; b < 16; b++) {
      const px = -66 + a * 1.2 + hash2(a, b) * 1.1, pz = -4 - b * 1.2 - hash2(b, a) * 1.1, r = hash2(a + 5, b + 9);
      const patchy = vn(px * 0.08, pz * 0.08);
      const k = r < patchy * 0.45 ? 3 + Math.floor(hash2(a, b + 3) * 4) : r < 0.7 ? 0 : r < 0.88 ? 1 : 2;
      gl2.push([k, px, pz]);
    }
    for (const [k] of gl2) gr.n[k]++;
    o = 0;
    for (let s = 0; s < gr.n.length; s++) { gr.off[s] = o; gr.cur[s] = o; o += gr.n[s]; }
    gr.total = o;
    gl2.forEach(([k, px, pz], q) => gr.data.set([px, 0, pz, 0.8 + hash2(q, 1) * 0.4, hash2(q, 2) * TAU, 0.5, hash2(q, 3), 0], gr.cur[k]++ * 8));
    uploadBatch(gr);
  }
  function preview(ctx) {
    if (!PV) setupPreview();
    beginDraw();
    drawTrees(PV.row, true);
    drawTrees(PV.patch, false);
    drawGrass(PV.grass, 0, -100, 0, 0);
    gl.bindVertexArray(null);
  }

  return {
    name: 'flora', replacesTrees: true, update, drawOpaque, hit, preview, KINDS, DBG, setRange, _gen: { genTile, genGrassTile, rebuild, genFarTile },
    stats: () => ({ tiles: tiles.size, needed: need.n, near: last.lod[0], mid: last.lod[1], far: last.lod[2], grass: glast.active ? glast.count : 0, grassTiles: gtiles.size, ms: last.ms, gen: last.gen, farForest: Object.assign({ free: ffree.length }, fstat) }),
    FF,
    tris: () => KINDS.map(K => `${K.name}: ${K.tris.join('/')}`).concat(GKINDS.map((m, i) => `grass${i}: ${m.count / 3}`)),
  };
})();
MODELS.push(FLORA);
