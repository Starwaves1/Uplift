'use strict';
// ───────────────────────── Landmarks: villages, windmills, ruins, stone circles, boulders, lighthouses ─────────────────────────
// Everything is procedural (MESH.Builder) and drawn by one instanced shader (LM) that understands a per-vertex "part" code:
//   1 spinning (windmill sails about uSpin/uAxis)   2 roof palette recolour   3 wall palette recolour
//   4 foundation drop (vertex sinks to the terrain under it)   5 terrain conform (y = ground + local y)
// It also does a complementary dithered LOD cross-fade and a warm window glow toward dusk.
// Placement is deterministic per large cell (villages 1400 m, ruins 1100 m, stone circles 1300 m, lighthouses 2000 m,
// boulders 200 m), generated lazily with a small per-frame time budget and cached.
const LANDMARKS = (() => {
  const { gl, program, buffer, env, setEnv } = GLX;
  const V3 = MESH.V3, STRIDE = MESH.STRIDE, TAU = Math.PI * 2;
  const WIND = typeof WORLD !== 'undefined' ? WORLD.WIND : [4.0, 0, 1.8];
  // item yaw a maps local +Z to world (sin a, cos a); windmill sails sit on local +Z and must face upwind
  const WIND_YAW = Math.atan2(-WIND[0], -WIND[2]);

  function rng(i, j, salt) {
    let a = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hp = (p, k, salt) => hash2(Math.floor(p[0] * k + salt * 13.1), Math.floor(p[1] * k * 1.3 + p[2] * k + salt * 7.7));
  const EX = (ao, part, emit) => [ao, 0, part || 0, emit || 0];
  const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const COL = {
    white: [0.95, 0.92, 0.85], stone: [0.67, 0.61, 0.52], stoneD: [0.55, 0.5, 0.44], ruin: [0.8, 0.72, 0.59],
    timber: [0.34, 0.24, 0.16], timberL: [0.52, 0.39, 0.26], grey: [0.55, 0.52, 0.48], thatch: [0.78, 0.63, 0.38],
    moss: [0.36, 0.47, 0.19], glass: [0.16, 0.19, 0.25], roof: [0.96, 0.96, 0.96], door: [0.42, 0.28, 0.17],
    sill: [0.78, 0.74, 0.66], cream: [0.93, 0.89, 0.8], brick: [0.66, 0.39, 0.29], pot: [0.72, 0.4, 0.26],
    canvas: [0.92, 0.88, 0.76], copper: [0.4, 0.62, 0.55], red: [0.74, 0.28, 0.2], rock: [0.63, 0.59, 0.53],
    shutG: [0.32, 0.5, 0.44], shutB: [0.34, 0.45, 0.6], shutR: [0.62, 0.3, 0.22],
  };

  // ── shader ──
  const VS = GLSL_COMMON + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
layout(location=4) in vec4 iA; layout(location=5) in vec4 iB;
uniform mat4 uVP; uniform vec4 uFade; uniform vec4 uSpin; uniform vec3 uAxis; uniform vec2 uGround;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec4 vEx; out vec2 vFade;
vec3 rotAx(vec3 v, vec3 k, float c, float s){ return v*c + cross(k, v)*s + k*dot(k, v)*(1.0 - c); }
void main(){
  float d = length(iA.xz - uCam.xz);
  float fin = uFade.x > 0.0 ? clamp((d - uFade.x + uFade.z)/uFade.z, 0.0, 1.0) : 1.0;
  float fout = clamp((uFade.y - d)/uFade.w, 0.0, 1.0);
  if (fin <= 0.0 || fout <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float part = aX.z;
  vec3 lp = aP, ln = aN;
  if (part > 0.5 && part < 1.5) {
    float a = uTime*uSpin.w*(0.85 + 0.3*iB.z) + iB.w;
    float c = cos(a), s = sin(a);
    lp = rotAx(lp - uSpin.xyz, uAxis, c, s) + uSpin.xyz;
    ln = rotAx(ln, uAxis, c, s);
  }
  lp *= iA.w;
  float c = cos(iB.x), s = sin(iB.x);
  vec3 p = vec3(lp.x*c + lp.z*s, lp.y, -lp.x*s + lp.z*c);
  vec3 n = vec3(ln.x*c + ln.z*s, ln.y, -ln.x*s + ln.z*c);
  vec3 wp = iA.xyz + p;
  if (part > 3.5) {
    float th = uGround.y;
    if (uGround.x < 0.5) {
      vec2 dd = wp.xz - uCam.xz; float dy = max(uCam.y - 1350.0, 0.0);
      th = terrainH(wp.xz, 1.0 - smoothstep(1400.0, 2600.0, sqrt(dot(dd, dd) + dy*dy)));
    }
    if (part < 4.5) wp.y = min(wp.y, th - 0.6); else wp.y = th + p.y;
  }
  vec3 col = aC;
  float sd = iB.z;
  if (part > 1.5 && part < 2.5) {
    col *= sd < 0.38 ? vec3(0.82, 0.43, 0.27) : sd < 0.6 ? vec3(0.66, 0.3, 0.21) : sd < 0.86 ? vec3(0.5, 0.57, 0.68) : vec3(0.6, 0.46, 0.33);
  } else if (part > 2.5 && part < 3.5) {
    float w = fract(sd*7.31);
    col *= w < 0.5 ? vec3(1.0) : w < 0.72 ? vec3(1.0, 0.95, 0.84) : w < 0.88 ? vec3(0.99, 0.88, 0.7) : vec3(1.0, 0.9, 0.86);
  }
  col *= mix(vec3(0.91, 0.93, 0.97), vec3(1.07, 1.03, 0.94), iB.y);
  vN = n; vCol = col; vRel = wp - uCam; vEx = aX; vFade = vec2(fin, fout);
  gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const FS = GLSL_COMMON + MESH.LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec4 vEx; in vec2 vFade; uniform float uNight; out vec4 o;
void main(){
  float b = bayer4(gl_FragCoord.xy);
  if (b > vFade.y || 1.0 - b > vFade.x) discard;
  vec3 n = normalize(vN); vec3 v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;
  vec3 col = lightMesh(vCol, n, v, vEx.x, 0.0, 0.0);
  col += vec3(1.0, 0.7, 0.36)*vEx.w*(0.1 + uNight*1.3);
  if (uNoFog < 0.5) col = fogIt(col, vRel);
  o = vec4(col, 1.0);
}`;
  const LP = program(VS, FS);

  // ── instance sets (one per mesh/LOD) ──
  const SETS = [];
  function makeSet(name, mesh, o) {
    const max = o.max || 512, data = new Float32Array(max * 8);
    const buf = buffer(data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]]) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4); gl.vertexAttribDivisor(loc, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, off] of [[4, 0], [5, 4]]) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off * 4); gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    const near = o.near || 0, win = o.win || 50, far = o.far, wout = o.wout || 120;
    const s = { id: SETS.length, name, mesh, max, data, buf, vao, n: 0, dirty: false, near, far, win, wout, spin: !!o.spin,
      tris: mesh.count / 3, lo2: near > 0 ? Math.max(0, near - win - 70) ** 2 : -1, hi2: (far + 70) ** 2 };
    SETS.push(s);
    return s;
  }
  function pushInst(s, it, q) {
    if (s.n >= s.max) return;
    const o = s.n++ * 8, d = s.data;
    d[o] = it[q + 1]; d[o + 1] = it[q + 2]; d[o + 2] = it[q + 3]; d[o + 3] = it[q + 4];
    d[o + 4] = it[q + 5]; d[o + 5] = it[q + 6]; d[o + 6] = it[q + 7]; d[o + 7] = it[q + 8];
    s.dirty = true;
  }
  const HUB = [0, 11.7, 3.45], TILT = 0.14, AXIS = [0, Math.sin(TILT), Math.cos(TILT)], SPIN_RATE = 0.95;
  function drawSets(flat) {
    gl.useProgram(LP.p); setEnv(LP);
    gl.uniform1f(LP.u.uSpec, 0.06); gl.uniform1f(LP.u.uNoFog, 0);
    gl.uniform1f(LP.u.uNight, 1 - ss(0.06, 0.32, env.sun[1]));
    gl.uniform2f(LP.u.uGround, flat ? 1 : 0, 0);
    gl.uniform4f(LP.u.uSpin, HUB[0], HUB[1], HUB[2], SPIN_RATE);
    gl.uniform3f(LP.u.uAxis, AXIS[0], AXIS[1], AXIS[2]);
    for (let i = 0; i < SETS.length; i++) {
      const s = SETS[i];
      if (!s.n) continue;
      if (s.dirty) { gl.bindBuffer(gl.ARRAY_BUFFER, s.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.data, 0, s.n * 8); s.dirty = false; }
      gl.uniform4f(LP.u.uFade, s.near, s.far, s.win, s.wout);
      gl.bindVertexArray(s.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, s.mesh.count, gl.UNSIGNED_INT, 0, s.n);
    }
    gl.bindVertexArray(null);
  }

  // ── geometry helpers ──
  const cf = (c, p, n) => (typeof c === 'function' ? c(p, n) : c);
  const HF = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  // flat-shaded hexahedron: P[0..3] one ring, P[4..7] the matching opposite ring
  function hexa(b, P, col, ex) {
    const m = b.mark();
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 8; k++) { cx += P[k][0] / 8; cy += P[k][1] / 8; cz += P[k][2] / 8; }
    for (const f of HF) {
      const a = P[f[0]], q = P[f[1]], c = P[f[2]], d = P[f[3]];
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - q[0], vy = d[1] - q[1], vz = d[2] - q[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const fx = (a[0] + q[0] + c[0] + d[0]) / 4 - cx, fy = (a[1] + q[1] + c[1] + d[1]) / 4 - cy, fz = (a[2] + q[2] + c[2] + d[2]) / 4 - cz;
      if (nx * fx + ny * fy + nz * fz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const n = [nx, ny, nz], base = b.count;
      for (const k of f) b.vert(P[k], n, cf(col, P[k], n), ex ? cf(ex, P[k], n) : null);
      b.quad(base, base + 1, base + 2, base + 3);
    }
    return m;
  }
  const boxr = (b, x0, x1, y0, y1, z0, z1, col, ex) => hexa(b, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], col, ex);
  // box with the top face inset by `ins` on every side
  const tbox = (b, x0, x1, y0, y1, z0, z1, ins, col, ex) => hexa(b, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0 + ins, y1, z0 + ins], [x1 - ins, y1, z0 + ins], [x1 - ins, y1, z1 - ins], [x0 + ins, y1, z1 - ins]], col, ex);
  // vertical panel from (x0,z0) to (x1,z1) with rows at ys and nu columns (per-vertex colour/AO)
  function vpanel(b, x0, z0, x1, z1, ys, nu, col, ex) {
    const R = ys.map(y => { const r = []; for (let k = 0; k <= nu; k++) { const t = k / nu; r.push([x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t]); } return r; });
    return b.rings(R, { color: (u, v, p) => cf(col, p), ex: ex ? (u, v, p) => cf(ex, p) : null });
  }
  // wall faces of a W×D footprint centred at (x0, z0): F(u, y, o) → point (u along the face, o outward)
  function face(W, D, side, x0, z0) {
    x0 = x0 || 0; z0 = z0 || 0;
    if (side === 0) return (u, y, o) => [x0 + u, y, z0 + D / 2 + o];
    if (side === 1) return (u, y, o) => [x0 - u, y, z0 - D / 2 - o];
    if (side === 2) return (u, y, o) => [x0 + W / 2 + o, y, z0 - u];
    return (u, y, o) => [x0 - W / 2 - o, y, z0 + u];
  }
  const onWall = (b, F, u0, u1, y0, y1, o0, o1, col, ex) =>
    hexa(b, [F(u0, y0, o0), F(u1, y0, o0), F(u1, y0, o1), F(u0, y0, o1), F(u0, y1, o0), F(u1, y1, o0), F(u1, y1, o1), F(u0, y1, o1)], col, ex);
  const onWallQ = (b, F, pts, o0, o1, col, ex) => hexa(b, [...pts.map(([u, y]) => F(u, y, o0)), ...pts.map(([u, y]) => F(u, y, o1))], col, ex);
  // per-face colour pass over a faceted range (3 unique verts per triangle)
  function faceColor(b, m, fn) {
    const v = b.v;
    for (let k = m.v; k + 2 < b.count; k += 3) {
      const o = k * STRIDE, c = [(v[o] + v[o + STRIDE] + v[o + 2 * STRIDE]) / 3, (v[o + 1] + v[o + 1 + STRIDE] + v[o + 1 + 2 * STRIDE]) / 3, (v[o + 2] + v[o + 2 + STRIDE] + v[o + 2 + 2 * STRIDE]) / 3];
      const col = fn(c, [v[o + 3], v[o + 4], v[o + 5]]);
      for (let q = 0; q < 3; q++) { const w = o + q * STRIDE; v[w + 6] = col[0]; v[w + 7] = col[1]; v[w + 8] = col[2]; }
    }
  }
  function lathe(b, prof, sides, col, ex, faceted) {
    const m = b.lathe(prof, { sides, color: (u, v, p) => cf(col, p), ex: ex ? (u, v, p) => cf(ex, p) : null });
    if (faceted) b.facet(m);
    return m;
  }
  // facet a range; returns a mark covering only the new (unique-vertex) triangles
  function facetM(b, m) { const v0 = b.count; b.facet(m); return { v: v0, i: m.i }; }

  // ── cottage parts ──
  function windowAt(b, F, u, y, w, h, o) {
    const fc = o.frameCol || COL.cream, fe = EX(0.88);
    onWall(b, F, u - w / 2, u + w / 2, y, y + h, -0.03, 0.02, COL.glass, EX(0.72, 0, 0.4));
    onWall(b, F, u - w / 2 - 0.09, u - w / 2 + 0.02, y, y + h, -0.02, 0.13, fc, fe);
    onWall(b, F, u + w / 2 - 0.02, u + w / 2 + 0.09, y, y + h, -0.02, 0.13, fc, fe);
    onWall(b, F, u - w / 2 - 0.09, u + w / 2 + 0.09, y + h - 0.02, y + h + 0.09, -0.02, 0.13, fc, fe);
    onWall(b, F, u - w / 2, u + w / 2, y + h * 0.56 - 0.03, y + h * 0.56 + 0.03, -0.02, 0.07, fc, fe);
    onWall(b, F, u - 0.03, u + 0.03, y, y + h, -0.02, 0.07, fc, fe);
    onWall(b, F, u - w / 2 - 0.16, u + w / 2 + 0.16, y - 0.13, y + 0.01, -0.02, 0.24, COL.sill, EX(0.9));
    if (o.lintel) onWall(b, F, u - w / 2 - 0.22, u + w / 2 + 0.22, y + h + 0.09, y + h + 0.32, -0.02, 0.08, o.lintel, EX(0.86));
    if (o.shutter) {
      const sw = w * 0.5;
      onWall(b, F, u - w / 2 - 0.12 - sw, u - w / 2 - 0.12, y - 0.03, y + h + 0.03, 0.0, 0.06, o.shutter, EX(0.85));
      onWall(b, F, u + w / 2 + 0.12, u + w / 2 + 0.12 + sw, y - 0.03, y + h + 0.03, 0.0, 0.06, o.shutter, EX(0.85));
    }
  }
  function doorAt(b, F, u, w, h, o) {
    const fc = o.frameCol || COL.timber, dc = o.doorCol || COL.door;
    onWall(b, F, u - w / 2, u + w / 2, 0.36, 0.36 + h, -0.03, 0.03, dc, EX(0.62));
    onWall(b, F, u - w / 2 + 0.08, u + w / 2 - 0.08, 0.36 + h * 0.5 - 0.04, 0.36 + h * 0.5 + 0.04, 0.0, 0.06, mulc(dc, 0.8), EX(0.7));
    onWall(b, F, u - w / 2 - 0.12, u - w / 2 + 0.01, 0.36, 0.36 + h, -0.02, 0.15, fc, EX(0.85));
    onWall(b, F, u + w / 2 - 0.01, u + w / 2 + 0.12, 0.36, 0.36 + h, -0.02, 0.15, fc, EX(0.85));
    onWall(b, F, u - w / 2 - 0.16, u + w / 2 + 0.16, 0.36 + h, 0.36 + h + 0.16, -0.02, 0.17, fc, EX(0.85));
    onWall(b, F, u - w / 2 - 0.35, u + w / 2 + 0.35, -0.8, 0.2, 0.1, 0.75, COL.stone, p => EX(p[1] < -0.3 ? 0.6 : 0.85, p[1] < -0.3 ? 4 : 0));
  }
  function chimney(b, x, z, y0, y1, col) {
    boxr(b, x - 0.38, x + 0.38, y0, y1, z - 0.38, z + 0.38, col, p => EX(0.72 + 0.28 * ss(y0, y1, p[1])));
    boxr(b, x - 0.47, x + 0.47, y1, y1 + 0.14, z - 0.47, z + 0.47, COL.stoneD, EX(0.95));
    const m = lathe(b, [[0.15, y1 + 0.12], [0.12, y1 + 0.42], [0.155, y1 + 0.5]], 6, COL.pot, EX(0.9));
    b.translate(m, x + 0.12, 0, z);
  }
  // gable roof: ridge along X at H + D/2·tan(pitch); thick slabs with overhang, tile courses, barge boards, ridge cap
  function gableRoof(b, x0, x1, zc, D, H, pitch, oh, og, rc) {
    const tp = Math.tan(pitch), ridge = H + D / 2 * tp, ze = D / 2 + oh, ye = H - oh * tp, dth = 0.24 / Math.cos(pitch);
    const X0 = x0 - og, X1 = x1 + og;
    const rex = (p, n) => EX(n[1] < -0.2 ? 0.5 : 0.8 + 0.2 * ss(ye, ridge, p[1]), 2);
    for (const s of [1, -1]) {
      const P = [[X0, ridge, zc], [X1, ridge, zc], [X1, ye, zc + s * ze], [X0, ye, zc + s * ze]];
      hexa(b, [...P, ...P.map(p => [p[0], p[1] + dth, p[2]])], rc, rex);
      for (const f of [0.22, 0.44, 0.66, 0.86]) {
        const ya = ridge + dth + (ye - ridge) * f, yb = ridge + dth + (ye - ridge) * (f + 0.035);
        const Q = [[X0 + 0.04, ya, zc + s * ze * f], [X1 - 0.04, ya, zc + s * ze * f], [X1 - 0.04, yb, zc + s * ze * (f + 0.035)], [X0 + 0.04, yb, zc + s * ze * (f + 0.035)]];
        hexa(b, [...Q, ...Q.map(p => [p[0], p[1] + 0.07, p[2]])], mulc(rc, 0.8), rex);
      }
      for (const xb of [X0, X1]) {
        const B = [[xb - 0.07, ridge - 0.12, zc], [xb + 0.07, ridge - 0.12, zc], [xb + 0.07, ye - 0.12, zc + s * ze], [xb - 0.07, ye - 0.12, zc + s * ze]];
        hexa(b, [...B, ...B.map(p => [p[0], p[1] + dth + 0.16, p[2]])], COL.timber, EX(0.8));
      }
    }
    boxr(b, X0 - 0.05, X1 + 0.05, ridge + dth - 0.12, ridge + dth + 0.14, zc - 0.2, zc + 0.2, mulc(rc, 0.84), EX(1, 2));
    return ridge;
  }
  // hipped, rounded thatch: concentric rounded-rectangle rings from eave to ridge
  function thatchRoof(b, W, D, ye, Hth, oh) {
    const L = W / 2 + oh, w0 = D / 2 + oh, N = 28, K = 9, rings = [];
    const ringAt = (ax, az, y) => {
      const r = [];
      for (let k = 0; k < N; k++) {
        const a = k / N * TAU, c = Math.cos(a), s = Math.sin(a);
        r.push([ax * Math.sign(c) * Math.pow(Math.abs(c), 0.28), y, az * Math.sign(s) * Math.pow(Math.abs(s), 0.28)]);
      }
      return r;
    };
    rings.push(ringAt(L - 0.1, w0 - 0.1, ye - 0.38));
    for (let k = 0; k <= K; k++) {
      const t = k / K, inset = w0 * t * 0.97;
      rings.push(ringAt(Math.max(L - inset, 0.3), Math.max(w0 - inset, 0.06), ye + Hth * (1 - Math.pow(1 - t, 1.8))));
    }
    const top = ye + Hth;
    const m = b.rings(rings, { closed: true, color: (u, v, p) => {
      const t = ss(ye, top, p[1]);
      let c = mixc(mulc(COL.thatch, 0.78), COL.thatch, ss(0, 0.25, t));
      if (t > 0.86) c = mixc(c, [0.6, 0.5, 0.3], 0.7);
      return mulc(c, 0.93 + 0.14 * hp(p, 1.3, 3));
    }, ex: (u, v, p) => EX(p[1] < ye ? 0.55 : 0.78 + 0.22 * ss(ye, top, p[1])) });
    b.cap(rings[0], [0, ye - 0.38, 0], { color: mulc(COL.thatch, 0.6), ex: () => EX(0.45) }, true);
    return { m, top };
  }
  // beam between two points of a wall's (o, y) plane at u, thickness t across u
  const strut = (b, F, u, y0, o0, y1, o1, t, col, ex) => hexa(b, [F(u - t, y0, o0), F(u + t, y0, o0), F(u + t, y0 + 0.12, o0), F(u - t, y0 + 0.12, o0),
    F(u - t, y1, o1), F(u + t, y1, o1), F(u + t, y1 + 0.12, o1), F(u - t, y1 + 0.12, o1)], col, ex);
  function porchGable(b, F, u) {
    const d = 1.6, hw = 1.05, eave = 2.55, top = 3.3;
    for (const s of [-1, 1]) onWall(b, F, u + s * hw - 0.08, u + s * hw + 0.08, 0.2, eave, d - 0.16, d, COL.timberL, EX(0.85));
    onWall(b, F, u - hw - 0.1, u + hw + 0.1, eave - 0.2, eave, d - 0.18, d + 0.02, COL.timber, EX(0.8));
    for (const s of [-1, 1]) {
      const ue = u + s * (hw + 0.32);
      onWallQ(b, F, [[u, top], [ue, eave - 0.16], [ue, eave], [u, top + 0.16]], -0.02, d + 0.35, COL.roof, (p, n) => EX(n[1] < -0.2 ? 0.55 : 0.95, 2));
    }
    onWallQ(b, F, [[u - hw - 0.1, eave], [u + hw + 0.1, eave], [u, top - 0.02], [u, top - 0.02]], d - 0.06, d, COL.cream, EX(0.8));
    onWall(b, F, u - 0.6, u + 0.6, 0.2, 0.62, 0.2, 0.55, COL.timberL, EX(0.7));
  }
  function porchHood(b, F, u, w) {
    const P = [F(u - w / 2, 2.72, 0), F(u + w / 2, 2.72, 0), F(u + w / 2, 2.42, 1.05), F(u - w / 2, 2.42, 1.05)];
    hexa(b, [...P, ...P.map(p => [p[0], p[1] + 0.15, p[2]])], COL.roof, (p, n) => EX(n[1] < -0.2 ? 0.55 : 0.95, 2));
    for (const s of [-1, 1]) strut(b, F, u + s * (w / 2 - 0.15), 1.95, 0, 2.45, 0.85, 0.06, COL.timber, EX(0.8));
  }
  // plinth + four walls (+ gable triangles); o.part 3 = recolourable whitewash
  function body(b, W, D, H, o) {
    const x0 = o.x0 || 0, z0 = o.z0 || 0;
    boxr(b, x0 - W / 2 - 0.16, x0 + W / 2 + 0.16, -3.2, 0.36, z0 - D / 2 - 0.16, z0 + D / 2 + 0.16, o.plinth || COL.stoneD,
      p => EX(p[1] < -1 ? 0.55 : 0.8, p[1] < -1 ? 4 : 0));
    const ao = p => EX(Math.min(0.64 + 0.36 * ss(0.3, 1.5, p[1]), 1 - 0.3 * ss(H - 1.0, H + 0.05, p[1])), o.part);
    const col = o.stoneWall ? p => mulc(o.wall, 0.84 + 0.26 * hp(p, 1.7, 5)) : p => mulc(o.wall, 0.97 + 0.05 * hp(p, 0.8, 5));
    const C = [[x0 - W / 2, z0 + D / 2], [x0 + W / 2, z0 + D / 2], [x0 + W / 2, z0 - D / 2], [x0 - W / 2, z0 - D / 2]];
    for (let k = 0; k < 4; k++) {
      if (o.skip === k) continue;
      const a = C[k], c = C[(k + 1) % 4], len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      vpanel(b, a[0], a[1], c[0], c[1], o.rows, Math.max(1, Math.round(len / (o.stoneWall ? 0.8 : 3))), col, ao);
    }
    if (o.gable) {
      const Hr = D / 2 * Math.tan(o.pitch);
      for (const s of [-1, 1]) {
        const R = [];
        for (let k = 0; k <= 3; k++) { const t = k / 3, hz = D / 2 * (1 - t) + 0.01, y = H + Hr * t; R.push([[x0 + s * W / 2, y, z0 - hz], [x0 + s * W / 2, y, z0 + hz]]); }
        b.rings(R, { color: (u, v, p) => col(p), ex: (u, v) => EX(0.84 - 0.12 * v, o.part) });
      }
    }
  }

  // ── cottage variants (front door faces local +Z) ──
  function cottageA(b) { // long whitewashed cottage: stone quoins, shutters, tiled gable roof, gabled porch, two chimneys
    const W = 9, D = 5.6, H = 3.0, pitch = 0.87;
    body(b, W, D, H, { wall: COL.white, part: 3, rows: [0.36, 1.1, 2.3, H], gable: true, pitch });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 6; k++) {
      const y0 = 0.36 + k * 0.44, lx = k % 2 ? 0.55 : 0.3, lz = k % 2 ? 0.3 : 0.55, xa = sx * W / 2, za = sz * D / 2;
      boxr(b, Math.min(xa - sx * lx, xa + sx * 0.05), Math.max(xa - sx * lx, xa + sx * 0.05), y0, y0 + 0.4,
        Math.min(za - sz * lz, za + sz * 0.05), Math.max(za - sz * lz, za + sz * 0.05), mulc(COL.stone, 0.92 + 0.16 * hash2(k + sx * 7, sz * 5 + 3)), EX(0.85));
    }
    const wo = { frameCol: COL.cream, shutter: COL.shutG };
    const F0 = face(W, D, 0), F1 = face(W, D, 1), F2 = face(W, D, 2), F3 = face(W, D, 3);
    windowAt(b, F0, -3.0, 1.05, 1.0, 1.15, wo); windowAt(b, F0, -0.9, 1.05, 1.0, 1.15, wo); windowAt(b, F0, 3.3, 1.05, 1.0, 1.15, wo);
    doorAt(b, F0, 1.25, 1.0, 2.0, { doorCol: [0.3, 0.42, 0.52] });
    windowAt(b, F1, -2.2, 1.05, 1.0, 1.15, wo); windowAt(b, F1, 2.0, 1.05, 1.0, 1.15, wo);
    windowAt(b, F2, 0, H + 0.45, 0.7, 0.85, { frameCol: COL.cream }); windowAt(b, F3, 0, H + 0.45, 0.7, 0.85, { frameCol: COL.cream });
    windowAt(b, F3, -1.2, 1.05, 0.9, 1.0, wo);
    porchGable(b, F0, 1.25);
    const ridge = gableRoof(b, -W / 2, W / 2, 0, D, H, pitch, 0.5, 0.42, COL.roof);
    chimney(b, -W / 2 + 0.6, 0, H, ridge + 1.0, COL.stone);
    chimney(b, W / 2 - 0.6, 0, H, ridge + 0.75, COL.stone);
  }
  function cottageB(b) { // squat stone cottage under a rounded, hipped thatch with a tall chimney and a woodpile
    const W = 7.4, D = 5.0, H = 2.55;
    body(b, W, D, H, { wall: COL.stone, stoneWall: true, part: 0, rows: [0.36, 0.9, 1.45, 2.0, H] });
    const wo = { frameCol: COL.cream, lintel: COL.stoneD, shutter: COL.shutB };
    const F0 = face(W, D, 0), F1 = face(W, D, 1), F2 = face(W, D, 2), F3 = face(W, D, 3);
    windowAt(b, F0, -2.2, 0.95, 0.85, 0.95, wo); windowAt(b, F0, 2.2, 0.95, 0.85, 0.95, wo);
    doorAt(b, F0, 0.2, 0.95, 1.8, { doorCol: [0.56, 0.3, 0.2] });
    windowAt(b, F1, -1.2, 0.95, 0.85, 0.95, wo); windowAt(b, F2, 0.6, 0.95, 0.8, 0.9, wo);
    const t = thatchRoof(b, W, D, H + 0.15, 4.0, 0.65);
    chimney(b, W / 2 - 0.75, -0.6, H, t.top + 0.35, COL.stone);
    for (let k = 0; k < 9; k++) { // woodpile against the left wall
      const m = lathe(b, [[0.13, 0], [0.13, 1.5]], 6, mulc([0.55, 0.4, 0.26], 0.85 + 0.3 * hash2(k, 9)), EX(0.75));
      b.rotate(m, 'x', Math.PI / 2); b.translate(m, -W / 2 - 0.38 - (k % 3) * 0.1, 0.5 + Math.floor(k / 3) * 0.25, -1.8 + (k % 3) * 0.3 + (k > 5 ? 0.15 : 0));
    }
    boxr(b, -W / 2 - 0.75, -W / 2, 1.28, 1.36, -2.0, 0.2, COL.timber, EX(0.8));
    return F3;
  }
  function cottageC(b) { // two-storey timber-framed house with a stone lean-to, brick chimney and gabled porch
    const W = 8, D = 6, H = 5.2, pitch = 0.96;
    body(b, W, D, H, { wall: COL.white, part: 3, rows: [0.36, 1.2, 2.6, 4.2, H], gable: true, pitch });
    const tc = COL.timber, te = EX(0.82);
    for (let side = 0; side < 4; side++) {
      const len = side < 2 ? W : D, F = face(W, D, side), h2 = len / 2;
      const studs = side < 2 ? [-1.2, 1.2, -3.25, 3.25] : [-1.5, 1.5];
      for (const u of [-h2 + 0.12, h2 - 0.12, ...studs]) onWall(b, F, u - 0.11, u + 0.11, 0.36, H, -0.02, 0.08, tc, te);
      for (const y of [0.48, 2.62, H - 0.12]) onWall(b, F, -h2, h2, y - 0.12, y + 0.12, -0.02, 0.09, tc, te);
      for (const s of [-1, 1]) {
        const uc = s * (h2 - 0.2), ui = s * (h2 - 0.85);
        onWallQ(b, F, [[uc - 0.09, 1.35], [uc + 0.09, 1.35], [ui + 0.09, 2.5], [ui - 0.09, 2.5]], -0.02, 0.07, tc, te);
        onWallQ(b, F, [[uc - 0.09, 3.6], [uc + 0.09, 3.6], [ui + 0.09, H - 0.24], [ui - 0.09, H - 0.24]], -0.02, 0.07, tc, te);
      }
    }
    const wo = { frameCol: COL.timberL, shutter: COL.shutR };
    const F0 = face(W, D, 0), F1 = face(W, D, 1), F2 = face(W, D, 2), F3 = face(W, D, 3);
    for (const u of [-2.3, 2.3]) { windowAt(b, F0, u, 1.05, 0.95, 1.1, wo); windowAt(b, F1, u, 1.05, 0.95, 1.1, wo); }
    for (const u of [-2.3, 0, 2.3]) { windowAt(b, F0, u, 3.3, 0.95, 1.1, wo); windowAt(b, F1, u, 3.3, 0.95, 1.1, wo); }
    doorAt(b, F0, 0, 1.05, 2.05, { doorCol: [0.45, 0.25, 0.16] });
    windowAt(b, F2, 0, 3.3, 0.85, 1.0, wo); windowAt(b, F3, 0, 1.05, 0.85, 1.0, wo); windowAt(b, F3, 0, 3.3, 0.85, 1.0, wo);
    windowAt(b, F2, 0, H + 1.0, 0.7, 0.8, { frameCol: COL.timberL }); windowAt(b, F3, 0, H + 1.0, 0.7, 0.8, { frameCol: COL.timberL });
    porchGable(b, F0, 0);
    const ridge = gableRoof(b, -W / 2, W / 2, 0, D, H, pitch, 0.45, 0.4, COL.roof);
    chimney(b, -1.6, 0, H, ridge + 0.9, COL.brick);
    // lean-to outshot on +X
    const W2 = 2.9, D2 = 4.2, H2 = 2.4, x2 = W / 2 + W2 / 2, z2 = -0.6;
    body(b, W2, D2, H2, { x0: x2, z0: z2, wall: COL.stone, stoneWall: true, part: 0, rows: [0.36, 0.9, 1.5, H2], skip: 3 });
    windowAt(b, face(W2, D2, 2, x2, z2), 0, 0.95, 0.75, 0.85, { frameCol: COL.cream, lintel: COL.stoneD });
    const P = [[W / 2, 3.4, z2 - D2 / 2 - 0.3], [W / 2 + W2 + 0.4, 2.2, z2 - D2 / 2 - 0.3], [W / 2 + W2 + 0.4, 2.2, z2 + D2 / 2 + 0.3], [W / 2, 3.4, z2 + D2 / 2 + 0.3]];
    hexa(b, [...P, ...P.map(p => [p[0], p[1] + 0.22, p[2]])], COL.roof, (p, n) => EX(n[1] < -0.2 ? 0.5 : 0.9, 2));
  }
  // far LOD (≈40 tris): solid body, prism roof, chimney
  function farHouse(b, W, D, H, o) {
    boxr(b, -W / 2, W / 2, -3, H, -D / 2, D / 2, o.wall, p => EX(p[1] < -1 ? 0.6 : 0.9, p[1] < -1 ? 4 : o.part));
    if (o.thatch) {
      hexa(b, [[-W / 2 - 0.6, H - 0.2, -D / 2 - 0.6], [W / 2 + 0.6, H - 0.2, -D / 2 - 0.6], [W / 2 + 0.6, H - 0.2, D / 2 + 0.6], [-W / 2 - 0.6, H - 0.2, D / 2 + 0.6],
        [-1.4, H + 4.1, -0.06], [1.4, H + 4.1, -0.06], [1.4, H + 4.1, 0.06], [-1.4, H + 4.1, 0.06]], COL.thatch, (p, n) => EX(n[1] < 0 ? 0.5 : 0.95));
      boxr(b, W / 2 - 1.1, W / 2 - 0.4, H, H + 4.4, -0.95, -0.25, COL.stone, EX(0.9));
      return;
    }
    const tp = Math.tan(o.pitch), ridge = H + D / 2 * tp, ze = D / 2 + 0.45, ye = H - 0.45 * tp, X0 = -W / 2 - 0.4, X1 = W / 2 + 0.4;
    hexa(b, [[X0, ye, -ze], [X1, ye, -ze], [X1, ye, ze], [X0, ye, ze], [X0, ridge + 0.25, -0.02], [X1, ridge + 0.25, -0.02], [X1, ridge + 0.25, 0.02], [X0, ridge + 0.25, 0.02]],
      COL.roof, (p, n) => EX(n[1] < 0 ? 0.5 : 0.95, 2));
    boxr(b, o.chim - 0.38, o.chim + 0.38, H, ridge + 0.9, -0.38, 0.38, o.chimCol || COL.stone, EX(0.9));
    if (o.lean) hexa(b, [[W / 2, -3, -2.8], [W / 2 + 3.2, -3, -2.8], [W / 2 + 3.2, -3, 1.6], [W / 2, -3, 1.6], [W / 2, 3.4, -2.8], [W / 2 + 3.2, 2.3, -2.8], [W / 2 + 3.2, 2.3, 1.6], [W / 2, 3.4, 1.6]],
      COL.stone, p => EX(p[1] < -1 ? 0.6 : 0.9, p[1] < -1 ? 4 : 0));
  }
  // square beam from A to B (w across, h along the "up" side)
  function beam(b, A, B, w, h, col, ex) {
    const d = V3.norm(V3.sub(B, A)), up = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const sd = V3.mul(V3.norm(V3.cross(d, up)), w / 2), u2 = V3.mul(V3.norm(V3.cross(sd, d)), h / 2);
    const ring = C => [V3.sub(V3.sub(C, sd), u2), V3.sub(V3.add(C, sd), u2), V3.add(V3.add(C, sd), u2), V3.add(V3.sub(C, sd), u2)];
    return hexa(b, [...ring(A), ...ring(B)], col, ex);
  }
  // wall-like frame on a curved/polygonal surface: point at (cx, cz), outward normal (nx, nz)
  const faceAt = (cx, cz, nx, nz) => (u, y, o) => [cx - nz * u + nx * o, y, cz + nx * u + nz * o];

  // ── windmills: hub at HUB, rotor axis AXIS (tilted up), sails on local +Z ──
  function sails(b, far) {
    const e1 = [1, 0, 0], e2 = [0, Math.cos(TILT), -Math.sin(TILT)];
    const fr = (d, p, u, v, w) => [HUB[0] + d[0] * u + p[0] * v + AXIS[0] * w, HUB[1] + d[1] * u + p[1] * v + AXIS[1] * w, HUB[2] + d[2] * u + p[2] * v + AXIS[2] * w];
    for (let k = 0; k < 4; k++) {
      const th = k * Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
      const d = [c * e2[0] + s * e1[0], c * e2[1] + s * e1[1], c * e2[2] + s * e1[2]], p = [-s * e2[0] + c * e1[0], -s * e2[1] + c * e1[1], -s * e2[2] + c * e1[2]];
      const piece = (u0, u1, v0, v1, w0, w1, col) => hexa(b, [fr(d, p, u0, v0, w0), fr(d, p, u1, v0, w0), fr(d, p, u1, v1, w0), fr(d, p, u0, v1, w0),
        fr(d, p, u0, v0, w1), fr(d, p, u1, v0, w1), fr(d, p, u1, v1, w1), fr(d, p, u0, v1, w1)], col, EX(0.92, 1));
      if (far) { piece(0.2, 7.1, -0.3, 1.9, 0.2, 0.3, [0.6, 0.52, 0.42]); continue; }
      piece(-0.45, 7.25, -0.17, 0.17, 0.12, 0.44, COL.timber);
      piece(1.1, 7.05, 1.76, 1.92, 0.2, 0.32, COL.timberL);
      for (let q = 0; q <= 10; q++) { const u = 1.15 + q * 0.585; piece(u - 0.045, u + 0.045, 0.12, 1.9, 0.22, 0.3, COL.timberL); }
      for (const v of [0.72, 1.28]) piece(1.1, 7.05, v - 0.035, v + 0.035, 0.26, 0.32, COL.timberL);
      piece(1.1, 7.05, -0.62, -0.17, 0.2, 0.24, COL.timberL);
      if (k % 2 === 0) piece(1.25, 5.9, 0.18, 1.74, 0.235, 0.255, COL.canvas);
      if (k === 0) piece(-0.5, 0.5, -0.5, 0.5, -0.3, 0.6, COL.timber);
    }
  }
  function millCap(b) {
    const m = lathe(b, [[2.55, 10.45], [2.62, 10.8], [2.5, 11.4], [2.1, 12.4], [1.4, 13.15], [0.55, 13.6], [0.01, 13.72]], 14, COL.roof,
      p => EX(p[1] < 10.9 ? 0.6 : 0.84 + 0.16 * ss(11, 13.7, p[1]), 2));
    b.scale(m, 1, 1, 1.28);
    lathe(b, [[2.45, 10.25], [2.64, 10.25], [2.64, 10.5], [2.45, 10.5]], 14, COL.timber, EX(0.7));
    beam(b, V3.sub(HUB, V3.mul(AXIS, 2.4)), HUB, 0.42, 0.42, COL.timber, EX(0.8));
    beam(b, [0, 10.7, -3.0], [0, 1.5, -7.3], 0.24, 0.24, COL.timber, EX(0.8));
    beam(b, [-0.9, 10.6, -2.9], [0, 5.6, -5.2], 0.14, 0.14, COL.timber, EX(0.8));
    beam(b, [0.9, 10.6, -2.9], [0, 5.6, -5.2], 0.14, 0.14, COL.timber, EX(0.8));
  }
  function towerMill(b) { // round whitewashed stone tower
    lathe(b, [[3.55, -3.2], [3.55, 0.35], [3.3, 0.55]], 16, COL.stoneD, p => EX(p[1] < -1 ? 0.55 : 0.78, p[1] < -1 ? 4 : 0));
    lathe(b, [[3.2, 0.5], [3.1, 2.0], [2.9, 5.0], [2.65, 8.0], [2.45, 10.3]], 18, COL.white,
      p => EX(Math.min(0.64 + 0.36 * ss(0.5, 2.4, p[1]), 1 - 0.25 * ss(9.3, 10.4, p[1])), 3));
    lathe(b, [[2.5, 9.85], [2.6, 9.85], [2.6, 10.3], [2.5, 10.3]], 18, COL.stone, EX(0.8));
    doorAt(b, faceAt(0, -3.12, 0, -1), 0, 1.0, 1.9, { doorCol: [0.38, 0.26, 0.17] });
    const wo = { frameCol: COL.timberL };
    for (const [a, y] of [[0, 4.2], [Math.PI, 4.2], [0.5 * Math.PI, 7.3], [Math.PI * 1.5, 6.0], [Math.PI * 0.25, 8.4]]) {
      const r = 3.2 - (y - 0.5) * 0.077 + 0.02, nx = Math.sin(a), nz = -Math.cos(a);
      windowAt(b, faceAt(nx * r, nz * r, nx, nz), 0, y, 0.62, 0.8, wo);
    }
    millCap(b); sails(b, false);
  }
  const lathe8 = (b, prof, col, ex) => { const m = b.lathe(prof, { sides: 8, color: (u, v, p) => cf(col, p), ex: ex ? (u, v, p) => cf(ex, p) : null }); b.rotate(m, 'y', Math.PI / 8); b.facet(m); };
  function smockMill(b) { // octagonal weatherboarded smock on a brick base with a reefing stage
    lathe8(b, [[3.55, -3.2], [3.55, 0.35], [3.45, 0.5], [3.35, 2.9]], p => mulc(COL.brick, 0.9 + 0.2 * hp(p, 1.2, 2)), p => EX(p[1] < -1 ? 0.55 : 0.7 + 0.3 * ss(0.3, 2.5, p[1]), p[1] < -1 ? 4 : 0));
    lathe8(b, [[3.2, 2.84], [4.55, 2.84], [4.55, 3.06], [3.2, 3.06]], COL.timberL, (p) => EX(p[1] < 2.9 ? 0.55 : 0.9));
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * TAU + Math.PI / 8, x = Math.cos(a) * 4.42, z = Math.sin(a) * 4.42;
      boxr(b, x - 0.06, x + 0.06, 3.06, 4.0, z - 0.06, z + 0.06, COL.timber, EX(0.85));
    }
    lathe8(b, [[4.36, 3.93], [4.5, 3.93], [4.5, 4.03], [4.36, 4.03]], COL.timber, EX(0.85));
    const prof = [], rr = y => 3.15 - (y - 2.9) * 0.098;
    for (let k = 0; k < 12; k++) { const y0 = 2.9 + k * 0.62, y1 = y0 + 0.62; prof.push([rr(y0) + 0.07, y0 + 0.001], [rr(y1) + 0.005, y1]); }
    lathe8(b, prof, p => mulc([0.44, 0.33, 0.24], 0.92 + 0.12 * hp(p, 0.7, 4)), p => EX(Math.min(0.72 + 0.28 * ss(3.0, 4.5, p[1]), 1 - 0.28 * ss(9.2, 10.4, p[1]))));
    const ap = c => c * Math.cos(Math.PI / 8);
    doorAt(b, faceAt(0, -ap(3.45), 0, -1), 0, 0.95, 1.85, { doorCol: [0.3, 0.4, 0.46] });
    const wo = { frameCol: COL.cream };
    windowAt(b, faceAt(0, -ap(rr(3.1)) - 0.02, 0, -1), 0, 3.12, 0.9, 1.7, { frameCol: COL.cream });
    for (const [nx, nz, y] of [[1, 0, 5.6], [-1, 0, 5.6], [0, 1, 7.8], [1, 0, 8.6], [-1, 0, 8.2]]) {
      const r = ap(rr(y)) + 0.06;
      windowAt(b, faceAt(nx * r, nz * r, nx, nz), 0, y, 0.6, 0.75, wo);
    }
    millCap(b); sails(b, false);
  }
  function farMill(b, smock) {
    const m = lathe(b, [[3.4, -3], [3.2, 0.5], [2.45, 10.4]], 6, smock ? [0.44, 0.33, 0.24] : COL.white, p => EX(p[1] < -1 ? 0.6 : 0.9, p[1] < -1 ? 4 : smock ? 0 : 3));
    const c = lathe(b, [[2.6, 10.4], [2.3, 12.2], [0.9, 13.4], [0.01, 13.7]], 6, COL.roof, EX(0.9, 2));
    b.scale(c, 1, 1, 1.28);
    sails(b, true);
  }

  // ── lighthouse with keeper's cottage (tower at origin, cottage on local -X) ──
  function lighthouse(b) {
    lathe(b, [[4.6, -4], [4.6, 0.9], [4.25, 1.25]], 10, COL.stoneD, p => EX(p[1] < -1 ? 0.55 : 0.8, p[1] < -1 ? 4 : 0), true);
    const r = y => 3.5 - (y - 1.2) * 0.064 + 0.25 * Math.sin((y - 1.2) / 17.8 * Math.PI) * 0.4;
    for (const [y0, y1, c] of [[1.2, 7, COL.white], [7, 9, COL.red], [9, 13.5, COL.white], [13.5, 15.5, COL.red], [15.5, 19, COL.white]]) {
      const ym = (y0 + y1) / 2;
      lathe(b, [[r(y0), y0], [r(ym), ym], [r(y1), y1]], 18, c, p => EX(Math.min(0.66 + 0.34 * ss(1.2, 3.5, p[1]), 1 - 0.2 * ss(17.5, 19, p[1]))));
    }
    lathe(b, [[r(18.4), 18.4], [3.3, 19.0], [3.36, 19.38], [2.1, 19.38]], 18, COL.stone, p => EX(p[1] < 19.1 ? 0.62 : 0.9));
    for (let k = 0; k < 18; k++) { const a = k / 18 * TAU, x = Math.cos(a) * 3.2, z = Math.sin(a) * 3.2; boxr(b, x - 0.04, x + 0.04, 19.38, 20.3, z - 0.04, z + 0.04, [0.22, 0.24, 0.26], EX(0.9)); }
    lathe(b, [[3.14, 20.26], [3.28, 20.26], [3.28, 20.36], [3.14, 20.36]], 18, [0.22, 0.24, 0.26], EX(0.9));
    lathe(b, [[1.78, 19.38], [1.78, 19.98]], 10, COL.white, EX(0.85), true);
    lathe(b, [[1.62, 19.98], [1.62, 22.0]], 10, [0.5, 0.52, 0.5], EX(0.9, 0, 1.4), true);
    for (let k = 0; k < 10; k++) { const a = (k + 0.5) / 10 * TAU, x = Math.cos(a) * 1.64, z = Math.sin(a) * 1.64; boxr(b, x - 0.05, x + 0.05, 19.98, 22.0, z - 0.05, z + 0.05, [0.2, 0.22, 0.24], EX(0.9)); }
    lathe(b, [[2.0, 21.95], [1.9, 22.3], [1.25, 23.2], [0.4, 23.95], [0.02, 24.15]], 10, COL.copper, p => EX(p[1] < 22.2 ? 0.6 : 0.95), true);
    lathe(b, [[0.01, 24.05], [0.22, 24.3], [0.01, 24.55], [0.03, 25.2]], 6, [0.25, 0.26, 0.26], EX(0.9));
    doorAt(b, faceAt(0, r(1.5) + 0.02, 0, 1), 0, 1.05, 2.0, { doorCol: [0.28, 0.4, 0.5] });
    for (const [a, y] of [[0.8, 5.2], [-0.9, 10.5], [2.4, 12.2], [0.2, 16.4], [-2.2, 6.4]]) {
      const rr = r(y) + 0.02, nx = Math.sin(a), nz = Math.cos(a);
      windowAt(b, faceAt(nx * rr, nz * rr, nx, nz), 0, y, 0.55, 0.85, { frameCol: COL.timberL });
    }
    // keeper's cottage
    const t = new MESH.Builder(), W = 6.4, D = 4.6, H = 2.7, pitch = 0.82;
    body(t, W, D, H, { wall: COL.white, part: 3, rows: [0.36, 1.1, 2.0, H], gable: true, pitch });
    const F0 = face(W, D, 0), F1 = face(W, D, 1), F3 = face(W, D, 3), wo = { frameCol: COL.cream, shutter: COL.shutB };
    windowAt(t, F0, -1.7, 1.0, 0.9, 1.0, wo); doorAt(t, F0, 1.0, 0.95, 1.9, { doorCol: [0.28, 0.4, 0.5] }); windowAt(t, F1, 0.5, 1.0, 0.9, 1.0, wo);
    windowAt(t, F3, 0, 1.0, 0.9, 1.0, wo);
    porchHood(t, F0, 1.0, 1.7);
    const ridge = gableRoof(t, -W / 2, W / 2, 0, D, H, pitch, 0.45, 0.35, COL.roof);
    chimney(t, -W / 2 + 0.55, 0, H, ridge + 0.8, COL.stone);
    b.append(t, p => [p[0] - 7.7, p[1], p[2] + 0.6]);
  }
  function farLighthouse(b) {
    const r = y => 3.5 - (y - 1.2) * 0.064 + 0.1;
    let m;
    for (const [y0, y1, c] of [[-3, 7, COL.white], [7, 9, COL.red], [9, 13.5, COL.white], [13.5, 15.5, COL.red], [15.5, 19.4, COL.white]]) {
      m = lathe(b, [[y0 < 0 ? 4.0 : r(y0), y0], [y1 > 19 ? 3.3 : r(y1), y1]], 6, c, p => EX(p[1] < -1 ? 0.6 : 0.92, p[1] < -1 ? 4 : 0));
    }
    lathe(b, [[1.7, 19.4], [1.7, 22]], 6, [0.55, 0.55, 0.5], EX(0.9, 0, 1.4));
    lathe(b, [[2.0, 22], [0.02, 24.2]], 6, COL.copper, EX(0.95));
    boxr(b, -10.9, -4.5, -3, 2.7, -1.7, 2.9, COL.white, p => EX(p[1] < -1 ? 0.6 : 0.9, p[1] < -1 ? 4 : 3));
    hexa(b, [[-11.3, 2.35, -2.1], [-4.1, 2.35, -2.1], [-4.1, 2.35, 3.3], [-11.3, 2.35, 3.3], [-11.3, 5.0, 0.58], [-4.1, 5.0, 0.58], [-4.1, 5.0, 0.62], [-11.3, 5.0, 0.62]], COL.roof, EX(0.9, 2));
    return m;
  }
  // ── ruins ──
  const ruinCol = seed => {
    const c = mixc(mulc(COL.ruin, 0.84 + 0.26 * hash2(seed, 77)), [0.7, 0.66, 0.6], 0.3 * hash2(seed, 91));
    return (p, n) => (n && n[1] > 0.55 ? mixc(c, COL.moss, 0.45 + 0.4 * hp(p, 0.9, seed)) : c);
  };
  const ruinEx = (p, n) => EX(n[1] < -0.5 ? 0.6 : 0.7 + 0.3 * ss(-0.5, 5, p[1]), p[1] < -2 ? 4 : 0);
  // masonry pier from x0..x1 (depth ±hd): foundation, moulded base, irregular courses up to yTop, optional impost
  function pier(b, x0, x1, hd, yTop, seed, impost, jag) {
    boxr(b, x0 - 0.3, x1 + 0.3, -6, -0.2, -hd - 0.3, hd + 0.3, ruinCol(seed), ruinEx);
    tbox(b, x0 - 0.3, x1 + 0.3, -0.2, 0.9, -hd - 0.3, hd + 0.3, 0.14, ruinCol(seed + 1), ruinEx);
    let y = 0.9, k = 0;
    const end = impost ? yTop - 0.55 : yTop;
    while (y < end - 0.05) {
      let y1 = Math.min(y + 0.95 + 0.3 * hash2(k, seed), end);
      if (end - y1 < 0.4) y1 = end;
      const j = (hash2(k, seed + 3) - 0.5) * 0.14, last = y1 >= end && jag;
      const P = [[x0 + j, y, -hd + j], [x1 + j, y, -hd + j], [x1 + j, y, hd + j], [x0 + j, y, hd + j]];
      const T = P.map((p, q) => [p[0], y1 + (last ? (hash2(q, seed + k) - 0.6) * 1.6 : 0), p[2]]);
      hexa(b, [...P, ...T], ruinCol(seed + 10 + k), ruinEx);
      y = y1; k++;
    }
    if (impost) tbox(b, x0 - 0.05, x1 + 0.05, yTop - 0.55, yTop, -hd - 0.05, hd + 0.05, -0.22, ruinCol(seed + 5), ruinEx);
  }
  function voussoirs(b, cx, Hp, R, T, hd, a0, a1, N, seed) {
    for (let k = 0; k < N; k++) {
      const aa = Math.PI * (1 - k / N), ab = Math.PI * (1 - (k + 1) / N), am = (aa + ab) / 2;
      if (am > a0 || am < a1) continue;
      const key = k === (N - 1) / 2, g = 0.007;
      const ro = R + T + (key ? 0.5 : 0) + (hash2(k, seed) - 0.5) * 0.3, ri = R - (key ? 0.22 : 0), dz = hd + (key ? 0.16 : 0.06);
      const P = [[cx + Math.cos(aa - g) * ri, Hp + Math.sin(aa - g) * ri, -dz], [cx + Math.cos(ab + g) * ri, Hp + Math.sin(ab + g) * ri, -dz],
        [cx + Math.cos(ab + g) * ro, Hp + Math.sin(ab + g) * ro, -dz], [cx + Math.cos(aa - g) * ro, Hp + Math.sin(aa - g) * ro, -dz]];
      hexa(b, [...P, ...P.map(p => [p[0], p[1], dz])], ruinCol(seed + 30 + k), (p, n) => EX(n[1] < -0.3 ? 0.62 : 0.9));
    }
  }
  const arcPts = (cx, cy, r, a0, a1, n) => { const o = []; for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; o.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return o; };
  const inPoly = (poly, x, y) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // extruded masonry infill with a scatter of slightly proud, differently weathered ashlar blocks on both faces
  function slabPoly(b, poly, depth, seed) {
    const m = b.extrude(poly, depth, { color: (n, p) => ruinCol(seed)(p, n), ex: (n, p) => ruinEx(p, n) });
    let lo = [1e9, 1e9], hi = [-1e9, -1e9];
    for (const [x, y] of poly) { lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
    for (let k = 0, placed = 0; k < 60 && placed < 14; k++) {
      const w = 0.9 + 0.8 * hash2(k, seed + 1), h = 0.45 + 0.25 * hash2(k, seed + 2);
      const x = lo[0] + (hi[0] - lo[0]) * hash2(k, seed + 3), y = lo[1] + (hi[1] - lo[1]) * hash2(k, seed + 4);
      if (!inPoly(poly, x - w / 2 - 0.1, y - h / 2 - 0.1) || !inPoly(poly, x + w / 2 + 0.1, y + h / 2 + 0.1) || !inPoly(poly, x - w / 2 - 0.1, y + h / 2 + 0.1) || !inPoly(poly, x + w / 2 + 0.1, y - h / 2 - 0.1)) continue;
      const s = k % 2 ? 1 : -1, z = s * depth / 2;
      boxr(b, x - w / 2, x + w / 2, y - h / 2, y + h / 2, Math.min(z, z + s * 0.06), Math.max(z, z + s * 0.06), ruinCol(seed + 50 + k), (p, n) => EX(n[1] < -0.5 ? 0.6 : 0.85));
      placed++;
    }
    return m;
  }
  function rubble(b, pts, seed) { // tumbled blocks that conform to the ground
    for (let k = 0; k < pts.length; k++) {
      const [x, z, l] = pts[k], a = hash2(k, seed) * 3, c = Math.cos(a), s = Math.sin(a), w = 0.55 + 0.3 * hash2(k, seed + 1), h = 0.5 + 0.4 * hash2(k, seed + 2);
      const P = [[-l, -0.3, -w], [l, -0.3, -w], [l, -0.3, w], [-l, -0.3, w]].map(p => [x + p[0] * c - p[2] * s, p[1], z + p[0] * s + p[2] * c]);
      hexa(b, [...P, ...P.map(p => [p[0], h, p[2]])], ruinCol(seed + k), (p, n) => EX(p[1] < 0 ? 0.6 : 0.9, 5));
    }
  }
  const ARCH = { S: 16, Pw: 3.8, Dp: 3.4, Hp: 10.5, R: 8, T: 2.0 };
  ARCH.top = ARCH.Hp + ARCH.R + ARCH.T + 1.2;
  function archRuin(b, broken) {
    const { S, Pw, Dp, Hp, R, T, top } = ARCH, hd = Dp / 2, X = S / 2 + Pw, sd = broken ? 400 : 300;
    pier(b, -X, -S / 2, hd, Hp, sd, true, false);
    if (broken) pier(b, S / 2, X, hd, Hp * 0.52, sd + 40, false, true);
    else pier(b, S / 2, X, hd, Hp, sd + 40, true, false);
    voussoirs(b, 0, Hp, R, T, hd, Math.PI + 0.1, broken ? Math.PI * 0.43 : -0.1, 15, sd + 80);
    const RT = R + T;
    if (!broken) {
      for (const s of [-1, 1]) {
        const poly = [[-X, Hp], [-RT, Hp], ...arcPts(0, Hp, RT, Math.PI, Math.PI / 2, 8).slice(1), [0, top], [-X, top]];
        const m = slabPoly(b, s < 0 ? poly : poly.map(p => [-p[0], p[1]]).reverse(), Dp - 0.3, sd + 120 + s);
      }
      boxr(b, -X - 0.35, X + 0.35, top, top + 0.7, -hd - 0.25, hd + 0.25, ruinCol(sd + 130), ruinEx);
      for (let k = 0; k < 6; k++) { // weathered attic blocks
        const x0 = -X + k * (2 * X / 6) + 0.2 * hash2(k, 7), h = 0.4 + 1.5 * hash2(k, 8);
        if (hash2(k, 9) < 0.25) continue;
        tbox(b, x0, x0 + 2 * X / 6 - 0.3, top + 0.7, top + 0.7 + h, -hd + 0.1, hd - 0.1, 0.1, ruinCol(sd + 140 + k), ruinEx);
      }
    } else {
      const a1 = Math.PI * 0.43, e = [Math.cos(a1) * RT, Hp + Math.sin(a1) * RT];
      const poly = [[-X, Hp], [-RT, Hp], ...arcPts(0, Hp, RT, Math.PI, a1, 9).slice(1), [e[0] - 0.3, e[1] + 0.6], [0.6, top - 1.0], [-2.4, top - 0.3], [-4.8, top - 1.6], [-7.5, top + 0.3], [-X, top + 0.3]];
      slabPoly(b, poly, Dp - 0.3, sd + 120);
      boxr(b, -X - 0.35, -7.3, top + 0.3, top + 1.0, -hd - 0.25, hd + 0.25, ruinCol(sd + 130), ruinEx);
      rubble(b, [[4.5, 3.8, 0.9], [7.2, -3.5, 1.1], [10.5, 4.2, 0.8], [3.2, -4.6, 0.7], [12.8, -2.4, 1.0]], sd + 200);
    }
  }
  function farArch(b, broken) {
    const { S, Pw, Dp, Hp, R, T, top } = ARCH, X = S / 2 + Pw;
    let poly;
    if (!broken) poly = [[-X, -5], [-S / 2, -5], ...arcPts(0, Hp, R, Math.PI, 0, 8), [S / 2, -5], [X, -5], [X, top + 0.7], [-X, top + 0.7]];
    else {
      poly = [[-X, -5], [-S / 2, -5], ...arcPts(0, Hp, R, Math.PI, Math.PI * 0.43, 5), [Math.cos(Math.PI * 0.43) * (R + T), Hp + Math.sin(Math.PI * 0.43) * (R + T)], [-2.4, top - 0.3], [-7.5, top + 0.3], [-X, top + 0.3]];
      boxr(b, S / 2, X, -5, Hp * 0.52, -Dp / 2, Dp / 2, COL.ruin, p => EX(0.85, p[1] < -2 ? 4 : 0));
    }
    b.extrude(poly, Dp, { color: (n, p) => (n[1] > 0.5 ? mixc(COL.ruin, COL.moss, 0.5) : COL.ruin), ex: (n, p) => EX(n[1] < -0.3 ? 0.65 : 0.88, p[1] < -2 ? 4 : 0) });
  }
  const AQ = { S: 12, Pw: 3.0, Dp: 3.4, Hp: 12, R: 6, T: 1.4 };
  AQ.top = AQ.Hp + AQ.R + AQ.T + 0.8;
  AQ.len = AQ.S + AQ.Pw;
  function aqBay(b, kind, seed) { // 0 bay (pier + arch to the next pier), 1 broken bay, 2 end pier
    const { S, Pw, Dp, Hp, R, T, top } = AQ, hd = Dp / 2, h = Pw / 2, xc = h + S / 2, RT = R + T, L = h + S;
    const aE = Math.acos((L - xc) / RT), yE = Hp + Math.sin(aE) * RT;
    pier(b, -h, h, hd, Hp, seed, true, false);
    const parapet = (x0, x1) => {
      for (const z of [-1, 1]) {
        let x = x0, k = 0;
        while (x < x1 - 0.1) {
          const x2 = Math.min(x + 2 + 2.5 * hash2(k, seed + z), x1), gone = hash2(k, seed + 7 + z) < 0.22;
          if (!gone) boxr(b, x + 0.03, x2 - 0.03, top, top + 0.55 + 0.4 * hash2(k, seed + 9 + z), z > 0 ? hd - 0.55 : -hd, z > 0 ? hd : -hd + 0.55, ruinCol(seed + 60 + k), ruinEx);
          x = x2; k++;
        }
      }
    };
    if (kind === 0) {
      voussoirs(b, xc, Hp, R, T, hd, Math.PI + 0.1, -0.1, 13, seed + 20);
      slabPoly(b, [[-h, Hp], [xc - RT, Hp], ...arcPts(xc, Hp, RT, Math.PI, aE, 9).slice(1), [L, top], [-h, top]], Dp - 0.3, seed + 40);
      boxr(b, -h, L, top - 0.3, top, -hd - 0.15, hd + 0.15, ruinCol(seed + 41), ruinEx);
      parapet(-h, L);
    } else if (kind === 1) {
      const a1 = Math.PI * 0.7;
      voussoirs(b, xc, Hp, R, T, hd, Math.PI + 0.1, a1, 13, seed + 20);
      const e = [xc + Math.cos(a1) * RT, Hp + Math.sin(a1) * RT];
      slabPoly(b, [[-h, Hp], [xc - RT, Hp], ...arcPts(xc, Hp, RT, Math.PI, a1, 5).slice(1), [e[0] + 0.3, e[1] + 1.2], [0.8, top - 1.4], [-h, top - 0.4]], Dp - 0.3, seed + 40);
      rubble(b, [[6, 3.6, 0.9], [8.5, -3.9, 1.1], [10.8, 3.1, 0.7], [5.1, -2.9, 0.8]], seed + 200);
    } else {
      slabPoly(b, [[h, Hp], [h, top], [-h, top], [-h, yE], ...arcPts(-xc, Hp, RT, aE, 0, 4).slice(1)], Dp - 0.3, seed + 40);
      boxr(b, -h, h, top - 0.3, top, -hd - 0.15, hd + 0.15, ruinCol(seed + 41), ruinEx);
      parapet(-h, h);
    }
  }
  function farAq(b, kind) {
    const { S, Pw, Dp, Hp, R, T, top } = AQ, h = Pw / 2, xc = h + S / 2, L = h + S;
    let poly;
    if (kind === 0) poly = [[-h, -5], [h, -5], ...arcPts(xc, Hp, R, Math.PI, 0, 6), [L, top + 0.7], [-h, top + 0.7]];
    else if (kind === 1) poly = [[-h, -5], [h, -5], ...arcPts(xc, Hp, R, Math.PI, Math.PI * 0.7, 3), [xc + Math.cos(Math.PI * 0.7) * (R + T), Hp + Math.sin(Math.PI * 0.7) * (R + T) + 1], [-h, top - 0.4]];
    else poly = [[-h, -5], [h, -5], [h, top + 0.7], [-h, top + 0.7]];
    b.extrude(poly, Dp, { color: (n, p) => (n[1] > 0.5 ? mixc(COL.ruin, COL.moss, 0.5) : COL.ruin), ex: (n, p) => EX(n[1] < -0.3 ? 0.65 : 0.88, p[1] < -2 ? 4 : 0) });
  }
  function columnStand(b) { // broken fluted column on a plinth
    tbox(b, -0.85, 0.85, -2.5, 0.55, -0.85, 0.85, 0.05, ruinCol(3), (p, n) => EX(p[1] < -1 ? 0.6 : 0.85, p[1] < -1 ? 4 : 0));
    lathe(b, [[0.78, 0.55], [0.8, 0.72], [0.66, 0.92]], 16, ruinCol(4), EX(0.85));
    const rows = [], H = 5.2;
    for (const y of [0.92, 2.2, 3.5, 4.6, H]) {
      const r = [];
      for (let k = 0; k < 20; k++) {
        const a = k / 20 * TAU, rad = (k % 2 ? 0.55 : 0.6) * (1 - (y - 0.9) * 0.012);
        r.push([Math.cos(a) * rad, y === H ? H + (hash2(k >> 1, 5) - 0.5) * 1.1 : y, Math.sin(a) * rad]);
      }
      rows.push(r);
    }
    b.rings(rows, { closed: true, color: (u, v, p) => mulc(COL.ruin, 0.9 + 0.12 * hp(p, 1.1, 6)), ex: (u, v, p) => EX(0.7 + 0.3 * ss(0.5, 3, p[1])) });
    b.cap(rows[rows.length - 1], [0, H, 0], { color: mixc(COL.ruin, COL.moss, 0.55), ex: () => EX(0.95) }, false);
  }
  function columnFallen(b) { // drums tumbled along X, plus a capital, conforming to the ground
    for (let d = 0; d < 3; d++) {
      const rows = [];
      for (const y of [0, 1.55]) { const r = []; for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, rad = k % 2 ? 0.52 : 0.57; r.push([Math.cos(a) * rad, y, Math.sin(a) * rad]); } rows.push(r); }
      const m = b.rings(rows, { closed: true, color: mulc(COL.ruin, 0.9 + 0.1 * d), ex: () => EX(0.85, 5) });
      b.cap(rows[0], [0, 0, 0], { color: mulc(COL.ruin, 0.95), ex: () => EX(0.85, 5) }, true);
      b.cap(rows[1], [0, 1.55, 0], { color: mulc(COL.ruin, 0.95), ex: () => EX(0.85, 5) }, false);
      b.rotate(m, 'z', -Math.PI / 2);
      b.rotate(m, 'y', (d - 1) * 0.12);
      b.translate(m, -2.6 + d * 1.7, 0.42, (d - 1) * 0.25);
    }
    hexa(b, [[2.6, -0.3, -0.8], [4.1, -0.3, -0.85], [4.15, -0.3, 0.75], [2.55, -0.3, 0.8], [2.7, 0.75, -0.7], [4.0, 0.72, -0.72], [4.0, 0.74, 0.68], [2.7, 0.76, 0.7]],
      ruinCol(9), (p, n) => EX(p[1] < 0 ? 0.6 : 0.9, 5));
  }
  // ── stones & boulders (faceted, mossy tops) ──
  function rockBlob(b, c, r, seed, jag, seg) {
    return b.ellipsoid(c, r, { seg: seg || 9, stacks: 6,
      disp: d => 1 - jag / 2 + jag * hash2(Math.floor(d[0] * 2.6 + 11 + seed * 3), Math.floor(d[1] * 2.6 + d[2] * 3.1 + 17 + seed)) });
  }
  // facet a range but keep a share (k) of the smooth normal: chunky facets with a soft, painterly terminator
  function softFacet(b, m, k) {
    const tris = b.i.splice(m.i), src = b.v, v0 = b.count;
    for (let t = 0; t < tris.length; t += 3) {
      const P = [tris[t], tris[t + 1], tris[t + 2]].map(id => src.slice(id * STRIDE, id * STRIDE + STRIDE));
      const n = V3.norm(V3.cross(V3.sub(P[1], P[0]), V3.sub(P[2], P[0])));
      const base = b.count;
      for (const row of P) {
        let sx = row[3], sy = row[4], sz = row[5];
        if (sx * n[0] + sy * n[1] + sz * n[2] < 0) { sx = -sx; sy = -sy; sz = -sz; }
        const q = V3.norm([n[0] * (1 - k) + sx * k, n[1] * (1 - k) + sy * k, n[2] * (1 - k) + sz * k]);
        row[3] = q[0]; row[4] = q[1]; row[5] = q[2];
        b.v.push(...row);
      }
      b.tri(base, base + 1, base + 2);
    }
    return { v: v0, i: m.i };
  }
  function rockPaint(b, m, base, mossAmt, conform) {
    const f = softFacet(b, m, 0.45);
    faceColor(b, f, (c, n) => {
      let col = mulc(base, 0.82 + 0.3 * hash2(Math.floor(c[0] * 3.1 + 40), Math.floor(c[1] * 2.7 + c[2] * 3.3 + 40)));
      const lichen = hash2(Math.floor(c[0] * 5.3 + 9), Math.floor(c[1] * 4.1 + c[2] * 5.7 + 9));
      if (lichen > 0.86) col = mixc(col, [0.78, 0.76, 0.56], 0.45);
      const mz = ss(0.35, 0.8, n[1] + (lichen - 0.5) * 0.3) * mossAmt;
      return mixc(col, mulc(COL.moss, 0.9 + 0.25 * lichen), mz);
    });
    const bb = b.bounds(), top = Math.max(0.5, bb.hi[1]);
    b.setEx(f, p => EX(0.68 + 0.32 * ss(-0.1, top * 0.8, p[1]), conform ? 5 : p[1] < 0.08 ? 4 : 0));
  }
  function standingStone(b, kind) { // 0 tall slab, 1 squat, 2 leaning, 3 fallen
    const dims = kind === 1 ? [1.1, 1.45, 0.85] : [1.0, 2.35, 0.55], base = [0.66, 0.64, 0.6], cy = dims[1] * 0.64, yb = cy + dims[1] * 0.5;
    const m = rockBlob(b, [0, cy, 0], dims, kind + 4, 0.26, 8);
    b.xform(m, p => [p[0] * (1.08 - 0.16 * p[1] / (dims[1] * 1.6)), p[1] > yb ? yb + (p[1] - yb) * 0.4 : p[1], p[2]]);
    if (kind === 2) b.rotate(m, 'z', 0.24);
    if (kind === 3) { b.rotate(m, 'x', Math.PI / 2 - 0.05); b.translate(m, 0, 0.18, -dims[1] * 0.64); }
    rockPaint(b, m, base, 0.8, kind === 3);
  }
  function trilithon(b) {
    for (const s of [-1, 1]) {
      const m = rockBlob(b, [s * 1.75, 1.6, 0], [0.95, 2.6, 0.7], s + 10, 0.2, 8);
      b.xform(m, p => [p[0], p[1] < 0 ? p[1] : Math.min(p[1], 4.0), p[2]]);
      rockPaint(b, m, [0.66, 0.64, 0.6], 0.7, false);
    }
    const l = rockBlob(b, [0, 4.35, 0], [3.0, 0.5, 0.75], 13, 0.18, 8);
    rockPaint(b, l, [0.66, 0.63, 0.58], 1.0, false);
  }
  function boulder(b, kind) { // 0 rounded, 1 flat slab, 2 tall crag, 3 split, 4 outcrop cluster
    const base = COL.rock;
    const parts = kind === 0 ? [[[0, 0.42, 0], [1.2, 0.95, 1.0], 0.35]]
      : kind === 1 ? [[[0, 0.16, 0], [1.55, 0.55, 1.1], 0.3]]
      : kind === 2 ? [[[0, 0.85, 0], [0.85, 1.75, 0.8], 0.5]]
      : kind === 3 ? [[[-0.62, 0.5, 0], [0.62, 0.9, 1.0], 0.3], [[0.66, 0.46, 0.05], [0.6, 0.86, 0.95], 0.3]]
      : [[[0, 0.8, 0], [1.55, 1.95, 1.3], 0.34], [[1.7, 0.45, 0.6], [1.2, 1.35, 1.1], 0.36], [[-1.35, 0.25, -0.8], [0.95, 0.85, 0.9], 0.35], [[0.4, 0.12, -1.7], [1.8, 0.5, 1.2], 0.3]];
    parts.forEach(([c, r, jag], k) => {
      const m = rockBlob(b, c, r, kind * 5 + k, jag, kind === 2 ? 7 : 9);
      if (kind === 3) b.rotate(m, 'z', k ? -0.12 : 0.12, c);
      rockPaint(b, m, base, kind === 2 ? 0.6 : 0.85, false);
    });
  }
  // ── walls & fences: 3 m segments along X that conform to the ground ──
  function wallSeg(b) {
    const c = p => mulc(COL.stone, 0.82 + 0.3 * hp(p, 2.2, 1));
    const P = [[-1.56, -0.5, -0.42], [1.56, -0.5, -0.42], [1.56, -0.5, 0.42], [-1.56, -0.5, 0.42]];
    hexa(b, [...P, [-1.56, 0.82, -0.3], [1.56, 0.82, -0.3], [1.56, 0.82, 0.3], [-1.56, 0.82, 0.3]], c, p => EX(p[1] < 0 ? 0.62 : 0.9, 5));
    for (let k = 0; k < 7; k++) { // coping stones on edge
      const x = -1.35 + k * 0.45, t = (hash2(k, 3) - 0.5) * 0.18, h = 0.26 + 0.12 * hash2(k, 4);
      hexa(b, [[x - 0.2, 0.8, -0.28], [x + 0.2, 0.8, -0.28], [x + 0.2, 0.8, 0.28], [x - 0.2, 0.8, 0.28],
        [x - 0.18 + t, 0.8 + h, -0.24], [x + 0.14 + t, 0.8 + h, -0.24], [x + 0.14 + t, 0.8 + h, 0.24], [x - 0.18 + t, 0.8 + h, 0.24]],
        (p, n) => (n[1] > 0.5 ? mixc(COL.stone, COL.moss, 0.55) : mulc(COL.stone, 0.8 + 0.3 * hash2(k, 5))), EX(0.9, 5));
    }
    for (let k = 0; k < 5; k++) { // a few proud stones on the faces
      const x = -1.2 + k * 0.6 + 0.2 * hash2(k, 6), y = 0.05 + 0.55 * hash2(k, 7), s = k % 2 ? 1 : -1, z = s * (0.41 - y * 0.09);
      boxr(b, x - 0.2, x + 0.2, y, y + 0.2, Math.min(z, z + s * 0.05), Math.max(z, z + s * 0.05), mulc(COL.stone, 0.75 + 0.35 * hash2(k, 8)), EX(0.85, 5));
    }
  }
  function fenceSeg(b) {
    const wood = [0.52, 0.44, 0.34];
    for (const x of [-1.5, 1.5]) boxr(b, x - 0.08, x + 0.08, -0.4, 1.15, -0.08, 0.08, wood, p => EX(p[1] < 0.2 ? 0.65 : 0.9, 5));
    beam(b, [-1.55, 0.5, 0.1], [1.55, 0.46, 0.1], 0.1, 0.12, mulc(wood, 1.05), EX(0.9, 5));
    beam(b, [-1.55, 0.92, 0.1], [1.55, 0.95, 0.1], 0.1, 0.12, mulc(wood, 1.05), EX(0.9, 5));
  }
  // ── meshes, instance sets, kinds (a kind = near set [+ far set] + collision shape) ──
  const build = fn => { const b = new MESH.Builder(); fn(b); return b.upload(); };
  const KINDS = [], K = {};
  const BIG = 1e4;
  // prims (local, unscaled): box [x0,x1,y0,y1,z0,z1] · cyl [cx,cz,r,y0,y1] · sph [cx,cy,cz,r]
  // arch [cx,cy,R,x0,x1,ytop,z0,z1] = box above the spring line minus the intrados disc · gable [x0,x1,yb,yt,hz,zc] · rotor
  function kind(name, sets, prims) {
    let rad = 0, top = -BIG;
    for (const p of prims || []) {
      const [t, a] = p;
      if (t === 'box') { rad = Math.max(rad, Math.hypot(Math.max(Math.abs(a[0]), Math.abs(a[1])), Math.max(Math.abs(a[4]), Math.abs(a[5])))); top = Math.max(top, a[3]); }
      else if (t === 'cyl') { rad = Math.max(rad, Math.hypot(a[0], a[1]) + a[2]); top = Math.max(top, a[4]); }
      else if (t === 'sph') { rad = Math.max(rad, Math.hypot(a[0], a[2]) + a[3]); top = Math.max(top, a[1] + a[3]); }
      else if (t === 'arch') { rad = Math.max(rad, Math.hypot(Math.max(Math.abs(a[3]), Math.abs(a[4])), Math.max(Math.abs(a[6]), Math.abs(a[7])))); top = Math.max(top, a[5]); }
      else if (t === 'gable') { rad = Math.max(rad, Math.hypot(Math.max(Math.abs(a[0]), Math.abs(a[1])), Math.abs(a[5]) + a[4])); top = Math.max(top, a[3]); }
      else if (t === 'rotor') { rad = Math.max(rad, Math.hypot(7.6, HUB[2] + 1)); top = Math.max(top, HUB[1] + 7.6); }
    }
    const k = { id: KINDS.length, name, sets, prims: prims && prims.length ? prims : null, rad, top };
    KINDS.push(k); K[name] = k.id;
    return k;
  }
  const t0 = performance.now();
  const MS = {
    cotA: build(cottageA), cotB: build(cottageB), cotC: build(cottageC),
    cotAf: build(b => farHouse(b, 9, 5.6, 3.0, { wall: COL.white, part: 3, pitch: 0.87, chim: -3.9 })),
    cotBf: build(b => farHouse(b, 7.4, 5.0, 2.55, { wall: COL.stone, part: 0, thatch: true })),
    cotCf: build(b => farHouse(b, 8, 6, 5.2, { wall: COL.white, part: 3, pitch: 0.96, chim: -1.6, chimCol: COL.brick, lean: true })),
    millT: build(towerMill), millS: build(smockMill), millTf: build(b => farMill(b, false)), millSf: build(b => farMill(b, true)),
    arch: build(b => archRuin(b, false)), archB: build(b => archRuin(b, true)), archF: build(b => farArch(b, false)), archBF: build(b => farArch(b, true)),
    aq0: build(b => aqBay(b, 0, 500)), aq1: build(b => aqBay(b, 1, 600)), aq2: build(b => aqBay(b, 2, 700)),
    aq0f: build(b => farAq(b, 0)), aq1f: build(b => farAq(b, 1)), aq2f: build(b => farAq(b, 2)),
    light: build(lighthouse), lightF: build(farLighthouse),
    colS: build(columnStand), colF: build(columnFallen),
    st0: build(b => standingStone(b, 0)), st1: build(b => standingStone(b, 1)), st2: build(b => standingStone(b, 2)), st3: build(b => standingStone(b, 3)),
    tri: build(trilithon),
    r0: build(b => boulder(b, 0)), r1: build(b => boulder(b, 1)), r2: build(b => boulder(b, 2)), r3: build(b => boulder(b, 3)), r4: build(b => boulder(b, 4)),
    wall: build(wallSeg), fence: build(fenceSeg),
  };
  const buildMs = performance.now() - t0;
  const S = (name, mesh, o) => makeSet(name, mesh, o);
  const LODH = { near: 0, far: 650, wout: 50 }, LODHF = { near: 650, win: 50, far: 2300, wout: 250 };
  const LODB = { far: 950, wout: 60 }, LODBF = { near: 950, win: 60, far: 2900, wout: 300 };
  const Hr = (D, p) => D / 2 * Math.tan(p);
  kind('cottageA', [S('cotA', MS.cotA, { ...LODH, max: 300 }), S('cotAf', MS.cotAf, { ...LODHF, max: 600 })],
    [['box', [-4.5, 4.5, -BIG, 3.0, -2.8, 2.8]], ['gable', [-4.95, 4.95, 2.4, 3.0 + Hr(5.6, 0.87), 3.3, 0]]]);
  kind('cottageB', [S('cotB', MS.cotB, { ...LODH, max: 300 }), S('cotBf', MS.cotBf, { ...LODHF, max: 600 })],
    [['box', [-3.7, 3.7, -BIG, 2.55, -2.5, 2.5]], ['gable', [-4.3, 4.3, 2.3, 6.6, 3.2, 0]]]);
  kind('cottageC', [S('cotC', MS.cotC, { ...LODH, max: 300 }), S('cotCf', MS.cotCf, { ...LODHF, max: 600 })],
    [['box', [-4, 4, -BIG, 5.2, -3, 3]], ['gable', [-4.4, 4.4, 4.8, 5.2 + Hr(6, 0.96), 3.4, 0]], ['box', [4, 7.3, -BIG, 3.0, -2.9, 1.7]]]);
  const millPrims = [['cyl', [0, 0, 3.3, -BIG, 11]], ['cyl', [0, 0, 2.7, 11, 13.7]], ['rotor']];
  kind('millT', [S('millT', MS.millT, { ...LODB, max: 60, spin: true }), S('millTf', MS.millTf, { ...LODBF, max: 120, spin: true })], millPrims);
  kind('millS', [S('millS', MS.millS, { ...LODB, max: 60, spin: true }), S('millSf', MS.millSf, { ...LODBF, max: 120, spin: true })], [['cyl', [0, 0, 4.5, -BIG, 4.0]], ...millPrims]);
  const A = ARCH, AX = A.S / 2 + A.Pw, ahd = A.Dp / 2;
  kind('arch', [S('arch', MS.arch, { ...LODB, max: 40 }), S('archF', MS.archF, { ...LODBF, max: 80 })],
    [['box', [-AX, -A.S / 2, -BIG, A.Hp, -ahd, ahd]], ['box', [A.S / 2, AX, -BIG, A.Hp, -ahd, ahd]], ['arch', [0, A.Hp, A.R, -AX, AX, A.top + 2.2, -ahd, ahd]]]);
  kind('archB', [S('archB', MS.archB, { ...LODB, max: 40 }), S('archBF', MS.archBF, { ...LODBF, max: 80 })],
    [['box', [-AX, -A.S / 2, -BIG, A.Hp, -ahd, ahd]], ['box', [A.S / 2, AX, -BIG, A.Hp * 0.52 + 0.8, -ahd, ahd]], ['arch', [0, A.Hp, A.R, -AX, 2.6, A.top + 0.8, -ahd, ahd]]]);
  const qh = AQ.Pw / 2, qd = AQ.Dp / 2, qxc = qh + AQ.S / 2;
  kind('aq0', [S('aq0', MS.aq0, { ...LODB, max: 160 }), S('aq0f', MS.aq0f, { ...LODBF, max: 320 })],
    [['box', [-qh, qh, -BIG, AQ.Hp, -qd, qd]], ['arch', [qxc, AQ.Hp, AQ.R, -qh, qh + AQ.S, AQ.top + 0.9, -qd, qd]]]);
  kind('aq1', [S('aq1', MS.aq1, { ...LODB, max: 80 }), S('aq1f', MS.aq1f, { ...LODBF, max: 160 })],
    [['box', [-qh, qh, -BIG, AQ.Hp, -qd, qd]], ['arch', [qxc, AQ.Hp, AQ.R, -qh, 3.2, AQ.top, -qd, qd]]]);
  kind('aq2', [S('aq2', MS.aq2, { ...LODB, max: 60 }), S('aq2f', MS.aq2f, { ...LODBF, max: 120 })], [['box', [-qh, qh, -BIG, AQ.top + 0.9, -qd, qd]]]);
  kind('light', [S('light', MS.light, { far: 1000, wout: 60, max: 16 }), S('lightF', MS.lightF, { near: 1000, win: 60, far: 3300, wout: 300, max: 32 })],
    [['cyl', [0, 0, 3.7, -BIG, 25]], ['box', [-10.9, -4.5, -BIG, 2.7, -1.7, 2.9]], ['gable', [-11.3, -4.1, 2.3, 5.2, 2.8, 0.6]]]);
  kind('colS', [S('colS', MS.colS, { far: 900, wout: 80, max: 240 })], [['cyl', [0, 0, 0.75, -BIG, 5.6]]]);
  kind('colF', [S('colF', MS.colF, { far: 700, wout: 80, max: 160 })], null);
  kind('st0', [S('st0', MS.st0, { far: 1500, wout: 150, max: 400 })], [['cyl', [0, 0, 0.9, -BIG, 3.6]]]);
  kind('st1', [S('st1', MS.st1, { far: 1500, wout: 150, max: 300 })], [['cyl', [0, 0, 1.1, -BIG, 2.3]]]);
  kind('st2', [S('st2', MS.st2, { far: 1500, wout: 150, max: 200 })], [['cyl', [-0.4, 0, 1.0, -BIG, 3.3]]]);
  kind('st3', [S('st3', MS.st3, { far: 1100, wout: 150, max: 200 })], null);
  kind('tri', [S('tri', MS.tri, { far: 1700, wout: 150, max: 60 })], [['cyl', [-1.75, 0, 0.95, -BIG, 4.0]], ['cyl', [1.75, 0, 0.95, -BIG, 4.0]], ['box', [-3.1, 3.1, 3.85, 4.9, -0.8, 0.8]]]);
  kind('r0', [S('r0', MS.r0, { far: 1100, wout: 120, max: 1600 })], [['sph', [0, 0.42, 0, 1.05]]]);
  kind('r1', [S('r1', MS.r1, { far: 1100, wout: 120, max: 1600 })], [['box', [-1.4, 1.4, -BIG, 0.6, -1.0, 1.0]]]);
  kind('r2', [S('r2', MS.r2, { far: 1100, wout: 120, max: 1600 })], [['cyl', [0, 0, 0.75, -BIG, 2.4]]]);
  kind('r3', [S('r3', MS.r3, { far: 1100, wout: 120, max: 1600 })], [['box', [-1.2, 1.2, -BIG, 1.25, -0.95, 0.95]]]);
  kind('r4', [S('r4', MS.r4, { far: 2300, wout: 250, max: 900 })], [['cyl', [0, 0, 1.3, -BIG, 3.1]], ['sph', [1.7, 0.45, 0.6, 1.15]], ['sph', [-1.35, 0.25, -0.8, 0.85]], ['box', [-1.3, 2.1, -BIG, 0.5, -2.8, -0.6]]]);
  kind('wall', [S('wall', MS.wall, { far: 600, wout: 80, max: 5000 })], null);
  kind('fence', [S('fence', MS.fence, { far: 420, wout: 70, max: 3000 })], null);
  // numeric prim codes for the hot collision loop
  const PT = { box: 0, cyl: 1, sph: 2, arch: 3, gable: 4, rotor: 5 };
  for (const k of KINDS) if (k.prims) k.prims = k.prims.map(p => ({ t: PT[p[0]], a: p[1] || null }));

  // ── placement (deterministic per cell) ──
  const N3 = [0, 0, 0];
  const H = (x, z) => terrainH(x, z, 1);
  const L2W = (x, z, a, s, lx, lz) => { const c = Math.cos(a), n = Math.sin(a); return [x + (lx * c + lz * n) * s, z + (-lx * n + lz * c) * s]; };
  function footprint(x, z, a, s, r) {
    let lo = 1e9, hi = -1e9;
    for (const [lx, lz] of [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]], [(r[0] + r[1]) / 2, (r[2] + r[3]) / 2]]) {
      const [wx, wz] = L2W(x, z, a, s, lx, lz), h = H(wx, wz);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return [lo, hi];
  }
  function blocked(x, z, foot, pad) {
    for (const f of foot) {
      const dx = x - f.x, dz = z - f.z, c = Math.cos(f.a), n = Math.sin(f.a);
      const lx = (dx * c - dz * n) / f.s, lz = (dx * n + dz * c) / f.s, r = f.rect;
      if (lx > r[0] - pad && lx < r[1] + pad && lz > r[2] - pad && lz < r[3] + pad) return true;
    }
    return false;
  }
  function add(cell, kn, x, y, z, s, a, tint, seed, ph) { cell.it.push(K[kn], x, y, z, s, a, tint, seed, ph || 0); }
  // walls/fences along a polyline, 3 m segments stretched to fit, skipping footprints, water, steep ground and forest
  function polyline(cell, pts, kn, foot, r, flat) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [x0, z0] = pts[k], [x1, z1] = pts[k + 1], len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5) continue;
      const n = Math.max(1, Math.round(len / 3)), ux = (x1 - x0) / len, uz = (z1 - z0) / len, a = Math.atan2(-uz, ux), s = len / n / 3.05;
      let hp0 = null;
      for (let q = 0; q < n; q++) {
        const mx = x0 + ux * (q + 0.5) * len / n, mz = z0 + uz * (q + 0.5) * len / n;
        if (blocked(mx, mz, foot, 0.8)) { hp0 = null; continue; }
        if (flat) { add(cell, kn, mx, 0, mz, s, a, r(), r(), 0); continue; }
        const h = H(mx, mz), steep = hp0 !== null && Math.abs(h - hp0) > len / n * 0.6;
        hp0 = h;
        if (h < 0.6 || steep || forestMask(mx, mz) > 0.62) continue;
        add(cell, kn, mx, h, mz, s, a, r(), r(), 0);
      }
    }
  }
  const RECT = { cottageA: [-4.9, 4.9, -3.2, 4.9], cottageB: [-4.4, 4.4, -3.2, 3.8], cottageC: [-4.4, 7.4, -3.5, 5.0] };
  const heading = (dx, dz) => Math.atan2(dx, -dz); // FLIGHT.setHeading yaw for a world direction

  // villages: gentle lowland valleys (10–150 m, flat), 4–10 cottages along a curving lane, 1–2 windmills, walls & fences
  const VC = 1400;
  function villageSite(i, j) {
    const r = rng(i, j, 101);
    if (r() > 0.72) return null;
    for (let t = 0; t < 8; t++) {
      const x = (i + 0.2 + 0.6 * r()) * VC, z = (j + 0.2 + 0.6 * r()) * VC, h = H(x, z);
      if (h < 10 || h > 150 || forestMask(x, z) > 0.4) continue;
      terrainN(x, z, N3); if (N3[1] < 0.965) continue;
      let ok = true;
      for (let k = 0; k < 6 && ok; k++) { const a = k * TAU / 6, hh = H(x + Math.cos(a) * 70, z + Math.sin(a) * 70); if (Math.abs(hh - h) > 9 || hh < 3) ok = false; }
      if (ok) return { x, z, y: h };
    }
    return null;
  }
  function genVillage(i, j, cell, st) {
    const r = rng(i, j, 111);
    const th = r() * Math.PI, dx = Math.cos(th), dz = Math.sin(th), px = -dz, pz = dx, curv = (r() - 0.5) * 0.006;
    const want = 4 + Math.floor(r() * 7), slots = [], foot = [], houses = [];
    for (const t of [-48, -32, -16, 0, 16, 32, 48]) for (const sd of [-1, 1]) slots.push([t, sd, r() + Math.abs(t) * 0.006]);
    slots.sort((a, b) => a[2] - b[2]);
    for (const [t, sd] of slots) {
      if (houses.length >= want) break;
      const tt = t + (r() - 0.5) * 6, off = sd * (10 + r() * 3.5) + curv * tt * tt;
      const x = st.x + dx * tt + px * off, z = st.z + dz * tt + pz * off;
      const v = r(), kn = v < 0.4 ? 'cottageA' : v < 0.7 ? 'cottageB' : 'cottageC', rect = RECT[kn];
      const a = Math.atan2(-sd * px, -sd * pz) + (r() - 0.5) * 0.3, s = 0.92 + r() * 0.16, tint = r(), seed = r();
      if (forestMask(x, z) > 0.5 || blocked(x, z, foot, 1.5)) continue;
      const [lo, hi] = footprint(x, z, a, s, rect);
      if (lo < 1.2 || hi - lo > 2.6) continue;
      add(cell, kn, x, hi - 0.15, z, s, a, tint, seed);
      const f = { x, z, a, s, rect };
      foot.push(f); houses.push(f);
    }
    if (!houses.length) return;
    const mills = [];
    const nm = 1 + (r() < 0.45 ? 1 : 0);
    for (let m = 0; m < nm; m++) {
      let best = null;
      for (let t = 0; t < 12; t++) {
        const ang = r() * TAU, d = 55 + r() * 60, x = st.x + Math.cos(ang) * d, z = st.z + Math.sin(ang) * d, h = H(x, z);
        if (h < 2 || forestMask(x, z) > 0.45 || blocked(x, z, foot, 9)) continue;
        if (mills.some(q => Math.hypot(q.x - x, q.z - z) < 45)) continue;
        terrainN(x, z, N3); if (N3[1] < 0.93) continue;
        if (!best || h > best.h) best = { x, z, h };
      }
      if (!best) continue;
      const a = WIND_YAW + (r() - 0.5) * 0.1, s = 0.95 + r() * 0.2, kn = r() < 0.5 ? 'millT' : 'millS';
      const [lo, hi] = footprint(best.x, best.z, a, s, [-3.6, 3.6, -3.6, 3.6]);
      if (hi - lo > 3.2) continue;
      best.y = hi - 0.2; best.type = kn; best.yaw = a;
      add(cell, kn, best.x, best.y, best.z, s, a, r(), r(), r() * TAU);
      mills.push(best); foot.push({ x: best.x, z: best.z, a, s, rect: [-4.8, 4.8, -8, 5.8] });
    }
    for (const f of houses) { // gardens behind the cottages
      if (r() > 0.65) continue;
      const gw = f.rect[1] * 0.8 + 1, gd = 6 + r() * 6, kn = r() < 0.4 ? 'fence' : 'wall', z0 = f.rect[2] - 0.2;
      const loc = [[-gw, z0], [-gw, z0 - gd], [gw, z0 - gd], [gw, z0]];
      polyline(cell, loc.map(p => L2W(f.x, f.z, f.a, f.s, p[0], p[1])), kn, foot.filter(q => q !== f), r);
    }
    const nf = 2 + Math.floor(r() * 3);
    for (let q = 0; q < nf; q++) { // field boundaries wandering out from the village
      const ang = r() * TAU, d0 = 40 + r() * 30;
      let x = st.x + Math.cos(ang) * d0, z = st.z + Math.sin(ang) * d0, hd = ang + (r() - 0.5) * 1.4;
      const len = 60 + r() * 130, pts = [[x, z]];
      for (let l = 0; l < len; l += 20) { hd += (r() - 0.5) * 0.4; x += Math.cos(hd) * 20; z += Math.sin(hd) * 20; pts.push([x, z]); }
      polyline(cell, pts, r() < 0.72 ? 'wall' : 'fence', foot, r);
    }
    for (let q = 0; q < 5; q++) { // a few field boulders
      const ang = r() * TAU, d = 50 + r() * 90, x = st.x + Math.cos(ang) * d, z = st.z + Math.sin(ang) * d, h = H(x, z), s = 0.5 + r() * 0.7;
      if (h > 1 && !blocked(x, z, foot, 3)) add(cell, 'r' + Math.floor(r() * 4), x, h - 0.2 * s, z, s, r() * TAU, r(), r());
    }
    cell.sites.push({ kind: 'village', x: st.x, y: st.y, z: st.z, houses: houses.length, mills: mills.length });
    for (const m of mills) cell.sites.push({ kind: 'windmill', type: m.type, x: m.x, y: m.y, z: m.z, heading: heading(-Math.sin(m.yaw), -Math.cos(m.yaw)) });
  }

  // ruins on ridges and hilltops: a grand arch, a broken arch, or an aqueduct line; plus columns and rubble
  const RC = 1100;
  function ruinSite(i, j) {
    const r = rng(i, j, 505);
    if (r() > 0.6) return null;
    let best = null;
    for (let t = 0; t < 9; t++) {
      const x = (i + 0.15 + 0.7 * r()) * RC, z = (j + 0.15 + 0.7 * r()) * RC, h = H(x, z);
      if (h < 45 || h > 1000 || forestMask(x, z) > 0.5) continue;
      terrainN(x, z, N3); if (N3[1] < 0.86) continue;
      let avg = 0;
      for (let k = 0; k < 8; k++) { const a = k * TAU / 8; avg += H(x + Math.cos(a) * 170, z + Math.sin(a) * 170) / 8; }
      const prom = h - avg;
      if (prom < 10) continue;
      const sc = prom + N3[1] * 25;
      if (!best || sc > best.sc) best = { x, z, h, sc };
    }
    if (!best) return null;
    let bd = 0, bv = -1e9;
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 12, c = Math.cos(a) * 24, s = Math.sin(a) * 24, v = H(best.x + c, best.z + s) + H(best.x - c, best.z - s);
      if (v > bv) { bv = v; bd = a; }
    }
    const v = r();
    return { type: v < 0.42 ? 'arch' : v < 0.62 ? 'archB' : 'aqueduct', x: best.x, z: best.z, y: best.h, dir: bd };
  }
  function genRuin(i, j, cell, st) {
    const r = rng(i, j, 515);
    const ux = Math.cos(st.dir), uz = Math.sin(st.dir), a = -st.dir, nx = -uz, nz = ux;
    let site;
    if (st.type === 'aqueduct') {
      const s = 1.0 + r() * 0.25, nb = 3 + Math.floor(r() * 4), L = AQ.len * s;
      const x0 = st.x - ux * nb * L / 2, z0 = st.z - uz * nb * L / 2, P = [];
      let top = -1e9;
      for (let k = 0; k <= nb; k++) { const x = x0 + ux * k * L, z = z0 + uz * k * L; P.push([x, z]); top = Math.max(top, H(x, z)); }
      const y = top - 2.5 * s;
      let broken = 0;
      for (let k = 0; k <= nb; k++) {
        let kn = 'aq0';
        if (k === nb) kn = 'aq2';
        else if (k > 0 && k < nb - 1 && broken < 2 && r() < 0.35) { kn = 'aq1'; broken++; }
        add(cell, kn, P[k][0], y, P[k][1], s, a, r(), r());
      }
      const gx = P[0][0] + ux * (AQ.Pw / 2 + AQ.S / 2) * s, gz = P[0][1] + uz * (AQ.Pw / 2 + AQ.S / 2) * s;
      site = { kind: 'aqueduct', x: st.x, y, z: st.z, bays: nb, gate: [gx, Math.max(y, H(gx, gz)) + AQ.Hp * 0.7 * s, gz], heading: heading(nx, nz), span: AQ.S * s };
    } else {
      const s = 0.85 + r() * 0.45, off = (ARCH.S / 2 + ARCH.Pw / 2) * s;
      const hL = H(st.x - ux * off, st.z - uz * off), hR = H(st.x + ux * off, st.z + uz * off), hC = H(st.x, st.z);
      const y = Math.max(hL, hR, hC - 2) - 0.6;
      add(cell, st.type, st.x, y, st.z, s, a, r(), r());
      site = { kind: 'arch', type: st.type, x: st.x, y, z: st.z, gate: [st.x, Math.max(y, hC) + (ARCH.Hp + ARCH.R) * 0.5 * s, st.z], heading: heading(nx, nz), span: ARCH.S * s };
    }
    const side = r() < 0.5 ? 1 : -1, cd = 20 + r() * 8, nc = 2 + Math.floor(r() * 3);
    for (let q = 0; q < nc; q++) { // a colonnade remnant beside the ruin
      const t = (q - (nc - 1) / 2) * 5.5, x = st.x + nx * side * cd + ux * t, z = st.z + nz * side * cd + uz * t, h = H(x, z);
      if (h > 1) add(cell, 'colS', x, h - 0.1, z, 0.55 + r() * 0.6, r() * TAU, r(), r());
    }
    const nf = 2 + Math.floor(r() * 3);
    for (let q = 0; q < nf; q++) {
      const ang = r() * TAU, d = 14 + r() * 22, x = st.x + Math.cos(ang) * d, z = st.z + Math.sin(ang) * d, h = H(x, z);
      if (h > 1) add(cell, 'colF', x, h, z, 0.8 + r() * 0.35, r() * TAU, r(), r());
    }
    const nr = 3 + Math.floor(r() * 4);
    for (let q = 0; q < nr; q++) {
      const ang = r() * TAU, d = 8 + r() * 20, x = st.x + Math.cos(ang) * d, z = st.z + Math.sin(ang) * d, h = H(x, z), s = 0.35 + r() * 0.4;
      if (h > 1) add(cell, r() < 0.5 ? 'r0' : 'r1', x, h - 0.15 * s, z, s, r() * TAU, r(), r());
    }
    cell.sites.push(site);
  }

  // standing-stone circles on plateaus
  const CC = 1300;
  function circleSite(i, j) {
    const r = rng(i, j, 303);
    if (r() > 0.5) return null;
    for (let t = 0; t < 8; t++) {
      const x = (i + 0.2 + 0.6 * r()) * CC, z = (j + 0.2 + 0.6 * r()) * CC, h = H(x, z);
      if (h < 60 || h > 750 || forestMask(x, z) > 0.4) continue;
      terrainN(x, z, N3); if (N3[1] < 0.972) continue;
      let ok = true, avg = 0;
      for (let k = 0; k < 6 && ok; k++) { const a = k * TAU / 6; if (Math.abs(H(x + Math.cos(a) * 30, z + Math.sin(a) * 30) - h) > 3.5) ok = false; }
      if (!ok) continue;
      for (let k = 0; k < 6; k++) { const a = k * TAU / 6 + 0.3; avg += H(x + Math.cos(a) * 320, z + Math.sin(a) * 320) / 6; }
      if (avg > h - 3) continue;
      return { x, z, y: h };
    }
    return null;
  }
  function genCircle(i, j, cell, st) {
    const r = rng(i, j, 313);
    const n = 9 + Math.floor(r() * 6), Rc = 9 + r() * 6, rot0 = r() * TAU, hasTri = r() < 0.5, triK = Math.floor(r() * n);
    for (let k = 0; k < n; k++) {
      const gone = r() < 0.12;
      const ang = rot0 + k / n * TAU + (r() - 0.5) * 0.12, rr = Rc * (0.96 + r() * 0.08);
      const x = st.x + Math.cos(ang) * rr, z = st.z + Math.sin(ang) * rr, a = Math.atan2(Math.cos(ang), Math.sin(ang)) + (r() - 0.5) * 0.25;
      let kn;
      if (hasTri && k === triK) kn = 'tri';
      else { const v = r(); kn = v < 0.12 ? 'st3' : v < 0.26 ? 'st2' : v < 0.52 ? 'st1' : 'st0'; }
      const s = kn === 'tri' ? 1.0 + r() * 0.2 : 0.8 + r() * 0.5;
      if (gone && kn !== 'tri') continue;
      add(cell, kn, x, H(x, z) - 0.25, z, s, a, r(), r());
    }
    if (r() < 0.6) add(cell, 'st3', st.x, H(st.x, st.z) - 0.1, st.z, 1.1, r() * TAU, r(), r());
    if (r() < 0.5) { const ang = r() * TAU, x = st.x + Math.cos(ang) * Rc * 2.3, z = st.z + Math.sin(ang) * Rc * 2.3; add(cell, 'st0', x, H(x, z) - 0.25, z, 1.2, r() * TAU, r(), r()); }
    cell.sites.push({ kind: 'circle', x: st.x, y: st.y, z: st.z, radius: Rc, stones: n });
  }

  // lighthouses on coastal headlands: land 5–40 m with open water within ~150 m
  const LC = 2000;
  function lightSite(i, j) {
    const r = rng(i, j, 404);
    if (r() > 0.85) return null;
    let best = null;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
      const x = (i + (a + 0.2 + 0.6 * r()) / 6) * LC, z = (j + (b + 0.2 + 0.6 * r()) / 6) * LC, h = H(x, z);
      if (h < 5 || h > 40) continue;
      let wat = 0, sx = 0, sz = 0, near = 0;
      for (let k = 0; k < 8; k++) { const q = k * TAU / 8, c = Math.cos(q), s = Math.sin(q); if (H(x + c * 140, z + s * 140) < -0.5) { wat++; sx += c; sz += s; } }
      if (wat < 2) continue;
      for (let k = 0; k < 8; k++) { const q = k * TAU / 8 + 0.2; if (H(x + Math.cos(q) * 75, z + Math.sin(q) * 75) < 0) near++; }
      if (near < 1) continue;
      terrainN(x, z, N3); if (N3[1] < 0.8 || forestMask(x, z) > 0.5) continue;
      const sc = wat + near * 0.6 + h * 0.05 + N3[1];
      if (!best || sc > best.sc) best = { x, z, y: h, sc, sx, sz };
    }
    return best;
  }
  function genLight(i, j, cell, st) {
    const r = rng(i, j, 414);
    let bestA = 0, bestE = 1e9;
    for (let k = 0; k < 8; k++) { // keeper's cottage (local -X) on land at a similar height; door side away from the sea
      const a = k * TAU / 8, [cx, cz] = L2W(st.x, st.z, a, 1, -7.7, 0.6), hc = H(cx, cz);
      if (hc < 1) continue;
      const e = Math.abs(hc - st.y) + (Math.sin(a) * st.sx + Math.cos(a) * st.sz > 0 ? 1.5 : 0);
      if (e < bestE) { bestE = e; bestA = a; }
    }
    const [, hi] = footprint(st.x, st.z, bestA, 1, [-3.5, 3.5, -3.5, 3.5]);
    const y = hi - 0.3;
    add(cell, 'light', st.x, y, st.z, 1, bestA, r(), r());
    const foot = [{ x: st.x, z: st.z, a: bestA, s: 1, rect: [-11.5, 4.8, -4.8, 4.8] }], pts = [];
    for (let k = 0; k <= 20; k++) { const q = k / 20 * TAU; pts.push([st.x + Math.cos(q) * 16, st.z + Math.sin(q) * 16]); }
    polyline(cell, pts, 'wall', foot, r);
    for (let q = 0; q < 6; q++) {
      const ang = r() * TAU, d = 25 + r() * 60, x = st.x + Math.cos(ang) * d, z = st.z + Math.sin(ang) * d, h = H(x, z), s = 0.6 + r() * 1.2;
      if (h > -1.5) add(cell, r() < 0.3 ? 'r4' : 'r' + Math.floor(r() * 4), x, h - 0.25 * s, z, s * (h < 1 ? 1.3 : 1), r() * TAU, r(), r());
    }
    cell.sites.push({ kind: 'lighthouse', x: st.x, y, z: st.z });
  }

  // boulders and outcrops scattered on slopes and meadows (fine in forests too)
  const BT = 200;
  function genRocks(i, j, cell) {
    const r = rng(i, j, 707);
    for (let k = 0; k < 4; k++) {
      const x = (i + r()) * BT, z = (j + r()) * BT, roll = r(), h = H(x, z);
      if (h < 1.0) continue;
      terrainN(x, z, N3);
      const slope = 1 - N3[1];
      if (N3[1] < 0.62 || roll > 0.08 + slope * 2.2 + (h > 300 ? 0.08 : 0)) continue;
      const big = slope > 0.1 && r() < 0.32;
      const s = big ? 1.0 + r() * 1.5 : 0.5 + r() * r() * 2.4;
      add(cell, big ? 'r4' : 'r' + Math.floor(r() * 4), x, h - (big ? 0.35 : 0.22) * s, z, s, r() * TAU, r(), r());
      const nc = Math.floor(r() * 3.2);
      for (let c = 0; c < nc; c++) {
        const ang = r() * TAU, d = s * (1.8 + r() * 2.5), x2 = x + Math.cos(ang) * d, z2 = z + Math.sin(ang) * d, h2 = H(x2, z2), s2 = s * (0.25 + r() * 0.35);
        if (h2 > 1) add(cell, 'r' + Math.floor(r() * 4), x2, h2 - 0.2 * s2, z2, s2, r() * TAU, r(), r());
      }
    }
  }
  // ── cell grids, lazy generation, visible-set gathering ──
  const ckey = (i, j) => (i + 32768) * 65536 + (j + 32768);
  const GRIDS = [];
  function grid(name, size, range, siteFn, genFn) {
    const g = { name, size, range, siteFn, genFn, sites: new Map(), cells: new Map(), need: [], i0: 1e9, i1: 0, j0: 0, j1: 0 };
    g.site = (i, j) => {
      if (!siteFn) return true;
      const k = ckey(i, j);
      let s = g.sites.get(k);
      if (s === undefined) { s = siteFn(i, j); g.sites.set(k, s); }
      return s;
    };
    g.cell = (i, j) => {
      const k = ckey(i, j);
      let c = g.cells.get(k);
      if (!c) {
        c = { it: [], sites: [] };
        const st = g.site(i, j);
        if (st) genFn(i, j, c, st);
        g.cells.set(k, c);
        if (c.it.length) newCells = true;
      }
      return c;
    };
    GRIDS.push(g);
    return g;
  }
  let newCells = false;
  grid('village', VC, 2400, villageSite, genVillage);
  grid('ruin', RC, 3000, ruinSite, genRuin);
  grid('circle', CC, 1800, circleSite, genCircle);
  grid('light', LC, 3400, lightSite, genLight);
  grid('rocks', BT, 2350, null, genRocks);
  const GRID = {};
  for (const g of GRIDS) GRID[g.name] = g;

  function schedule(cx, cz) {
    for (const g of GRIDS) {
      const i0 = Math.floor((cx - g.range) / g.size), i1 = Math.floor((cx + g.range) / g.size);
      const j0 = Math.floor((cz - g.range) / g.size), j1 = Math.floor((cz + g.range) / g.size);
      if (i0 === g.i0 && i1 === g.i1 && j0 === g.j0 && j1 === g.j1) continue;
      g.i0 = i0; g.i1 = i1; g.j0 = j0; g.j1 = j1;
      g.need.length = 0;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        if (g.cells.has(ckey(i, j))) continue;
        const dx = Math.max(i * g.size - cx, 0, cx - (i + 1) * g.size), dz = Math.max(j * g.size - cz, 0, cz - (j + 1) * g.size), d = Math.hypot(dx, dz);
        if (d < g.range + 100) g.need.push([i, j, d]);
      }
      g.need.sort((a, b) => b[2] - a[2]);
      // forget cells far outside the window
      if (g.cells.size > 900) for (const [k] of g.cells) {
        const i = Math.floor(k / 65536) - 32768, j = (k % 65536) - 32768;
        if (i < i0 - 3 || i > i1 + 3 || j < j0 - 3 || j > j1 + 3) { g.cells.delete(k); g.sites.delete(k); }
      }
    }
  }
  function generate(budget) {
    const t0 = performance.now();
    let did = true, any = false;
    while (did) {
      did = false;
      for (const g of GRIDS) {
        while (g.need.length) {
          const n = g.need[g.need.length - 1], k = ckey(n[0], n[1]);
          if (g.cells.has(k)) { g.need.pop(); continue; }
          // two slices of work: find the site (terrain search), then lay it out on a later pass/frame
          if (g.siteFn && !g.sites.has(k)) g.site(n[0], n[1]);
          else { g.need.pop(); g.cell(n[0], n[1]); }
          did = any = true;
          break;
        }
        if (performance.now() - t0 > budget) return any;
      }
    }
    return any;
  }
  function gatherList(it, cx, cz) {
    for (let q = 0; q < it.length; q += 9) {
      const k = KINDS[it[q]], dx = it[q + 1] - cx, dz = it[q + 3] - cz, d2 = dx * dx + dz * dz;
      for (let m = 0; m < k.sets.length; m++) { const s = k.sets[m]; if (d2 < s.hi2 && d2 > s.lo2) pushInst(s, it, q); }
    }
  }
  function gather(cx, cz) {
    for (let i = 0; i < SETS.length; i++) SETS[i].n = 0;
    for (const g of GRIDS) {
      const R = g.range + 80;
      const i0 = Math.floor((cx - R) / g.size), i1 = Math.floor((cx + R) / g.size), j0 = Math.floor((cz - R) / g.size), j1 = Math.floor((cz + R) / g.size);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = g.cells.get(ckey(i, j));
        if (c && c.it.length) gatherList(c.it, cx, cz);
      }
    }
  }

  // ── collision: a short list of colliders near the glider, refreshed as it moves ──
  const cols = [];
  let colN = 0;
  function gatherCols(x, z) {
    colN = 0;
    for (const g of GRIDS) {
      const R = 160;
      const i0 = Math.floor((x - R) / g.size), i1 = Math.floor((x + R) / g.size), j0 = Math.floor((z - R) / g.size), j1 = Math.floor((z + R) / g.size);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const it = g.cell(i, j).it;
        for (let q = 0; q < it.length; q += 9) {
          const k = KINDS[it[q]];
          if (!k.prims) continue;
          const dx = it[q + 1] - x, dz = it[q + 3] - z, rr = k.rad * it[q + 4] + 70;
          if (dx * dx + dz * dz > rr * rr) continue;
          let c = cols[colN];
          if (!c) c = cols[colN] = {};
          colN++;
          c.k = k; c.x = it[q + 1]; c.y = it[q + 2]; c.z = it[q + 3]; c.s = it[q + 4];
          c.c = Math.cos(it[q + 5]); c.sn = Math.sin(it[q + 5]); c.seed = it[q + 7]; c.ph = it[q + 8];
          c.r2 = (k.rad * c.s + 1) ** 2; c.top = k.top + 0.5;
        }
      }
    }
  }
  const HALF_PI = Math.PI / 2, CT = Math.cos(TILT), ST = Math.sin(TILT);
  function rotorHit(x, y, z, c) {
    const qx = x - HUB[0], qy = y - HUB[1], qz = z - HUB[2];
    const w = qy * AXIS[1] + qz * AXIS[2];
    if (w < -0.3 || w > 0.9) return false;
    const e2 = qy * CT - qz * ST, r = Math.hypot(qx, e2);
    if (r < 0.4 || r > 7.3) return false;
    const ang = env.time * SPIN_RATE * (0.85 + 0.3 * c.seed) + c.ph;
    let psi = (Math.atan2(qx, e2) + ang) % HALF_PI;
    if (psi < 0) psi += HALF_PI;
    let u = r * Math.cos(psi), v = r * Math.sin(psi);
    if (u > 0.3 && u < 7.25 && v > -0.65 && v < 1.95) return true;
    psi -= HALF_PI; u = r * Math.cos(psi); v = r * Math.sin(psi);
    return u > 0.3 && u < 7.25 && v > -0.65 && v < 1.95;
  }
  function primHit(p, x, y, z, c) {
    const a = p.a;
    switch (p.t) {
      case 0: return x > a[0] && x < a[1] && y > a[2] && y < a[3] && z > a[4] && z < a[5];
      case 1: { const dx = x - a[0], dz = z - a[1]; return y > a[3] && y < a[4] && dx * dx + dz * dz < a[2] * a[2]; }
      case 2: { const dx = x - a[0], dy = y - a[1], dz = z - a[2]; return dx * dx + dy * dy + dz * dz < a[3] * a[3]; }
      case 3: {
        if (x < a[3] || x > a[4] || y < a[1] || y > a[5] || z < a[6] || z > a[7]) return false;
        const dx = x - a[0], dy = y - a[1];
        return dx * dx + dy * dy > a[2] * a[2];
      }
      case 4: return x > a[0] && x < a[1] && y > a[2] && y < a[3] && Math.abs(z - a[5]) < a[4] * (a[3] - y) / (a[3] - a[2]);
      case 5: return rotorHit(x, y, z, c);
    }
    return false;
  }
  function hit(x, y, z) {
    for (let i = 0; i < colN; i++) {
      const c = cols[i], dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz > c.r2) continue;
      const is = 1 / c.s, ly = (y - c.y) * is;
      if (ly > c.top) continue;
      const lx = (dx * c.c - dz * c.sn) * is, lz = (dx * c.sn + dz * c.c) * is, P = c.k.prims;
      for (let p = 0; p < P.length; p++) if (primHit(P[p], lx, ly, lz, c)) return true;
    }
    return false;
  }

  // ── per-frame ──
  let lastCX = 1e9, lastCZ = 1e9, lastGX = 1e9, lastGZ = 1e9, needGather = true, needCols = true;
  const stats = { ms: 0, avg: 0, gathers: 0, cells: 0, colliders: 0, inst: 0, tris: 0, buildMs: 0 };
  function update(dt, ctx) {
    const t0 = performance.now();
    const cx = ctx.cam.pos[0], cz = ctx.cam.pos[2];
    schedule(cx, cz);
    newCells = false;
    generate(ctx.mode === 'play' ? 0.2 : 0.5);
    if (newCells) { needGather = true; needCols = true; }
    const mx = cx - lastCX, mz = cz - lastCZ;
    if (needGather || mx * mx + mz * mz > 1600) { gather(cx, cz); lastCX = cx; lastCZ = cz; needGather = false; stats.gathers++; }
    const g = ctx.g, gx = g.pos[0] - lastGX, gz = g.pos[2] - lastGZ;
    if (needCols || gx * gx + gz * gz > 900) { gatherCols(g.pos[0], g.pos[2]); lastGX = g.pos[0]; lastGZ = g.pos[2]; needCols = false; }
    stats.ms = performance.now() - t0;
    stats.avg += (stats.ms - stats.avg) * 0.02;
  }
  function drawOpaque() { drawSets(false); }

  // ── model-viewer showcase around the origin (flat ground at y = 0) ──
  let PREV = null;
  function buildPreview() {
    const c = { it: [] }, r = rng(7, 7, 7), foot = [];
    const P = (kn, x, z, a, s, ph) => add(c, kn, x, 0, z, s || 1, a || 0, r(), r(), ph || 0);
    P('cottageA', -24, -11, 0); P('cottageB', -7, -11, 0.05, 1); P('cottageC', 11, -12, -0.04);
    P('cottageB', -18, 12, Math.PI + 0.06); P('cottageA', 2, 13, Math.PI); P('cottageC', 22, 13, Math.PI - 0.05);
    for (const [x, z, a] of [[-24, -11, 0], [-7, -11, 0], [11, -12, 0], [-18, 12, Math.PI], [2, 13, Math.PI], [22, 13, Math.PI]]) foot.push({ x, z, a, s: 1, rect: [-4.5, 7.5, -3.5, 5] });
    P('millT', -46, -34, WIND_YAW, 1.05, 0); P('millS', 44, -36, WIND_YAW, 1.0, 1.1);
    polyline(c, [[-31, -15], [-31, -24], [-16, -24], [-16, -15]], 'wall', [], r, true);
    polyline(c, [[4, -16], [4, -25], [20, -25], [20, -16]], 'fence', [], r, true);
    polyline(c, [[-70, 28], [-30, 26], [10, 29], [60, 26]], 'wall', [], r, true);
    polyline(c, [[-60, -50], [-20, -56], [30, -52]], 'fence', [], r, true);
    P('arch', 0, -115, 0, 1.0); P('archB', 64, -100, 0.35, 0.95);
    P('colS', -26, -98, 0.3, 1.0); P('colS', -20, -98, 1.2, 0.7); P('colS', -14, -98, 2.0, 0.5); P('colF', 20, -126, 0.4, 1);
    for (let k = 0; k < 4; k++) P(k === 3 ? 'aq2' : k === 1 ? 'aq1' : 'aq0', 80 + k * AQ.len, 40, 0, 1);
    const Rc = 12;
    for (let k = 0; k < 12; k++) {
      const ang = k / 12 * TAU, x = -90 + Math.cos(ang) * Rc, z = 50 + Math.sin(ang) * Rc;
      P(k === 3 ? 'tri' : ['st0', 'st1', 'st0', 'st2', 'st0', 'st1', 'st3', 'st0', 'st1', 'st0', 'st2', 'st0'][k], x, z, Math.atan2(Math.cos(ang), Math.sin(ang)), k === 3 ? 1.1 : 0.9 + 0.3 * r());
    }
    P('st3', -90, 50, 0.4, 1.1);
    for (let k = 0; k < 5; k++) P('r' + k, -30 + k * 14, 72, k * 1.3, k === 4 ? 1.4 : 1.2);
    P('light', -125, -70, Math.PI / 2, 1);
    PREV = c;
  }
  function preview(ctx) {
    if (!PREV) buildPreview();
    for (let i = 0; i < SETS.length; i++) SETS[i].n = 0;
    gatherList(PREV.it, ctx.cam.pos[0], ctx.cam.pos[2]);
    drawSets(true);
  }

  // ── debug / navigation helper: nearest landmark of a kind ──
  // kind: 'village' | 'windmill' | 'ruin' | 'arch' | 'aqueduct' | 'circle' | 'lighthouse'
  const KIND_GRID = { village: 'village', windmill: 'village', ruin: 'ruin', arch: 'ruin', aqueduct: 'ruin', circle: 'circle', lighthouse: 'light' };
  function nearest(x, z, kind, maxD) {
    const g = GRID[KIND_GRID[kind] || kind];
    if (!g) return null;
    maxD = maxD || 40000;
    const ci = Math.floor(x / g.size), cj = Math.floor(z / g.size);
    let best = null, bd = Infinity;
    for (let ring = 0; ring * g.size < maxD + g.size; ring++) {
      if (best && (ring - 1) * g.size > bd) break;
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        const st = g.site(i, j);
        if (!st) continue;
        if (kind === 'arch' && st.type === 'aqueduct') continue;
        if (kind === 'aqueduct' && st.type !== 'aqueduct') continue;
        if (Math.hypot(st.x - x, st.z - z) > bd + 200) continue;
        for (const s of g.cell(i, j).sites) {
          if (kind === 'windmill' ? s.kind !== 'windmill' : kind === 'village' ? s.kind !== 'village' : false) continue;
          const d = Math.hypot(s.x - x, s.z - z);
          if (d < bd && d < maxD) { bd = d; best = Object.assign({ dist: d }, s); }
        }
      }
    }
    needGather = true; needCols = true;
    return best;
  }
  // true if (x, z) lies on/near a landmark (buildings, ruins, stones, walls; not scattered boulders) —
  // lets vegetation/fauna modules keep clear. Deterministic: generates the covering cell if needed.
  for (const k of KINDS) {
    const bb = k.sets[0].mesh.bounds;
    k.foot = Math.hypot(Math.max(Math.abs(bb.lo[0]), Math.abs(bb.hi[0])), Math.max(Math.abs(bb.lo[2]), Math.abs(bb.hi[2])));
  }
  function occupied(x, z, pad) {
    pad = pad == null ? 2 : pad;
    for (const g of GRIDS) {
      if (!g.siteFn) continue;
      const i = Math.floor(x / g.size), j = Math.floor(z / g.size), e = g.name === 'light' ? 1 : 0;
      for (let di = -e; di <= e; di++) for (let dj = -e; dj <= e; dj++) {
        if (!g.site(i + di, j + dj)) continue;
        const it = g.cell(i + di, j + dj).it;
        for (let q = 0; q < it.length; q += 9) {
          const k = KINDS[it[q]];
          if (k.name[0] === 'r' && k.name.length === 2) continue;
          const dx = it[q + 1] - x, dz = it[q + 3] - z, r = k.foot * it[q + 4] + pad;
          if (dx * dx + dz * dz < r * r) return true;
        }
      }
    }
    return false;
  }
  // count landmark sites in a square around (x, z) — for tuning placement frequency
  function census(x, z, half) {
    const out = {};
    for (const g of GRIDS) {
      if (!g.siteFn) continue;
      const i0 = Math.floor((x - half) / g.size), i1 = Math.floor((x + half) / g.size), j0 = Math.floor((z - half) / g.size), j1 = Math.floor((z + half) / g.size);
      let n = 0;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const s = g.site(i, j); if (s) { n++; if (s.type) out[s.type] = (out[s.type] || 0) + 1; } }
      out[g.name] = n; out[g.name + 'Cells'] = (i1 - i0 + 1) * (j1 - j0 + 1);
    }
    return out;
  }
  function info() {
    let inst = 0, tris = 0;
    for (const s of SETS) { inst += s.n; tris += s.n * s.tris; }
    let cells = 0;
    for (const g of GRIDS) cells += g.cells.size;
    return Object.assign(stats, { inst, tris, cells, colliders: colN, buildMs,
      meshes: Object.fromEntries(Object.entries(MS).map(([k, m]) => [k, m.count / 3])) });
  }

  return { name: 'landmarks', update, drawOpaque, hit, preview, nearest, occupied, census, info, SETS, KINDS, GRIDS };
})();
MODELS.push(LANDMARKS);
