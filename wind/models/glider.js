'use strict';
// ───────────────────────── Glider (models/glider.js) ─────────────────────────
// "Swiftwing": an original single-seat, jet-assisted flying wing ridden prone by one pilot. Fully procedural.
// Draw = one lit call (custom shader: rigid part matrices, procedural wing paint, fluttering scarf)
//      + one additive exhaust-flame call (chase views only, while the jet runs).
// Body axes: +x right, +y up, +z backward (nose −z). Origin = centre of mass, skids reach y ≈ −0.48, span ≈ 7.6 m.
const GLIDER = (() => {
  const { gl, program, env, setEnv } = GLX;
  const V3 = MESH.V3;
  const b = new MESH.Builder();
  const TAU = Math.PI * 2;

  // rigid parts (vertex extra.z) and material codes (vertex extra.y)
  const PT = { STATIC: 0, ELEV_L: 1, ELEV_R: 2, BAR: 3, TORSO: 4, HEAD: 5, UARM_L: 6, UARM_R: 7, FARM_L: 8, FARM_R: 9, LEGS: 10 };
  const NPART = 11;
  const MT = { PLAIN: 0, WTOP: 3, WBOT: 4, METAL: 5, GLASS: 6 }; // scarf tails: 10 + s (long), 20 + s (short)
  const HEAD = [0, 0.32, -0.53]; // rider eye (first-person camera)

  const C = {
    teal: [0.13, 0.38, 0.4], tealDk: [0.08, 0.25, 0.27], terra: [0.64, 0.26, 0.15], ochre: [0.84, 0.6, 0.26],
    ivory: [0.79, 0.72, 0.59], ivoryDk: [0.6, 0.54, 0.44], brass: [0.72, 0.53, 0.27], bronze: [0.33, 0.25, 0.18],
    steel: [0.2, 0.2, 0.22], duct: [0.045, 0.04, 0.04], wood: [0.47, 0.31, 0.17], leather: [0.34, 0.2, 0.11],
    jacket: [0.19, 0.26, 0.41], jacketDk: [0.12, 0.17, 0.29], patch: [0.52, 0.28, 0.16], trousers: [0.58, 0.43, 0.26],
    trousersDk: [0.42, 0.3, 0.18], boot: [0.21, 0.13, 0.08], sole: [0.09, 0.065, 0.05], glove: [0.47, 0.31, 0.18],
    gloveDk: [0.3, 0.19, 0.11], cap: [0.4, 0.25, 0.14], skin: [0.86, 0.64, 0.5], fleece: [0.86, 0.8, 0.66],
    scarf: [0.72, 0.13, 0.11], scarfLt: [0.9, 0.82, 0.66], lens: [0.2, 0.17, 0.1], glow: [1.0, 0.56, 0.22], glowHot: [1.0, 0.82, 0.55],
  };

  // ── small helpers ──
  const sub = V3.sub, mul = V3.mul, norm = V3.norm, cross = V3.cross, dot = V3.dot;
  const madd = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
  const orthoTo = (v, ref) => norm(sub(v, mul(ref, dot(v, ref))));
  const mixC = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const X = (ao, mt, part, em) => [ao, mt || 0, part || 0, em || 0];
  const gauss = (x, c, w) => Math.exp(-((x - c) / w) * ((x - c) / w));

  // vertex grid: fn(k, j) → [pos, color, extra]; rings wrap when `closed`; smooth normals
  function gridF(R, Cn, closed, fn) {
    const m = b.mark();
    for (let k = 0; k < R; k++) for (let j = 0; j < Cn; j++) { const r = fn(k, j); b.vert(r[0], null, r[1], r[2]); }
    const CC = closed ? Cn : Cn - 1;
    for (let k = 0; k < R - 1; k++) for (let j = 0; j < CC; j++) {
      const a = m.v + k * Cn + j, a2 = m.v + k * Cn + (j + 1) % Cn;
      b.quad(a, a2, a2 + Cn, a + Cn);
    }
    b.smooth(m);
    return m;
  }
  // Catmull-Rom resample of a polyline to n points
  function crs(P, n) {
    const out = [], L = P.length - 1;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1) * L, k = Math.min(L - 1, Math.floor(f)), t = f - k;
      const p0 = P[Math.max(0, k - 1)], p1 = P[k], p2 = P[k + 1], p3 = P[Math.min(L, k + 2)], t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map(q => 0.5 * (2 * p1[q] + (p2[q] - p0[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (3 * p1[q] - p0[q] - 3 * p2[q] + p3[q]) * t3)));
    }
    return out;
  }
  // tube along a path. rad(t, ang) → r | [rx, ry]; o: sides, col (array | fn(t, ang, p)), ao(t, ang, p), mt, part, up
  function tubeF(path, rad, o) {
    const sides = o.sides || 10, N = path.length, fr = [];
    let prev = null;
    for (let i = 0; i < N; i++) {
      const t = norm(sub(path[Math.min(N - 1, i + 1)], path[Math.max(0, i - 1)]));
      const n = prev ? orthoTo(prev, t) : norm(cross(t, o.up || (Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])));
      prev = n; fr.push([n, cross(t, n)]);
    }
    return gridF(N, sides, true, (k, j) => {
      const t = k / (N - 1), ang = j / sides * TAU, r = typeof rad === 'function' ? rad(t, ang) : rad;
      const rx = Array.isArray(r) ? r[0] : r, ry = Array.isArray(r) ? r[1] : r;
      const n = fr[k][0], bn = fr[k][1], ca = Math.cos(ang) * rx, sa = Math.sin(ang) * ry, P = path[k];
      const p = [P[0] + n[0] * ca + bn[0] * sa, P[1] + n[1] * ca + bn[1] * sa, P[2] + n[2] * ca + bn[2] * sa];
      return [p, typeof o.col === 'function' ? o.col(t, ang, p) : o.col, X(o.ao ? o.ao(t, ang, p) : 1, o.mt, o.part, o.em)];
    });
  }
  // ellipsoid with arbitrary orthonormal axes ax = [a0, a1, a2] and radii r
  function ellB(c, ax, r, o) {
    const m = b.ellipsoid([0, 0, 0], r, {
      seg: o.seg || 12, stacks: o.stacks, disp: o.disp,
      color: o.col || [0.8, 0.8, 0.8], ex: (d, p) => X(o.ao ? o.ao(d, p) : 1, typeof o.mt === 'function' ? o.mt(d) : o.mt, o.part, o.em),
    });
    const A = ax[0], B = ax[1], Cc = ax[2];
    b.xform(m, p => [c[0] + A[0] * p[0] + B[0] * p[1] + Cc[0] * p[2], c[1] + A[1] * p[0] + B[1] * p[1] + Cc[1] * p[2], c[2] + A[2] * p[0] + B[2] * p[1] + Cc[2] * p[2]]);
    return m;
  }
  const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ell = (c, r, o) => ellB(c, AXES, r, o);
  // basis from a main direction d and a hint h (e1 = d, e2 ⟂ d toward h, e3 = e1 × e2)
  function basis(d, h) { const e1 = norm(d), e2 = orthoTo(h, e1); return [e1, e2, cross(e1, e2)]; }
  // surface of revolution around the z axis: prof rows [z, r, color, mt, emissive]
  function latheZ(prof, sides, cx, cy, part, aoF) {
    return gridF(prof.length, sides, true, (k, j) => {
      const q = prof[k], a = j / sides * TAU, ca = Math.cos(a), sa = Math.sin(a);
      return [[cx + ca * q[1], cy + sa * q[1], q[0]], q[2], X(aoF ? aoF(q[0], sa, k) : 1, q[3], part, q[4])];
    });
  }
  // lofted z-axis body from superellipse sections [z, cy, a, b, n]; fn(k, ang, sec, p) → [color, extra, p?]
  function loftZ(secs, sides, fn) {
    return gridF(secs.length, sides, true, (k, j) => {
      const s = secs[k], ang = j / sides * TAU, ca = Math.cos(ang), sa = Math.sin(ang), e = 2 / (s[4] || 2);
      const p = [Math.sign(ca) * Math.pow(Math.abs(ca), e) * s[2], s[1] + Math.sign(sa) * Math.pow(Math.abs(sa), e) * s[3], s[0]];
      const r = fn(k, ang, s, p);
      return [r[2] || p, r[0], r[1]];
    });
  }

  // ═══════════════════════ 1. craft ═══════════════════════
  // ── wing planform (s = spanwise arc length from the root, m) ──
  const S_CURL = 3.2, S_END = 4.05, SE0 = 0.62, SE1 = 3.05, Y0 = -0.04, DIH = 0.055;
  const zLE0 = s => -1.1 + 0.3 * s + 0.035 * s * s;
  const zTE0 = s => 0.84 + 0.03 * s + 0.018 * s * s;
  const dih = s => DIH * ss(0, 0.6, s) + 1.2 * ss(S_CURL, S_END, s); // dihedral, curling up to ~72° at the tip
  const SPN = 800, spX = new Float64Array(SPN + 1), spY = new Float64Array(SPN + 1);
  for (let i = 0; i < SPN; i++) {
    const ds = S_END / SPN, th = dih((i + 0.5) * ds);
    spX[i + 1] = spX[i] + Math.cos(th) * ds; spY[i + 1] = spY[i] + Math.sin(th) * ds;
  }
  function spine(s, out) {
    const f = clamp(s / S_END, 0, 1) * SPN, i = Math.min(SPN - 1, Math.floor(f)), t = f - i;
    out[0] = spX[i] + (spX[i + 1] - spX[i]) * t; out[1] = spY[i] + (spY[i + 1] - spY[i]) * t; out[2] = dih(s);
    return out;
  }
  function plan(s, out) { // [zLE, chord] with an elliptical tip round-off
    const c0 = zTE0(s) - zLE0(s), q = clamp((s - (S_END - 0.5)) / 0.5, 0, 1), c = c0 * Math.sqrt(Math.max(0, 1 - q * q));
    out[0] = zLE0(s) + (c0 - c) * 0.78; out[1] = c;
    return out;
  }
  // point on the wing skin: w ∈ [−1, 1] runs bottom TE → LE (0) → top TE; s < 0 mirrors (for finite differences)
  const _sp = [0, 0, 0], _pl = [0, 0];
  function wingPt(s, w, side, out) {
    const mir = s < 0 ? -1 : 1, as = Math.abs(s);
    spine(as, _sp); plan(as, _pl);
    const zl = _pl[0], c = _pl[1], th = _sp[2], tt = as / S_END;
    const u = Math.min(1, Math.abs(w)), top = w >= 0, u2 = u * u;
    const T = 0.12 - 0.03 * tt, cm = 0.05 - 0.02 * tt;
    const yt = 5 * T * c * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u2 + 0.2843 * u2 * u - 0.1036 * u2 * u2);
    const yc = cm * c * 4 * u * (1 - u) * (1 - 1.3 * u); // reflexed camber line
    const ya = yc + (top ? yt : -yt), za = zl + u * c;
    const tw = 0.065 * Math.pow(tt, 1.5), zq = zl + 0.25 * c, dz = za - zq, ct = Math.cos(tw), st = Math.sin(tw); // washout
    const y2 = ya * ct + dz * st, z2 = zq + dz * ct - ya * st;
    out[0] = side * mir * (_sp[0] - Math.sin(th) * y2);
    out[1] = Y0 + _sp[1] + Math.cos(th) * y2;
    out[2] = z2;
    return out;
  }
  const _a = [0, 0, 0], _b = [0, 0, 0];
  function wingN(s, w, side, out) {
    const e = 2e-3;
    wingPt(Math.min(S_END - 1e-4, s + e), w, side, _a); wingPt(s - e, w, side, _b);
    const sx = _a[0] - _b[0], sy = _a[1] - _b[1], sz = _a[2] - _b[2];
    wingPt(s, Math.min(1, w + e), side, _a); wingPt(s, Math.max(-1, w - e), side, _b);
    const wx = _a[0] - _b[0], wy = _a[1] - _b[1], wz = _a[2] - _b[2];
    let nx = sy * wz - sz * wy, ny = sz * wx - sx * wz, nz = sx * wy - sy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-14) { spine(Math.abs(s), _sp); nx = -Math.sin(_sp[2]) * side; ny = Math.cos(_sp[2]); nz = 0; } else { nx /= l; ny /= l; nz /= l; }
    out[0] = nx; out[1] = ny; out[2] = nz;
    return out;
  }
  const wingTopY = (x, z) => { const s = Math.abs(x); plan(s, _pl); return wingPt(s, clamp((z - _pl[0]) / _pl[1], 0, 1), 1, [0, 0, 0])[1]; };

  // span stations (dense in the curl), elevon hinge line (straight in planform)
  const ST = [];
  const seg = (a, z, n, pw) => { for (let i = 0; i < n; i++) { const x = i / n; ST.push(a + (z - a) * (pw ? 1 - Math.pow(1 - x, pw) : x)); } };
  seg(0, SE0, 4); const iE0 = ST.length; seg(SE0, SE1, 17); const iE1 = ST.length; seg(SE1, S_CURL, 2); seg(S_CURL, S_END - 0.002, 14, 1.35); ST.push(S_END - 0.002);
  const HZ0 = zLE0(SE0) + 0.75 * (zTE0(SE0) - zLE0(SE0)), HZ1 = zLE0(SE1) + 0.745 * (zTE0(SE1) - zLE0(SE1));
  const uh = s => { plan(s, _pl); const zh = HZ0 + (HZ1 - HZ0) * (s - SE0) / (SE1 - SE0); return clamp((zh - _pl[0]) / Math.max(_pl[1], 1e-4), 0.62, 0.86); };
  const NF = 19, NA = 5;
  const fF = x => 0.75 * (1 - Math.cos(x * Math.PI / 2)) + 0.25 * x;
  const uFore = (s, j) => uh(s) * fF(j / (NF - 1)), uAft = (s, j) => { const h = uh(s); return h + (1 - h) * j / (NA - 1); };

  const _p = [0, 0, 0], _n = [0, 0, 0];
  function wingGrid(side, top, i0, i1, uFn, nu, part, flag) {
    const m = b.mark();
    for (let k = i0; k <= i1; k++) {
      const s = ST[k];
      for (let j = 0; j < nu; j++) {
        const u = uFn(s, j), w = top ? u : -u;
        wingPt(s, w, side, _p); wingN(s, w, side, _n);
        const ax = Math.abs(_p[0]);
        let ao = 1;
        if (top) ao -= 0.22 * (1 - ss(0.16, 0.42, ax)) * ss(-0.75, -0.45, _p[2]) * (1 - ss(0.5, 0.8, _p[2]));
        else ao -= 0.32 * (1 - ss(0.14, 0.42, ax)) + 0.1 * (1 - ss(0.3, 0.9, ax));
        b.vert(_p, _n, [u, s, flag], X(ao, top ? MT.WTOP : MT.WBOT, part));
      }
    }
    for (let k = 0; k < i1 - i0; k++) for (let j = 0; j < nu - 1; j++) { const a = m.v + k * nu + j; b.quad(a, a + 1, a + nu + 1, a + nu); }
    return m;
  }
  // closing strip between top and bottom along a list of (s, u) samples (section caps & hinge faces)
  function wingStrip(side, pts, part, col, nrm) {
    const m = b.mark();
    for (const [s, u] of pts) { b.vert(wingPt(s, u, side, _p), nrm, col, X(0.7, 0, part)); b.vert(wingPt(s, -u, side, _p), nrm, col, X(0.7, 0, part)); }
    for (let k = 0; k < pts.length - 1; k++) { const a = m.v + k * 2; b.quad(a, a + 2, a + 3, a + 1); }
  }
  const HINGE = {}; // per side: pivot + axis for the elevon part matrix
  for (const side of [1, -1]) {
    const pe = side > 0 ? PT.ELEV_R : PT.ELEV_L;
    for (const top of [true, false]) {
      wingGrid(side, top, 0, ST.length - 1, uFore, NF, PT.STATIC, 0);
      wingGrid(side, top, 0, iE0, uAft, NA, PT.STATIC, 0);
      wingGrid(side, top, iE0, iE1, uAft, NA, pe, 1);
      wingGrid(side, top, iE1, ST.length - 1, uAft, NA, PT.STATIC, 0);
    }
    const capCol = [0.34, 0.29, 0.23], gapCol = [0.16, 0.14, 0.12];
    for (const k of [iE0, iE1]) {
      const s = ST[k], pts = [];
      for (let j = 0; j < NA; j++) pts.push([s, uAft(s, j)]);
      wingStrip(side, pts, pe, capCol, [side, 0, 0]);
      wingStrip(side, pts, PT.STATIC, capCol, [side, 0, 0]);
    }
    const hp = [];
    for (let k = iE0; k <= iE1; k++) hp.push([ST[k], uh(ST[k])]);
    wingStrip(side, hp, PT.STATIC, gapCol, [0, 0, 1]);
    wingStrip(side, hp, pe, gapCol, [0, 0, 1]);
    const h0 = V3.lerp(wingPt(SE0, uh(SE0), side, [0, 0, 0]), wingPt(SE0, -uh(SE0), side, [0, 0, 0]), 0.5);
    const h1 = V3.lerp(wingPt(SE1, uh(SE1), side, [0, 0, 0]), wingPt(SE1, -uh(SE1), side, [0, 0, 0]), 0.5);
    HINGE[side] = { piv: h0, axis: norm(sub(h1, h0)) };
  }
  // brass nose bead at the centre of the leading edge
  ell([0, Y0 + 0.012, -1.1], [0.028, 0.026, 0.05], { seg: 12, col: C.brass, mt: MT.METAL });

  // ── engine nacelle slung beneath the wing ──
  const NY = -0.27, NOZZ = 1.47;
  const nacAO = (z, sa) => 1 - 0.35 * ss(0.2, 0.95, sa) * (1 - ss(0.95, 1.3, z)) - 0.12 * ss(0.3, 1, -sa);
  const nb = (z, r, c, mt, em) => [z, r, c, mt || 0, em || 0];
  latheZ([
    nb(-0.5, 0.082, C.duct), nb(-0.78, 0.104, C.duct), nb(-0.895, 0.117, shade(C.brass, 0.7), MT.METAL),
    nb(-0.93, 0.131, C.brass, MT.METAL), nb(-0.918, 0.146, C.brass, MT.METAL), nb(-0.88, 0.155, C.brass, MT.METAL),
    nb(-0.875, 0.156, C.ivory), nb(-0.72, 0.171, C.ivory), nb(-0.45, 0.182, C.ivory), nb(-0.16, 0.187, C.ivory),
    nb(-0.155, 0.188, C.teal), nb(-0.02, 0.189, C.teal), nb(-0.015, 0.189, C.ochre), nb(0.012, 0.189, C.ochre),
    nb(0.017, 0.188, C.ivory), nb(0.5, 0.179, C.ivory), nb(0.88, 0.161, C.ivory), nb(0.885, 0.162, C.brass, MT.METAL),
    nb(0.96, 0.159, C.brass, MT.METAL), nb(0.965, 0.155, C.bronze, MT.METAL), nb(1.2, 0.137, C.bronze, MT.METAL),
    nb(1.42, 0.119, C.steel, MT.METAL), nb(1.47, 0.112, C.steel, MT.METAL), nb(1.455, 0.1, C.glow, 0, 1.0),
    nb(1.38, 0.091, C.glow, 0, 1.4), nb(1.26, 0.062, C.glowHot, 0, 1.1), nb(1.2, 0.0, C.glowHot, 0, 0.8),
  ], 26, 0, NY, PT.STATIC, nacAO);
  // intake spinner and fan blades
  latheZ([nb(-0.5, 0.05, C.bronze, MT.METAL), nb(-0.62, 0.045, C.bronze, MT.METAL), nb(-0.7, 0.025, C.brass, MT.METAL), nb(-0.735, 0.0, C.brass, MT.METAL)], 12, 0, NY, PT.STATIC);
  for (let k = 0; k < 9; k++) {
    const m = b.box([0, 0.068, -0.6], [0.006, 0.05, 0.04], { color: C.steel, ex: () => X(0.5) });
    b.rotate(m, 'y', 0.5, [0, 0.068, -0.6]); b.rotate(m, 'z', k / 9 * TAU, [0, 0, -0.6]); b.translate(m, 0, NY, 0);
  }
  // dorsal fairing blending the nacelle into the wing
  loftZ([[-0.86, -0.1, 0.01, 0.01, 2], [-0.8, -0.1, 0.05, 0.035, 2.4], [-0.5, -0.1, 0.075, 0.045, 2.4], [0.4, -0.1, 0.075, 0.045, 2.4],
    [0.9, -0.105, 0.06, 0.04, 2.4], [1.02, -0.11, 0.01, 0.01, 2]], 14, (k, ang) => [C.ivory, X(0.75 - 0.2 * Math.sin(ang))]);

  const wingBotY = (x, z) => { const s = Math.abs(x); plan(s, _pl); return wingPt(s, -clamp((z - _pl[0]) / _pl[1], 0, 1), 1, [0, 0, 0])[1]; };

  // ── quilted leather pad the pilot lies on ──
  {
    const secs = [];
    for (const z of [-0.375, -0.365, -0.345, -0.3, -0.2, -0.08, 0.05, 0.18, 0.3, 0.38, 0.405, 0.418]) {
      const e = clamp(Math.min(z + 0.378, 0.42 - z) / 0.05, 0, 1), top = 0.125, bot = wingTopY(0, z) - 0.02;
      secs.push([z, (top + bot) / 2, 0.165 * Math.sqrt(e) + 0.004, (top - bot) / 2 * (0.35 + 0.65 * Math.sqrt(e)) + 0.003, 3]);
    }
    loftZ(secs, 22, (k, ang) => [shade(C.leather, k % 2 ? 0.92 : 1.05), X(0.7 + 0.3 * ss(-0.5, 0.8, Math.sin(ang)))]);
  }

  // ── control bar assembly (one rigid part: pivots toward the pilot and twists like handlebars) ──
  const barPt = u => [0.28 * u, 0.14 + 0.006 * u * u, -0.74 + 0.02 * u * u];
  const barTan = (u, side) => norm([0.28 * side, 0.012 * u * side, 0.04 * u * side]);
  {
    const P = u0 => { const pts = []; for (let i = 0; i <= 16; i++) pts.push(barPt(u0[0] + (u0[1] - u0[0]) * i / 16)); return pts; };
    tubeF(P([-0.6, 0.6]), 0.012, { sides: 10, col: C.bronze, mt: MT.METAL, part: PT.BAR });
    for (const sd of [1, -1]) {
      const pts = []; for (let i = 0; i <= 22; i++) pts.push(barPt(sd * (0.58 + 0.36 * i / 22)));
      tubeF(pts, t => 0.0175 * Math.sqrt(Math.min(1, Math.min(t, 1 - t) / 0.06 + 0.4)), { sides: 10, part: PT.BAR, col: t => shade(C.leather, Math.floor(t * 22) % 2 ? 0.8 : 1.12) });
      ell(barPt(sd * 0.965), [0.019, 0.019, 0.019], { seg: 10, col: C.brass, mt: MT.METAL, part: PT.BAR });
    }
    const hub = barPt(0);
    ell(hub, [0.024, 0.02, 0.026], { seg: 12, col: C.brass, mt: MT.METAL, part: PT.BAR });
    const base = wingTopY(0, -0.74) - 0.01;
    tubeF([[0, base, -0.74], [0, (base + hub[1]) / 2, -0.74], [0, hub[1], -0.74]], t => 0.012 + 0.008 * (1 - ss(0, 0.4, t)), { sides: 10, col: C.bronze, mt: MT.METAL, part: PT.BAR });
    // a little brass dial on the hub, tilted toward the pilot
    const cup = b.lathe([[0.0, 0.0], [0.019, 0.0], [0.021, 0.006], [0.02, 0.01], [0.016, 0.0095]], { sides: 16, color: C.brass, ex: () => X(1, MT.METAL, PT.BAR) });
    b.lathe([[0.016, 0.0075], [0.0, 0.0075]], { sides: 16, color: C.fleece, ex: () => X(1, 0, PT.BAR) });
    b.box([0.0, 0.0085, -0.004], [0.0028, 0.0015, 0.014], { color: C.terra, ex: () => X(1, 0, PT.BAR) });
    b.rotate(cup, 'x', 0.75); b.translate(cup, hub[0], hub[1] + 0.012, hub[2]);
  }

  // ── landing skids: two sled runners on struts ──
  for (const sd of [1, -1]) {
    const x = 0.34 * sd;
    const run = crs([[x, -0.37, -0.96], [x, -0.44, -0.9], [x, -0.474, -0.76], [x, -0.48, -0.45], [x, -0.48, 0.3], [x, -0.474, 0.62], [x, -0.452, 0.73]], 22);
    tubeF(run, [0.017, 0.011], { sides: 8, col: t => (t < 0.09 ? C.brass : C.wood), mt: 0, ao: () => 0.85 });
    for (const [z0, z1] of [[-0.52, -0.55], [0.32, 0.28]]) {
      const top = [0.31 * sd, wingBotY(0.31, z1) + 0.015, z1];
      tubeF([[x, -0.47, z0], V3.lerp([x, -0.47, z0], top, 0.5), top], 0.011, { sides: 7, col: C.steel, mt: MT.METAL, ao: t => 0.7 + 0.3 * t });
    }
    tubeF([[x, -0.465, -0.12], [0.15 * sd, -0.385, -0.12]], 0.008, { sides: 6, col: C.steel, mt: MT.METAL });
  }
  // ── foot bar behind the trailing edge, braced to the wing and the nacelle ──
  {
    const fb = [[-0.21, 0.005, 1.22], [0, 0.005, 1.22], [0.21, 0.005, 1.22]];
    tubeF(fb, 0.011, { sides: 8, col: C.bronze, mt: MT.METAL });
    for (const sd of [1, -1]) {
      ell([0.215 * sd, 0.005, 1.22], [0.016, 0.016, 0.016], { seg: 8, col: C.brass, mt: MT.METAL });
      tubeF([[0.2 * sd, 0.005, 1.215], [0.37 * sd, wingTopY(0.37, 0.8) - 0.01, 0.8]], 0.008, { sides: 6, col: C.steel, mt: MT.METAL });
    }
    tubeF([[0, -0.14, 1.19], [0, 0.005, 1.22]], 0.012, { sides: 8, col: C.bronze, mt: MT.METAL });
  }

  // ═══════════════════════ 2. rider: arms + gloved hands (the only rider parts drawn in first person) ═══════════════════════
  const PIV_BAR = [0, -0.1, -0.74], PIV_T = [0, 0.12, 0.2], PIV_N = [0, 0.26, -0.35];
  const ARMS = [];
  const deg = Math.PI / 180;
  // ── arms: rest pose from IK so the per-frame solve reproduces it exactly ──
  for (const side of [1, -1]) {
    const pu = side > 0 ? PT.UARM_R : PT.UARM_L, pf = side > 0 ? PT.FARM_R : PT.FARM_L;
    const S0 = [0.165 * side, 0.265, -0.265], G0 = barPt(0.75 * side), T0 = barTan(0.75 * side, side);
    const W0 = [G0[0] + 0.012 * side, G0[1] + 0.03, G0[2] + 0.068];
    const L1 = 0.26, L2 = 0.24, pole0 = [0.85 * side, -0.5, 0.15], E0 = ik(S0, W0, L1, L2, pole0, [0, 0, 0]);
    ARMS.push({ side, pu, pf, S0, W0, T0, L1, L2, pole0, dU0: sub(E0, S0), dF0: sub(W0, E0),
      S1: [0, 0, 0], W1: [0, 0, 0], T1: [0, 0, 0], E1: [0, 0, 0], pole1: pole0.slice(), d1: [0, 0, 0], d2: [0, 0, 0] });
    const fold = (t, ang, amt) => 1 + amt * Math.sin(t * 38 + ang * 2 + side) * Math.sin(t * 13);
    const sleeveCol = (t, ang) => mixC(C.jacket, C.jacketDk, clamp(0.5 - 0.5 * Math.sin(t * 38 + ang * 2 + side) * Math.sin(t * 13), 0, 1) * 0.8);
    // upper arm + shoulder
    ell(S0, [0.066, 0.064, 0.066], { seg: 12, col: C.jacket, part: pu, ao: d => 0.75 + 0.25 * ss(-0.6, 0.6, d[1]) });
    const up = []; for (let i = 0; i <= 8; i++) up.push(V3.lerp(S0, E0, i / 8));
    tubeF(up, (t, a) => (0.058 - 0.011 * t) * fold(t, a, 0.05 * ss(0.4, 0.9, t)), { sides: 12, part: pu, col: sleeveCol });
    // forearm sleeve, elbow, gauntlet cuff
    const dWE = norm(sub(E0, W0));
    ell(E0, [0.05, 0.05, 0.05], { seg: 12, col: C.jacket, part: pf });
    const fa = []; for (let i = 0; i <= 8; i++) fa.push(V3.lerp(E0, madd(W0, dWE, 0.06), i / 8));
    tubeF(fa, (t, a) => (0.05 - 0.009 * t) * fold(t + 0.3, a, 0.045 * (1 - ss(0.2, 0.6, t))), { sides: 12, part: pf, col: sleeveCol });
    const cf = []; for (let i = 0; i <= 5; i++) cf.push(madd(W0, dWE, 0.012 + 0.095 * i / 5));
    tubeF(cf, t => 0.037 + 0.017 * t * t, { sides: 12, part: pf, col: t => (t > 0.85 ? C.gloveDk : C.glove) });
    // gloved hand wrapped around the grip
    const Ug = orthoTo([0, 1, 0], T0), Fg = orthoTo(orthoTo([0, 0, -1], T0), Ug);
    const circ = (th, off, R) => [G0[0] + (Fg[0] * Math.cos(th) + Ug[0] * Math.sin(th)) * R + T0[0] * off,
      G0[1] + (Fg[1] * Math.cos(th) + Ug[1] * Math.sin(th)) * R + T0[1] * off, G0[2] + (Fg[2] * Math.cos(th) + Ug[2] * Math.sin(th)) * R + T0[2] * off];
    const K = circ(50 * deg, 0, 0.03), aL = norm(sub(K, W0)), aW = orthoTo(T0, aL);
    // back of the hand with stitched tendon seams; knuckle ridge; wrist strap with a brass stud
    ellB(V3.lerp(W0, K, 0.5), [aL, aW, cross(aL, aW)], [V3.len(sub(K, W0)) / 2 + 0.012, 0.041, 0.026], { seg: 14, stacks: 10, part: pf,
      col: d => (-side * d[2] > 0.25 && (Math.abs(Math.abs(d[1]) - 0.4) < 0.07 || Math.abs(d[1]) < 0.05) && d[0] > -0.5 ? C.gloveDk : C.glove) });
    const kr = []; for (let i = 0; i <= 6; i++) kr.push(madd(madd(K, T0, (-0.04 + 0.08 * i / 6)), Ug, 0.004));
    tubeF(kr, t => 0.012 * (0.6 + 0.4 * Math.sin(Math.PI * t)), { sides: 8, part: pf, col: shade(C.glove, 1.08) });
    const ws = madd(W0, dWE, 0.035), wr = [];
    const wa = orthoTo([0, 1, 0], dWE), wb = cross(dWE, wa);
    for (let i = 0; i <= 14; i++) { const a = i / 14 * TAU; wr.push(madd(madd(ws, wa, Math.cos(a) * 0.041), wb, Math.sin(a) * 0.041)); }
    tubeF(wr, 0.007, { sides: 5, part: pf, col: C.gloveDk });
    ell(madd(ws, wa, 0.047), [0.008, 0.008, 0.008], { seg: 7, col: C.brass, mt: MT.METAL, part: pf });
    const offs = [-0.028, -0.0095, 0.0095, 0.027], ends = [-112, -124, -120, -104];
    for (let f = 0; f < 4; f++) {
      const pts = []; for (let i = 0; i <= 7; i++) pts.push(circ((58 + (ends[f] - 58) * i / 7) * deg, offs[f] * side, 0.028));
      tubeF(pts, t => 0.0105 - 0.0015 * t, { sides: 7, part: pf, col: t => (Math.abs(t - 0.3) < 0.06 || Math.abs(t - 0.66) < 0.06 ? C.gloveDk : C.glove) });
      ell(pts[7], [0.009, 0.009, 0.009], { seg: 7, col: C.glove, part: pf });
    }
    const th = [[160, -0.036], [200, -0.044], [235, -0.042], [265, -0.036], [285, -0.03]].map(([a, o]) => circ(a * deg, o * side, 0.03));
    tubeF(crs(th, 8), t => 0.0135 - 0.004 * t, { sides: 7, part: pf, col: C.glove });
    ell(th[4], [0.0095, 0.0095, 0.0095], { seg: 7, col: C.glove, part: pf });
  }

  const COUNT_FP = b.i.length; // first person draws only the craft, arms and gloved hands
  // ═══════════════════════ 3. rider parts hidden in first person (body, legs, scarf, head) ═══════════════════════
  // ── legs, boots and stirrup straps (one part: follows half of the body lean) ──
  for (const side of [1, -1]) {
    const leg = crs([[0.085 * side, 0.215, 0.33], [0.095 * side, 0.2, 0.52], [0.11 * side, 0.172, 0.74], [0.118 * side, 0.146, 0.92], [0.125 * side, 0.12, 1.07]], 16);
    const lr = t => 0.082 - 0.035 * t + 0.008 * gauss(t, 0.5, 0.08);
    const crease = (t, a) => Math.sin(a * 3 + t * 50 + side) * (gauss(t, 0.5, 0.1) + 0.8 * gauss(t, 0.8, 0.07));
    tubeF(leg, (t, a) => lr(t) * (1 + 0.05 * crease(t, a)), { sides: 12, part: PT.LEGS, up: [0, 1, 0],
      col: (t, a) => mixC(C.trousers, C.trousersDk, clamp(0.4 - 0.6 * crease(t, a), 0, 1)), ao: (t, a) => 0.8 + 0.2 * ss(-0.3, 0.8, -Math.sin(a)) });
    const ank = leg[15], shin = norm(sub(leg[15], leg[11]));
    const bt = []; for (let i = 0; i <= 5; i++) bt.push(madd(ank, shin, -0.15 + 0.16 * i / 5));
    tubeF(bt, t => (t < 0.18 ? 0.064 : 0.057 - 0.005 * t), { sides: 12, part: PT.LEGS, col: t => (t < 0.18 ? shade(C.leather, 1.25) : C.boot) });
    const dir = norm([0, -0.6, 0.8]), a1 = [1, 0, 0], a2 = cross(dir, a1);
    ellB(madd(madd(ank, dir, 0.07), a2, 0.01), [dir, a1, a2], [0.088, 0.047, 0.043], { seg: 12, part: PT.LEGS, col: d => (d[2] > 0.55 ? C.sole : C.boot) });
    const mid = madd(ank, dir, 0.1), ring = [];
    for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU; ring.push(madd(madd(mid, a1, Math.cos(a) * 0.05), a2, Math.sin(a) * 0.047 + 0.006)); }
    tubeF(ring, 0.006, { sides: 5, part: PT.LEGS, col: shade(C.leather, 0.7) });
    b.translate(b.box([0, 0, 0], [0.018, 0.012, 0.022], { color: C.brass, ex: () => X(1, MT.METAL, PT.LEGS) }), 0.05 * side + mid[0], mid[1], mid[2]);
  }

  // ── scarf tails (flutter is done in the vertex shader; s along the tail goes in extra.y) ──
  for (const [tail, cx, w, L] of [[0, 0.03, 0.13, 1.5], [1, -0.035, 0.11, 0.95]]) {
    const N = 28;
    gridF(N, 3, false, (k, j) => {
      const s = k / (N - 1), sl = s * L, a = (j - 1) * w / 2 * (1 - 0.25 * ss(0.9, 1, s));
      const y = 0.335 + 0.05 * (1 - Math.exp(-sl / 0.1)) + 0.07 * s + (j === 1 ? 0.006 : 0) + tail * 0.012;
      const stripe = (s > 0.84 && s < 0.875) || (s > 0.91 && s < 0.945);
      return [[cx + a, y, -0.32 + sl], stripe ? C.scarfLt : shade(C.scarf, 0.95 + 0.1 * (j === 1)), X(1, 10 + tail * 10 + s, PT.TORSO)];
    });
  }
  // ── torso: chest/shoulders are hidden in first person, lower back + hips stay (seen when looking back) ──
  const TORSO_F = [[-0.37, 0.25, 0.02, 0.02, 2], [-0.358, 0.247, 0.1, 0.068, 2.2], [-0.33, 0.242, 0.158, 0.098, 2.4], [-0.28, 0.237, 0.188, 0.112, 2.6],
    [-0.2, 0.234, 0.196, 0.118, 2.6], [-0.1, 0.231, 0.186, 0.116, 2.5], [0.02, 0.228, 0.166, 0.106, 2.4]];
  const TORSO_R = [[0.02, 0.228, 0.166, 0.106, 2.4], [0.1, 0.226, 0.152, 0.1, 2.4], [0.165, 0.225, 0.154, 0.1, 2.4], [0.172, 0.225, 0.157, 0.103, 2.4],
    [0.215, 0.225, 0.158, 0.104, 2.4], [0.222, 0.224, 0.16, 0.103, 2.4], [0.31, 0.223, 0.162, 0.104, 2.4], [0.4, 0.221, 0.156, 0.1, 2.4],
    [0.47, 0.219, 0.13, 0.085, 2.3], [0.52, 0.217, 0.08, 0.055, 2.2], [0.545, 0.215, 0.02, 0.015, 2]];
  function torso(secs) {
    loftZ(secs, 22, (k, ang, s, p) => {
      const z = s[0], sa = Math.sin(ang);
      const wr = z > -0.05 && z < 0.17 ? Math.sin(ang * 4 + z * 60) * (1 - Math.abs(z - 0.06) / 0.11) : 0;
      let col = z < 0.168 ? mixC(C.jacket, C.jacketDk, clamp(0.3 - wr * 0.7, 0, 1)) : z < 0.218 ? C.leather : C.trousers;
      if (z > -0.31 && z < -0.12 && Math.abs(p[0]) > 0.09 && sa > 0.3) col = C.patch;
      const q = [p[0] * (1 + 0.03 * wr), p[1] + (p[1] - s[1]) * 0.03 * wr, p[2]];
      return [col, X(0.62 + 0.38 * ss(-0.7, 0.5, sa), 0, PT.TORSO), q];
    });
  }
  torso(TORSO_R);
  // satchel strapped to the lower back
  {
    const cz = 0.27, hz = 0.07, secs = [];
    for (let i = 0; i <= 8; i++) { const zn = -1 + 2 * i / 8, e = Math.pow(1 - Math.pow(Math.abs(zn), 4), 0.25); secs.push([cz + zn * hz, 0.335, 0.09 * e + 0.002, 0.036 * e + 0.002, 4]); }
    loftZ(secs, 16, (k, ang) => [Math.sin(ang) > 0.2 && k < 6 ? shade(C.leather, 0.8) : shade(C.leather, 1.15), X(0.75 + 0.25 * ss(-0.5, 0.8, Math.sin(ang)), 0, PT.TORSO)]);
    b.translate(b.box([0, 0, 0], [0.026, 0.01, 0.018], { color: C.brass, ex: () => X(1, MT.METAL, PT.TORSO) }), 0.03, 0.372, cz - 0.02);
    tubeF([[-0.12, 0.3, cz - 0.03], [-0.05, 0.345, cz - 0.03], [0.1, 0.345, cz - 0.03], [0.155, 0.3, cz - 0.03]], 0.006, { sides: 5, col: shade(C.leather, 0.7), part: PT.TORSO });
  }
  torso(TORSO_F);
  {
    const HC = [0, 0.315, -0.45], HR = [0.082, 0.094, 0.098];
    const onHead = (d, k) => [HC[0] + d[0] * HR[0] * k, HC[1] + d[1] * HR[1] * k, HC[2] + d[2] * HR[2] * k];
    // neck, fleece collar and the scarf wrapped around it
    tubeF([[0, 0.228, -0.29], [0, 0.268, -0.36], [0, 0.305, -0.42]], 0.044, { sides: 10, col: C.skin, part: PT.HEAD });
    const nd = norm([0, 0.06, -0.07]), n1 = [1, 0, 0], n2 = cross(nd, n1);
    const ring = (c, R, rt, col, part, wob) => {
      const pts = []; for (let i = 0; i <= 20; i++) { const a = i / 20 * TAU; pts.push(madd(madd(c, n1, Math.cos(a) * R), n2, Math.sin(a) * R * 0.92 + (wob || 0) * Math.sin(a * 3))); }
      tubeF(pts, (t, a) => rt * (1 + 0.12 * Math.sin(t * 40 + a * 2)), { sides: 8, col, part });
    };
    ring([0, 0.262, -0.33], 0.058, 0.026, C.fleece, PT.TORSO);
    ring([0, 0.283, -0.355], 0.052, 0.02, C.scarf, PT.TORSO, 0.004);
    ell([0.022, 0.322, -0.33], [0.032, 0.022, 0.03], { seg: 10, col: shade(C.scarf, 0.9), part: PT.TORSO });
    // head in an aviator cap with a fleece-lined face opening
    ell(HC, HR, { seg: 20, stacks: 14, part: PT.HEAD, col: d => (d[2] < -0.5 ? (d[1] < 0.02 && Math.abs(d[0]) > 0.3 ? [0.9, 0.58, 0.48] : C.skin) : C.cap), ao: d => 0.8 + 0.2 * ss(-0.8, 0.4, d[1]) });
    const rim = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * TAU, r = Math.sqrt(1 - 0.25); rim.push(onHead([Math.cos(a) * r, Math.sin(a) * r, -0.5], 1.03)); }
    tubeF(rim, 0.012, { sides: 7, col: C.fleece, part: PT.HEAD });
    tubeF(crs([onHead([0, 0.99, -0.12], 1.02), onHead([0, 0.75, 0.66], 1.02), onHead([0, 0.1, 0.99], 1.02)], 8), 0.005, { sides: 5, col: shade(C.cap, 0.7), part: PT.HEAD });
    for (const sd of [1, -1]) {
      ell(onHead([sd * 0.97, -0.25, 0.05], 1.0), [0.022, 0.05, 0.042], { seg: 10, col: shade(C.cap, 1.08), part: PT.HEAD });
      // goggles: brass rims, amber glass
      const E = [0.034 * sd, 0.333, -0.538], rimP = [];
      for (let i = 0; i <= 14; i++) { const a = i / 14 * TAU; rimP.push([E[0] + Math.cos(a) * 0.024, E[1] + Math.sin(a) * 0.021, E[2]]); }
      tubeF(rimP, 0.0065, { sides: 6, col: C.brass, mt: MT.METAL, part: PT.HEAD });
      ell([E[0], E[1], E[2] - 0.002], [0.022, 0.019, 0.009], { seg: 10, col: C.lens, mt: MT.GLASS, part: PT.HEAD });
      // hair tufts escaping the cap at the back
      for (let h = 0; h < 2; h++) {
        const r0 = onHead([sd * (0.3 + 0.25 * h), -0.35, 0.9], 0.95);
        tubeF(crs([r0, [r0[0] * 1.15, r0[1] - 0.03, r0[2] + 0.04], [r0[0] * 1.3, r0[1] - 0.045, r0[2] + 0.075]], 5), t => 0.013 * (1 - t) + 0.001, { sides: 5, col: [0.42, 0.19, 0.09], part: PT.HEAD });
      }
    }
    tubeF([[-0.011, 0.336, -0.543], [0, 0.34, -0.546], [0.011, 0.336, -0.543]], 0.004, { sides: 5, col: C.brass, mt: MT.METAL, part: PT.HEAD });
    const strap = []; for (let i = 0; i <= 18; i++) { const a = -0.6 + i / 18 * (Math.PI + 1.2); strap.push([HC[0] + Math.cos(a) * 0.088, HC[1] + 0.018 + 0.03 * Math.max(0, Math.sin(a)), HC[2] + Math.sin(a) * 0.103]); }
    tubeF(strap, 0.008, { sides: 5, col: shade(C.leather, 0.75), part: PT.HEAD });
    ell([0, 0.307, -0.546], [0.013, 0.019, 0.016], { seg: 8, col: shade(C.skin, 0.97), part: PT.HEAD });
  }
  const COUNT_ALL = b.i.length;

  // ═══════════════════════ runtime ═══════════════════════
  gl.bindVertexArray(null);
  const mesh = b.upload();
  const VAO = gl.createVertexArray();
  gl.bindVertexArray(VAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
  for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]]) {
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 52, off * 4); gl.vertexAttribDivisor(loc, 0);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
  gl.bindVertexArray(null);

  const QROT = 'vec3 qrot(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz, v) + q.w*v); }\n';
  const PR = program(QROT + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
uniform mat4 uVPm; uniform vec4 uQ; uniform vec3 uPos; uniform mat4 uParts[${NPART}]; uniform vec4 uScarf;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec4 vEx;
void main(){
  vec3 P = aP, N = aN;
  if (aX.y > 9.5) { // scarf tails: travelling waves + twist, growing toward the free end
    float tail = step(19.5, aX.y), s = aX.y - 10.0 - 10.0*tail;
    float ph = uScarf.x*(1.0 + 0.13*tail) + tail*2.1;
    float L = mix(1.5, 0.95, tail), env = s*(0.22 + 0.78*s), amp = uScarf.y*env;
    float k = 7.5 - 1.5*tail;
    float a1 = s*k - ph, a2 = s*k*2.3 - ph*1.7 + 1.3, a3 = s*k*0.7 - ph*1.2 + 0.6;
    float lat = (sin(a1) + 0.3*sin(a2))*0.1*amp + uScarf.w*s*s*0.4;
    float ver = sin(a3)*0.08*amp - uScarf.z*s*s*0.3;
    float tw = (sin(s*4.5 - ph*0.8 + tail*1.9)*0.85 + 0.25*sin(a2))*amp;
    float cx = mix(0.03, -0.035, tail), acr = P.x - cx, ct = cos(tw), st = sin(tw);
    float dl = (cos(a1)*k + 0.3*cos(a2)*k*2.3)*0.1*amp/L, dv = cos(a3)*k*0.7*0.08*amp/L;
    P = vec3(cx + acr*ct + lat, P.y + acr*st + ver, P.z - (abs(lat) + abs(ver))*0.25);
    N = normalize(vec3(-st, ct, st*dl - ct*dv));
  }
  mat4 pm = uParts[int(aX.z + 0.5)];
  vec3 lp = (pm*vec4(P, 1.0)).xyz, ln = mat3(pm)*N;
  vec3 p = qrot(uQ, lp) + uPos;
  vN = qrot(uQ, ln); vCol = aC; vRel = p; vEx = aX;
  gl_Position = uVPm*vec4(p, 1.0);
}`, GLSL_COMMON + MESH.LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec4 vEx; out vec4 o;
uniform float uJet, uGlow;
const vec3 TEAL = vec3(0.12, 0.37, 0.39), TERRA = vec3(0.56, 0.22, 0.14), OCHRE = vec3(0.84, 0.6, 0.25);
float hh(float n){ return fract(sin(n*91.345 + 7.13)*43758.5453); }
float chordAt(float s){ float c0 = 1.94 - 0.27*s - 0.017*s*s; float q = clamp((s - 3.55)/0.5, 0.0, 1.0); return c0*sqrt(max(1.0 - q*q, 0.0)); }
float lineAA(float d, float w, float aa){ return 1.0 - smoothstep(w - aa, w + aa, d); }
float bandAA(float x, float a, float c, float aa){ return smoothstep(a - aa, a + aa, x) - smoothstep(c - aa, c + aa, x); }
// procedural paint for the wing skin: vCol = (chord fraction u, span s in m, elevon flag)
vec3 wingPaint(vec3 c, float top, vec2 fw){
  float u = c.x, s = c.y, elev = c.z;
  float ch = max(chordAt(s), 0.12), zc = u*ch, dte = (1.0 - u)*ch;
  float aS = fw.y*0.8 + 1e-4, aZ = fw.x*ch*0.8 + 1e-4;
  float fr = fract(s/0.3), bay = floor(s/0.3);
  float hv = hh(bay + top*17.0);
  float mott = vn(vec2(s*2.1 + top*40.0, zc*2.6)) + 0.5*vn(vec2(s*7.3 + 3.0, zc*6.1 + top*9.0)) - 0.75;
  vec3 col = mix(vec3(0.64, 0.58, 0.5), vec3(0.75, 0.66, 0.51), top)*(0.95 + 0.07*hv)*(1.0 + 0.12*mott);
  col = mix(col, vec3(0.72, 0.62, 0.48)*(1.0 + 0.1*mott), elev*0.75*top);
  col *= 1.0 - 0.07*sin(3.14159*fr)*smoothstep(0.25, 0.95, u)*(0.4 + 0.6*top);
  float onRib = step(0.25, s)*step(0.05, zc)*step(0.02, dte)*step(s, 3.2);
  float rib = lineAA(min(fr, 1.0 - fr)*0.3, 0.006, aS)*onRib;
  float shd = lineAA(abs(fr*0.3 - 0.017), 0.009, aS)*onRib;
  col = mix(col, col*mix(0.88, 1.13, top), rib*0.85);
  col *= 1.0 - 0.09*shd*top;
  float seam = lineAA(abs(zc - 0.3*ch), 0.004, aZ)*step(0.2, s);
  col *= 1.0 - seam*(0.1 + 0.12*step(0.5, fract(s*24.0)));
  float scal = 0.05 + 0.045*(0.5 - 0.5*cos(6.28318*fr));
  float te = (1.0 - smoothstep(scal - aZ, scal + aZ, dte))*step(0.3, s)*step(s, 3.22)*top;
  col = mix(col, TEAL*(1.0 + 0.1*mott), te);
  float bw = mix(0.07, 0.13, top);
  float le = 1.0 - smoothstep(bw - aZ, bw + aZ, zc);
  float pin = lineAA(abs(zc - bw - 0.022), 0.006, aZ)*top;
  col = mix(col, TERRA*(1.0 + 0.12*mott), le);
  col = mix(col, OCHRE, pin);
  if (top > 0.5) {
    vec2 q = vec2(s - 2.2, zc - 0.48*ch);
    float r = length(q), aR = max(aS, aZ);
    float f = r/0.065 - atan(q.y, q.x)/6.28318;
    float arm = lineAA(abs(fract(f) - 0.5)*0.065, 0.011, aR)*(1.0 - smoothstep(0.2 - aR, 0.2 + aR, r))*smoothstep(0.04 - aR, 0.04 + aR, r);
    col = mix(col, TEAL, arm);
    col = mix(col, OCHRE, 1.0 - smoothstep(0.03 - aR, 0.03 + aR, r));
  } else {
    col = mix(col, TEAL*(1.0 + 0.1*mott), (bandAA(s, 2.5, 2.64, aS) + bandAA(s, 2.76, 2.83, aS))*(1.0 - le));
  }
  float tipS = smoothstep(3.25 - aS, 3.25 + aS, s);
  col = mix(col, OCHRE, bandAA(s, 3.19, 3.25, aS)*(1.0 - le));
  col = mix(col, TEAL*(1.0 + 0.12*mott), tipS*(1.0 - le*0.7));
  return col;
}
void main(){
  if (uShadowPass > 0.5) { o = vec4(0.0); return; }
  vec3 n = normalize(vN), v = normalize(vRel);
  // orient the shading normal by the true facet facing (robust at grazing angles, unlike a view-dot flip)
  vec3 ng = cross(dFdx(vRel), dFdy(vRel));
  ng = dot(ng, ng) > 1e-20 ? normalize(ng) : -v;
  if (dot(ng, v) > 0.0) ng = -ng;
  if (dot(n, ng) < 0.0) n = -n;
  vec2 fw = fwidth(vCol.xy);
  float m = vEx.y, ao = vEx.x, fol = 0.0, emit = 0.0;
  vec3 alb = vCol;
  if (m > 2.5 && m < 4.5) alb = wingPaint(vCol, step(m, 3.5), fw);
  else if (m > 9.5) fol = 0.55;
  alb = toLin(alb);
  if (vEx.w > 0.001) { float j = clamp(uJet, 0.0, 1.0); alb = toLin(mix(vec3(0.09, 0.075, 0.07), vCol, min(j*1.6, 1.0))); emit = vEx.w*j*uGlow; }
  gShadow = sunShadow(vRel, n);
  vec3 col = lightMesh(alb, n, v, ao, emit, fol);
  col += alb*uSunCol*vec3(0.42, 0.4, 0.3)*max(-n.y, 0.0)*0.32*ao; // warm bounce from the ground onto undersides
  if (m > 4.5 && m < 6.5) {
    vec3 r = reflect(v, n); float g = step(5.5, m);
    col += (uSunCol*pow(max(dot(r, uSun), 0.0), mix(28.0, 90.0, g))*mix(0.4, 1.1, g) + skyCol(r)*mix(0.08, 0.3, g))*ao;
  }
  if (uNoFog < 0.5) col = fogIt(col, vRel);
  o = vec4(col, 1.0);
}`);

  // ── exhaust flame: two soft cones + a glow billboard, additive ──
  const FV = [], FI = [], FR = 9, FSd = 14;
  for (let sh = 0; sh < 2; sh++) {
    const base = FV.length / 3;
    for (let k = 0; k <= FR; k++) for (let j = 0; j < FSd; j++) FV.push(j / FSd * TAU, k / FR, sh);
    for (let k = 0; k < FR; k++) for (let j = 0; j < FSd; j++) {
      const a = base + k * FSd + j, c = base + k * FSd + (j + 1) % FSd;
      FI.push(a, c, c + FSd, a, c + FSd, a + FSd);
    }
  }
  const fbb = FV.length / 3;
  FV.push(-1, -1, 2, 1, -1, 2, 1, 1, 2, -1, 1, 2);
  FI.push(fbb, fbb + 1, fbb + 2, fbb, fbb + 2, fbb + 3);
  const FVAO = gl.createVertexArray();
  gl.bindVertexArray(FVAO);
  GLX.attribs(GLX.buffer(new Float32Array(FV)), [[0, 3, 3, 0, 0]]);
  GLX.buffer(new Uint16Array(FI), gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);
  const FCOUNT = FI.length;
  const FL = program(QROT + `
layout(location=0) in vec3 aF;
uniform mat4 uVPm; uniform vec4 uQ; uniform vec3 uPos, uCR, uCU; uniform vec4 uF;
out vec3 vR; out vec3 vNn; out vec2 vQ; out float vS; out float vZ;
void main(){
  vec3 noz = vec3(0.0, ${NY.toFixed(3)}, ${(NOZZ - 0.02).toFixed(3)});
  vec3 p, n = vec3(0.0, 0.0, 1.0);
  if (aF.z > 1.5) {
    vec3 c = qrot(uQ, noz + vec3(0.0, 0.0, 0.05)) + uPos;
    p = c + (uCR*aF.x + uCU*aF.y)*(0.3 + 0.25*uF.x);
    vQ = aF.xy; vZ = 0.0;
  } else {
    float inner = aF.z, z = aF.y, t = uF.y;
    float len = uF.z*mix(1.0, 0.5, inner);
    float fl = 1.0 + 0.12*sin(t*53.0 + z*11.0 + inner*2.0)*z + 0.06*sin(t*97.0 - z*23.0);
    float r = mix(0.098, 0.06, inner)*pow(1.0 - z, 0.6)*(1.0 + 0.7*z)*fl;
    vec3 lp = noz + vec3(cos(aF.x)*r, sin(aF.x)*r, z*len);
    p = qrot(uQ, lp) + uPos;
    n = qrot(uQ, normalize(vec3(cos(aF.x), sin(aF.x), 0.8)));
    vQ = vec2(0.0); vZ = z;
  }
  vR = p; vNn = n; vS = aF.z;
  gl_Position = uVPm*vec4(p, 1.0);
}`, GLSL_COMMON + `
in vec3 vR; in vec3 vNn; in vec2 vQ; in float vS; in float vZ; uniform vec4 uF; out vec4 o;
void main(){
  float jet = uF.x;
  vec3 v = normalize(vR);
  float att = 3.0; // additive flame, scene-linear HDR (blooms)
  vec3 col;
  if (vS > 1.5) {
    col = vec3(1.0, 0.6, 0.28)*exp(-dot(vQ, vQ)*6.0)*0.5*jet;
  } else {
    float f = pow(abs(dot(normalize(vNn), v)), 1.4);
    float along = pow(1.0 - vZ, 1.5)*smoothstep(0.0, 0.08, vZ + 0.02);
    vec3 c = vS > 0.5 ? vec3(1.0, 0.78, 0.45)*0.75 : mix(vec3(1.0, 0.48, 0.18), vec3(0.8, 0.24, 0.12), vZ)*0.55;
    col = c*f*along*jet;
  }
  o = vec4(col*att, 1.0);
}`);

  // ── animation state (all preallocated; per-frame work is a handful of small matrix ops) ──
  const PM = new Float32Array(16 * NPART);
  for (let k = 0; k < NPART; k++) PM[k * 16] = PM[k * 16 + 5] = PM[k * 16 + 10] = PM[k * 16 + 15] = 1;
  const TM = new Float32Array(16), F0 = new Float64Array(9), F1 = new Float64Array(9);
  function xfP(k, p, out) {
    const o = k * 16, x = p[0], y = p[1], z = p[2];
    out[0] = PM[o] * x + PM[o + 4] * y + PM[o + 8] * z + PM[o + 12];
    out[1] = PM[o + 1] * x + PM[o + 5] * y + PM[o + 9] * z + PM[o + 13];
    out[2] = PM[o + 2] * x + PM[o + 6] * y + PM[o + 10] * z + PM[o + 14];
    return out;
  }
  function xfV(k, p, out) {
    const o = k * 16, x = p[0], y = p[1], z = p[2];
    out[0] = PM[o] * x + PM[o + 4] * y + PM[o + 8] * z; out[1] = PM[o + 1] * x + PM[o + 5] * y + PM[o + 9] * z; out[2] = PM[o + 2] * x + PM[o + 6] * y + PM[o + 10] * z;
    return out;
  }
  function mulInto(dst, a, c) { // PM[dst] = PM[a] · PM[c]
    const oa = a * 16, oc = c * 16;
    for (let col = 0; col < 4; col++) for (let r = 0; r < 4; r++) {
      TM[col * 4 + r] = PM[oa + r] * PM[oc + col * 4] + PM[oa + 4 + r] * PM[oc + col * 4 + 1] + PM[oa + 8 + r] * PM[oc + col * 4 + 2] + PM[oa + 12 + r] * PM[oc + col * 4 + 3];
    }
    PM.set(TM, dst * 16);
  }
  function frame3(d, h, F) { // orthonormal frame e1 = d, e2 ⟂ toward h, e3 = e1 × e2
    let l = Math.hypot(d[0], d[1], d[2]) || 1;
    const ax = d[0] / l, ay = d[1] / l, az = d[2] / l, k = h[0] * ax + h[1] * ay + h[2] * az;
    let bx = h[0] - ax * k, by = h[1] - ay * k, bz = h[2] - az * k;
    l = Math.hypot(bx, by, bz) || 1; bx /= l; by /= l; bz /= l;
    F[0] = ax; F[1] = ay; F[2] = az; F[3] = bx; F[4] = by; F[5] = bz;
    F[6] = ay * bz - az * by; F[7] = az * bx - ax * bz; F[8] = ax * by - ay * bx;
  }
  // part k = rotation taking frame(d0, h0) to frame(d1, h1), translated so that P0 maps to P1
  function setFrameRT(k, d0, h0, d1, h1, P0, P1) {
    frame3(d0, h0, F0); frame3(d1, h1, F1);
    const o = k * 16;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) PM[o + c * 4 + r] = F1[r] * F0[c] + F1[3 + r] * F0[3 + c] + F1[6 + r] * F0[6 + c];
    PM[o + 3] = PM[o + 7] = PM[o + 11] = 0; PM[o + 15] = 1;
    for (let r = 0; r < 3; r++) PM[o + 12 + r] = P1[r] - (PM[o + r] * P0[0] + PM[o + 4 + r] * P0[1] + PM[o + 8 + r] * P0[2]);
  }
  // two-bone IK: elbow E from shoulder S, wrist W, bone lengths and a pole direction
  function ik(S, W, L1, L2, pole, E) {
    let dx = W[0] - S[0], dy = W[1] - S[1], dz = W[2] - S[2];
    const D = Math.hypot(dx, dy, dz) || 1, Dc = clamp(D, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    dx /= D; dy /= D; dz /= D;
    const a = (L1 * L1 - L2 * L2 + Dc * Dc) / (2 * Dc), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pd = pole[0] * dx + pole[1] * dy + pole[2] * dz;
    let px = pole[0] - dx * pd, py = pole[1] - dy * pd, pz = pole[2] - dz * pd;
    const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    E[0] = S[0] + dx * a + px * h; E[1] = S[1] + dy * a + py * h; E[2] = S[2] + dz * a + pz * h;
    return E;
  }

  const st = { t: -1e9, sx: 0, sy: 0, jet: 0, ph: 0, V: 25 };
  const qA = [0, 0, 0, 1], qB = [0, 0, 0, 1], qC = [0, 0, 0, 1], offT = [0, 0, 0], offL = [0, 0, 0];
  const scarfU = new Float32Array(4), qv = new Float32Array(4), posRel = new Float32Array(3), flameU = new Float32Array(4);
  const PHASE_WRAP = TAU * 100; // keeps every shader phase multiple continuous across the wrap
  function animate(g, jetIn, snap) {
    const t = env.time;
    let dt = t - st.t; st.t = t;
    if (dt < 0 || dt > 0.3) { dt = 0; snap = true; }
    const k = snap ? 1 : 1 - Math.exp(-dt * 9);
    st.sx += (clamp(g.stick[0] || 0, -1, 1) - st.sx) * k;
    st.sy += (clamp(g.stick[1] || 0, -1, 1) - st.sy) * k;
    st.jet += (clamp(jetIn || 0, 0, 1) - st.jet) * (snap ? 1 : 1 - Math.exp(-dt * 12));
    st.V += ((g.V || 0) - st.V) * (snap ? 1 : 1 - Math.exp(-dt * 3));
    const freq = 4.5 + 0.3 * Math.min(st.V, 110);
    st.ph = snap ? (t * freq) % PHASE_WRAP : (st.ph + dt * freq) % PHASE_WRAP;
    const lean = st.sx, pull = st.sy, J = st.jet;
    // elevons: pitch symmetric, roll differential (positive = trailing edge up)
    const upR = clamp(0.34 * pull + 0.32 * lean, -0.5, 0.5), upL = clamp(0.34 * pull - 0.32 * lean, -0.5, 0.5);
    const hr = HINGE[1], hl = HINGE[-1];
    Q.axis(qA, hr.axis[0], hr.axis[1], hr.axis[2], -upR); MESH.partMatrix(PM, PT.ELEV_R, qA, hr.piv);
    Q.axis(qA, hl.axis[0], hl.axis[1], hl.axis[2], upL); MESH.partMatrix(PM, PT.ELEV_L, qA, hl.piv);
    // control bar: slides toward the pilot on a pull, twists like handlebars with the lean
    Q.axis(qA, 1, 0, 0, 0.1 * pull); Q.axis(qB, 0, 1, 0, -0.15 * lean); Q.mul(qC, qA, qB);
    MESH.partMatrix(PM, PT.BAR, qC, PIV_BAR);
    // body: roll/shift into the lean, chest lifts on a pull, tucks down with the jet, slow breathing
    const br = Math.sin(t * 1.7) * 0.0035 * (1 - J * 0.5);
    Q.axis(qA, 0, 0, 1, -0.14 * lean); Q.axis(qB, 1, 0, 0, 0.05 * pull - 0.035 * J); Q.mul(qC, qA, qB);
    offT[0] = 0.035 * lean; offT[1] = br - 0.012 * J; offT[2] = 0.012 * pull;
    MESH.partMatrix(PM, PT.TORSO, qC, PIV_T, offT);
    Q.axis(qA, 0, 0, 1, -0.07 * lean); offL[0] = 0.012 * lean; offL[1] = offT[1] * 0.5; offL[2] = 0;
    MESH.partMatrix(PM, PT.LEGS, qA, PIV_T, offL);
    // head looks into the turn and counter-rolls toward the horizon
    Q.axis(qA, 0, 1, 0, -0.22 * lean); Q.axis(qB, 1, 0, 0, 0.06 * pull - 0.1 * J); Q.mul(qC, qA, qB);
    Q.axis(qA, 0, 0, 1, 0.09 * lean); Q.mul(qC, qC, qA);
    MESH.partMatrix(PM, PT.HEAD, qC, PIV_N); mulInto(PT.HEAD, PT.TORSO, PT.HEAD);
    // arms: shoulders ride the torso, wrists ride the bar, elbows solved by IK
    for (let i = 0; i < ARMS.length; i++) {
      const A = ARMS[i];
      xfP(PT.TORSO, A.S0, A.S1); xfP(PT.BAR, A.W0, A.W1); xfV(PT.BAR, A.T0, A.T1);
      A.pole1[0] = A.side * (0.85 - 0.3 * J); A.pole1[1] = -0.5 - 0.3 * J; A.pole1[2] = 0.15;
      ik(A.S1, A.W1, A.L1, A.L2, A.pole1, A.E1);
      A.d1[0] = A.E1[0] - A.S1[0]; A.d1[1] = A.E1[1] - A.S1[1]; A.d1[2] = A.E1[2] - A.S1[2];
      setFrameRT(A.pu, A.dU0, A.pole0, A.d1, A.pole1, A.S0, A.S1);
      A.d2[0] = A.W1[0] - A.E1[0]; A.d2[1] = A.W1[1] - A.E1[1]; A.d2[2] = A.W1[2] - A.E1[2];
      setFrameRT(A.pf, A.dF0, A.T0, A.d2, A.T1, A.W0, A.W1);
    }
    // scarf: faster, tighter flutter with speed; droops when slow; swings out of the lean
    scarfU[0] = st.ph;
    scarfU[1] = clamp(1.2 - st.V / 110, 0.55, 1.15) + 0.25 * J;
    scarfU[2] = clamp(1 - (st.V - 5) / 17, 0, 1);
    scarfU[3] = clamp(-0.35 * lean - 0.08 * (g.rollRate || 0), -0.5, 0.5);
  }

  function draw(g, cam, vp, firstPerson, jet, snap) {
    animate(g, jet, !!snap);
    gl.useProgram(PR.p); setEnv(PR);
    gl.uniformMatrix4fv(PR.u.uVPm, false, vp || env.vp);
    qv[0] = g.q[0]; qv[1] = g.q[1]; qv[2] = g.q[2]; qv[3] = g.q[3];
    posRel[0] = g.pos[0] - env.cam[0]; posRel[1] = g.pos[1] - env.cam[1]; posRel[2] = g.pos[2] - env.cam[2];
    gl.uniform4fv(PR.u.uQ, qv); gl.uniform3fv(PR.u.uPos, posRel);
    gl.uniformMatrix4fv(PR.u.uParts, false, PM);
    gl.uniform4fv(PR.u.uScarf, scarfU);
    const t = env.time;
    gl.uniform1f(PR.u.uJet, st.jet);
    gl.uniform1f(PR.u.uGlow, 1.5 + 0.25 * Math.sin(t * 37) + 0.15 * Math.sin(t * 61));
    gl.uniform1f(PR.u.uSpec, 0.14); gl.uniform1f(PR.u.uNoFog, firstPerson ? 1 : 0);
    gl.bindVertexArray(VAO);
    gl.drawElements(gl.TRIANGLES, firstPerson ? COUNT_FP : COUNT_ALL, gl.UNSIGNED_INT, 0);
    if (!firstPerson && st.jet > 0.02) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
      gl.useProgram(FL.p); setEnv(FL);
      gl.uniformMatrix4fv(FL.u.uVPm, false, vp || env.vp);
      gl.uniform4fv(FL.u.uQ, qv); gl.uniform3fv(FL.u.uPos, posRel);
      gl.uniform3fv(FL.u.uCR, cam.r); gl.uniform3fv(FL.u.uCU, cam.u);
      flameU[0] = st.jet; flameU[1] = t % 1000; flameU[2] = (0.35 + 0.85 * st.jet) * (1 + 0.06 * Math.sin(t * 31)); flameU[3] = 0;
      gl.uniform4fv(FL.u.uF, flameU);
      gl.bindVertexArray(FVAO);
      gl.drawElements(gl.TRIANGLES, FCOUNT, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  return {
    name: 'glider', HEAD, draw,
    tris: COUNT_ALL / 3, trisFP: COUNT_FP / 3,
    preview(ctx) { draw(ctx.g, ctx.cam, ctx.vp, !!ctx.fp, ctx.g.jet, true); },
  };
})();
MODELS.push(GLIDER);
