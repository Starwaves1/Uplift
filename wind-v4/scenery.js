'use strict';
// ───────────────────────── Scenery: trees, clouds, thermal fluff, seeds, wind streaks, particles ─────────────────────────
const SCENERY = (() => {
  const { gl, program, buffer, attribs, env, setEnv } = GLX;
  const SHADE = `
vec3 shade(vec3 alb, vec3 n){
  float w = clamp((dot(n, uSun) + 0.25)/1.25, 0.0, 1.0);
  vec3 amb = mix(uAmb*0.5, uAmb, n.y*0.5 + 0.5);
  return alb*(uSunCol*w + amb*0.62);
}`;

  // ── tree mesh: two fluffy crowns + trunk ──
  function icosphere() {
    const t = (1 + Math.sqrt(5)) / 2;
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map(p => { const l = Math.hypot(...p); return p.map(c => c / l); });
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const mid = new Map();
    const m = (a, b) => {
      const k = a < b ? a * 1000 + b : b * 1000 + a;
      if (!mid.has(k)) { const p = v[a].map((c, i) => (c + v[b][i]) / 2), l = Math.hypot(...p); v.push(p.map(c => c / l)); mid.set(k, v.length - 1); }
      return mid.get(k);
    };
    const nf = [];
    for (const [a, b, c] of f) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    return { v, f: nf };
  }
  const tv = [], ti = [];
  function addCrown(cx, cy, cz, sx, sy, sz, seed) {
    const s = icosphere(), base = tv.length / 7;
    s.v.forEach((p, i) => {
      const j = 0.86 + 0.28 * hash2(i * 7 + seed, seed * 3 + i);
      tv.push(cx + p[0] * sx * j, cy + p[1] * sy * j, cz + p[2] * sz * j, p[0], p[1], p[2], 1);
    });
    s.f.forEach(([a, b, c]) => ti.push(base + a, base + b, base + c));
  }
  addCrown(0, 4.4, 0, 2.7, 2.4, 2.7, 3);
  addCrown(0.5, 6.4, -0.3, 1.9, 1.8, 1.9, 9);
  { // trunk
    const base = tv.length / 7;
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      tv.push(c * 0.32, -1.2, s * 0.32, c, 0, s, 0, c * 0.22, 3.2, s * 0.22, c, 0, s, 0);
    }
    for (let k = 0; k < 6; k++) { const a = base + k * 2, b = base + ((k + 1) % 6) * 2; ti.push(a, a + 1, b, b, a + 1, b + 1); }
  }
  const TREE_IDX = ti.length;
  const TMAX = 9000;
  const tInst = new Float32Array(TMAX * 5);
  let tCount = 0;
  const treeVao = gl.createVertexArray();
  gl.bindVertexArray(treeVao);
  attribs(buffer(new Float32Array(tv)), [[0, 3, 7, 0], [1, 3, 7, 3], [2, 1, 7, 6]]);
  const tIBuf = buffer(tInst, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(tIBuf, [[3, 4, 5, 0, 1], [4, 1, 5, 4, 1]]);
  buffer(new Uint16Array(ti), gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);
  const TreeP = program(GLSL_COMMON + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in float aPart;
layout(location=3) in vec4 aI; layout(location=4) in float aV;
uniform mat4 uVP;
out vec3 vRel; out vec3 vN; out float vPart; out float vV; out float vY;
void main(){
  float d = distance(aI.xz, uCam.xz);
  float s = aI.w*smoothstep(880.0, 740.0, d);
  vec3 p = aP*s;
  float sway = sin(uTime*1.3 + aI.x*0.07 + aI.z*0.05)*0.1*max(aP.y - 2.0, 0.0)*aPart;
  p.x += sway*s; p.z += sway*0.5*s;
  vRel = aI.xyz + p - uCam; vN = aN; vPart = aPart; vV = aV; vY = aP.y;
  gl_Position = uVP*vec4(vRel, 1.0);
}`, GLSL_COMMON + SHADE + `
in vec3 vRel; in vec3 vN; in float vPart; in float vV; in float vY; out vec4 o;
void main(){
  vec3 n = normalize(vN);
  vec3 alb = vPart > 0.5 ? mix(vec3(0.12,0.31,0.14), vec3(0.26,0.47,0.17), vV) : vec3(0.30,0.22,0.15);
  float ao = mix(0.5, 1.05, smoothstep(1.5, 7.5, vY));
  o = vec4(fogIt(shade(alb, n)*ao, vRel), 1.0);
}`);

  const TILE = 128, tiles = new Map();
  let tileKey = '', neededTiles = [];
  function genTile(ti0, tj0) {
    const out = [];
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
      const gx = ti0 * 6 + a, gz = tj0 * 6 + b;
      const r1 = hash2(gx, gz), r2 = hash2(gz + 911, gx + 37), r3 = hash2(gx + 5, gz + 71);
      const x = ti0 * TILE + (a + 0.5) * (TILE / 6) + (r2 - 0.5) * 16, z = tj0 * TILE + (b + 0.5) * (TILE / 6) + (r3 - 0.5) * 16;
      const fm = forestMask(x, z);
      if (r1 > fm * 0.95 + 0.012) continue;
      const h = terrainH(x, z, 1);
      if (h < 3 || h > 520) continue;
      const n = terrainN(x, z, [0, 0, 0]);
      if (n[1] < 0.84) continue;
      out.push(x, h - 0.7, z, 0.75 + r2 * 0.7, r3);
    }
    return new Float32Array(out);
  }
  function updateTrees(cx, cz) {
    const i0 = Math.floor((cx - 860) / TILE), i1 = Math.floor((cx + 860) / TILE);
    const j0 = Math.floor((cz - 860) / TILE), j1 = Math.floor((cz + 860) / TILE);
    const k = i0 + ',' + j0;
    let budget = 4, dirty = k !== tileKey;
    if (dirty) {
      tileKey = k; neededTiles = [];
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const dx = Math.max(i * TILE - cx, 0, cx - (i + 1) * TILE), dz = Math.max(j * TILE - cz, 0, cz - (j + 1) * TILE);
        if (dx * dx + dz * dz < 880 * 880) neededTiles.push(i, j);
      }
    }
    let missing = false;
    for (let q = 0; q < neededTiles.length; q += 2) {
      const tk = neededTiles[q] * 100003 + neededTiles[q + 1];
      if (!tiles.has(tk)) { if (budget-- > 0) { tiles.set(tk, genTile(neededTiles[q], neededTiles[q + 1])); dirty = true; } else missing = true; }
    }
    if (dirty || missing) {
      tCount = 0;
      for (let q = 0; q < neededTiles.length; q += 2) {
        const t = tiles.get(neededTiles[q] * 100003 + neededTiles[q + 1]);
        if (!t) continue;
        const n = Math.min(t.length / 5, TMAX - tCount);
        tInst.set(t.subarray(0, n * 5), tCount * 5); tCount += n;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, tIBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, tInst, 0, tCount * 5);
    }
    if (tiles.size > 900) for (const [tk] of tiles) { const i = Math.round(tk / 100003); if (Math.abs(i * TILE - cx) > 2400) tiles.delete(tk); }
  }
  // nearest trunk hit test for collision
  function treeHit(x, y, z) {
    if (!tCount) return false;
    const i = Math.floor(x / TILE), j = Math.floor(z / TILE);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const t = tiles.get((i + a) * 100003 + (j + b));
      if (!t) continue;
      for (let q = 0; q < t.length; q += 5) {
        const dx = x - t[q], dz = z - t[q + 2], s = t[q + 3], dy = y - t[q + 1];
        if (dy > -1 && dy < 8.2 * s && dx * dx + dz * dz < (dy > 2 * s ? 2.4 * s : 0.5) ** 2) return true;
      }
    }
    return false;
  }

  // ── billboards (clouds, fluff, seeds, particles) share a corner quad ──
  const quadBuf = buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));

  const CMAX = 2600;
  const cData = new Float32Array(CMAX * 7), cSorted = new Float32Array(CMAX * 7), cDist = new Float32Array(CMAX);
  let cIdx = new Uint32Array(CMAX), cCount = 0;
  const cloudVao = gl.createVertexArray();
  gl.bindVertexArray(cloudVao);
  attribs(quadBuf, [[0, 2, 2, 0, 0]]);
  const cBuf = buffer(cSorted, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(cBuf, [[1, 4, 7, 0, 1], [2, 3, 7, 4, 1]]);
  gl.bindVertexArray(null);
  const CloudP = program(GLSL_COMMON + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 aPuff; layout(location=2) in vec3 aB;
uniform mat4 uVP; uniform vec3 uCR, uCU;
out vec2 vUV; out vec3 vRel; out float vHF; out float vNear; out float vSeed;
void main(){
  vec3 c = aPuff.xyz - uCam; float r = aPuff.w;
  vRel = c + (uCR*aC.x + uCU*aC.y)*r*1.08;
  vUV = aC*1.08; vSeed = aB.z;
  vHF = clamp((aPuff.y - aB.x)/(aB.y*0.9), 0.0, 1.0);
  vNear = smoothstep(r*0.35, r*1.2, length(c));
  gl_Position = uVP*vec4(vRel, 1.0);
}`, GLSL_COMMON + `
in vec2 vUV; in vec3 vRel; in float vHF; in float vNear; in float vSeed;
uniform vec3 uCR, uCU, uCF; out vec4 o;
void main(){
  float d = length(vUV);
  float d2 = d + (vn(vUV*2.6 + vSeed) - 0.5)*0.34 + (vn(vUV*6.0 + vSeed*1.7) - 0.5)*0.12;
  float a = smoothstep(1.0, 0.62, d2)*vNear;
  if (a < 0.004) discard;
  float z = sqrt(max(1.0 - d*d, 0.0));
  vec3 nW = normalize(uCR*vUV.x + uCU*vUV.y - uCF*z);
  float l = smoothstep(-0.55, 0.8, dot(nW, uSun));
  vec3 litC = vec3(1.0, 0.99, 0.96)*(uSunCol*0.55 + 0.5);
  vec3 shdC = mix(uAmb, uHor, 0.45)*0.92 + vec3(0.02, 0.03, 0.07);
  vec3 col = mix(shdC, litC, l)*mix(0.8, 1.05, vHF);
  vec3 v = normalize(vRel);
  col += uSunCol*pow(max(dot(v, uSun), 0.0), 6.0)*pow(clamp(d2, 0.0, 1.0), 3.0)*0.9;
  o = vec4(fogIt(col, vRel), a*0.97);
}`);

  // thermal fluff
  const FPER = 70, FMAX = 24 * FPER;
  const fInst = new Float32Array(FMAX * 11);
  let fCount = 0;
  const fluffVao = gl.createVertexArray();
  gl.bindVertexArray(fluffVao);
  attribs(quadBuf, [[0, 2, 2, 0, 0]]);
  const fBuf = buffer(fInst, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(fBuf, [[1, 4, 11, 0, 1], [2, 4, 11, 4, 1], [3, 3, 11, 8, 1]]);
  gl.bindVertexArray(null);
  const FluffP = program(GLSL_COMMON + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 aT; layout(location=2) in vec4 aT2; layout(location=3) in vec3 aR;
uniform mat4 uVP; uniform vec3 uCR, uCU;
out vec2 vUV; out float vA; out vec3 vRel;
void main(){
  float span = aT2.x - aT.w;
  float y = aT.w + mod(uTime*(aT2.y*0.8 + 1.0) + aR.x*span, span);
  float ang = aR.y*6.2832 + uTime*(0.2 + aR.z*0.25);
  float rad = aT.z*(0.15 + 0.85*sqrt(aR.z));
  vec3 c = vec3(aT.x + cos(ang)*rad, y, aT.y + sin(ang)*rad) - uCam;
  float dist = length(c);
  float s = max(0.55, dist*0.0026);
  vRel = c + (uCR*aC.x + uCU*aC.y)*s;
  vUV = aC;
  vA = smoothstep(0.0, 50.0, y - aT.w)*(1.0 - smoothstep(span - 120.0, span, y - aT.w))*smoothstep(2400.0, 1400.0, dist)*(0.55/max(1.0, s*0.8))*aT2.z;
  gl_Position = uVP*vec4(vRel, 1.0);
}`, GLSL_COMMON + `
in vec2 vUV; in float vA; in vec3 vRel; out vec4 o;
void main(){
  float d = length(vUV); float a = exp(-d*d*3.5)*vA;
  if (a < 0.003) discard;
  vec3 c = vec3(1.0, 0.99, 0.95)*(uSunCol*0.5 + 0.55);
  o = vec4(c*a, a*0.6);
}`);

  // seeds (collectibles)
  const SMAX = 1200;
  const sInst = new Float32Array(SMAX * 4);
  let sCount = 0;
  const seedVao = gl.createVertexArray();
  gl.bindVertexArray(seedVao);
  attribs(quadBuf, [[0, 2, 2, 0, 0]]);
  const sBuf = buffer(sInst, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(sBuf, [[1, 4, 4, 0, 1]]);
  gl.bindVertexArray(null);
  const SeedP = program(GLSL_COMMON + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 aS;
uniform mat4 uVP; uniform vec3 uCR, uCU;
out vec2 vUV; out float vA; out float vGlow;
void main(){
  vec3 c = aS.xyz - uCam; c.y += sin(uTime*1.6 + aS.w)*0.6;
  float dist = length(c);
  float s = max(1.7, dist*0.0045);
  vec3 p = c + (uCR*aC.x + uCU*aC.y)*s;
  vUV = aC; vGlow = clamp(1.7/s, 0.25, 1.0);
  vA = smoothstep(2100.0, 1500.0, dist)*smoothstep(2.0, 6.0, dist);
  gl_Position = uVP*vec4(p, 1.0);
}`, GLSL_COMMON + `
in vec2 vUV; in float vA; in float vGlow; out vec4 o;
void main(){
  vec2 a = abs(vUV); float d = length(vUV);
  float core = exp(-d*d*28.0);
  float halo = exp(-d*d*5.0)*0.45;
  float rays = (exp(-a.x*28.0)*exp(-a.y*3.5) + exp(-a.y*28.0)*exp(-a.x*3.5))*0.55*vGlow;
  float i = (core + halo + rays)*vA;
  vec3 c = mix(vec3(1.0, 0.72, 0.3), vec3(1.0, 0.97, 0.85), core);
  o = vec4(c*i*1.3, 0.0);
}`);

  // wind streaks
  const WN = 360;
  const wData = new Float32Array(WN * 4);
  for (let i = 0; i < WN; i++) { wData[i * 4] = Math.random() * 90; wData[i * 4 + 1] = Math.random() * 90; wData[i * 4 + 2] = Math.random() * 90; wData[i * 4 + 3] = Math.random(); }
  const streakVao = gl.createVertexArray();
  gl.bindVertexArray(streakVao);
  attribs(buffer(new Float32Array([0, -1, 1, -1, 0, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  attribs(buffer(wData), [[1, 4, 4, 0, 1]]);
  gl.bindVertexArray(null);
  const StreakP = program(GLSL_COMMON + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 aS;
uniform mat4 uVP; uniform vec3 uAir, uWOff; uniform float uAmt;
out float vA; out float vT;
void main(){
  vec3 rel = mod(aS.xyz - uCam + uWOff, 90.0) - 45.0;
  vec3 tail = -uAir*(0.03 + aS.w*0.035);
  vec3 p = rel + tail*aC.x;
  vec3 side = normalize(cross(tail + vec3(1e-4, 2e-4, 0.0), p + vec3(0.0, 1e-3, 0.0)))*0.018*(1.0 + length(rel)*0.02);
  p += side*aC.y;
  float r = length(rel);
  vA = smoothstep(3.5, 9.0, r)*(1.0 - smoothstep(28.0, 44.0, r))*uAmt*(0.4 + aS.w*0.6);
  vT = aC.x;
  gl_Position = uVP*vec4(p, 1.0);
}`, `in float vA; in float vT; out vec4 o; void main(){ float a = vA*(1.0 - vT)*vT*4.0; o = vec4(vec3(1.0)*a*0.28, 0.0); }`);

  // particles (CPU)
  const PN = 1024;
  const P = { x: new Float32Array(PN), y: new Float32Array(PN), z: new Float32Array(PN), vx: new Float32Array(PN), vy: new Float32Array(PN),
    vz: new Float32Array(PN), l: new Float32Array(PN), m: new Float32Array(PN), s: new Float32Array(PN), k: new Uint8Array(PN), head: 0 };
  function emit(x, y, z, vx, vy, vz, life, size, kind) {
    const i = P.head; P.head = (P.head + 1) % PN;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz; P.l[i] = life; P.m[i] = life; P.s[i] = size; P.k[i] = kind;
  }
  const pInst = new Float32Array(PN * 8);
  let pCount = 0;
  const partVao = gl.createVertexArray();
  gl.bindVertexArray(partVao);
  attribs(quadBuf, [[0, 2, 2, 0, 0]]);
  const pBuf = buffer(pInst, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(pBuf, [[1, 4, 8, 0, 1], [2, 4, 8, 4, 1]]);
  gl.bindVertexArray(null);
  const PartP = program(GLSL_COMMON + `
layout(location=0) in vec2 aC; layout(location=1) in vec4 aP; layout(location=2) in vec4 aCol;
uniform mat4 uVP; uniform vec3 uCR, uCU;
out vec2 vUV; out vec4 vCol;
void main(){ vec3 c = aP.xyz - uCam; vUV = aC; vCol = aCol; gl_Position = uVP*vec4(c + (uCR*aC.x + uCU*aC.y)*aP.w, 1.0); }`,
  `in vec2 vUV; in vec4 vCol; out vec4 o; void main(){ float d = dot(vUV, vUV); float a = exp(-d*3.0); if (a < 0.02) discard; o = vec4(vCol.rgb*a, vCol.a*a); }`);
  function stepParticles(dt) {
    pCount = 0;
    for (let i = 0; i < PN; i++) {
      if (P.l[i] <= 0) continue;
      P.l[i] -= dt;
      const k = P.k[i];
      const drag = k === 1 ? 1.2 : 2.5;
      const e = Math.exp(-drag * dt);
      P.vx[i] *= e; P.vz[i] *= e; P.vy[i] = P.vy[i] * e - (k === 1 ? 9.8 : k === 2 ? -0.6 : 1.5) * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      const f = P.l[i] / P.m[i], o = pCount * 8;
      pInst[o] = P.x[i]; pInst[o + 1] = P.y[i]; pInst[o + 2] = P.z[i]; pInst[o + 3] = P.s[i] * (k === 1 ? 1.6 - f * 0.6 : 1);
      if (k === 2) { pInst[o + 4] = 1.2 * f; pInst[o + 5] = 0.85 * f; pInst[o + 6] = 0.45 * f; pInst[o + 7] = 0; }
      else if (k === 3) { pInst[o + 4] = 0.55 * f; pInst[o + 5] = 0.5 * f; pInst[o + 6] = 0.42 * f; pInst[o + 7] = 0.6 * f; }
      else { pInst[o + 4] = 0.9 * f; pInst[o + 5] = 0.95 * f; pInst[o + 6] = 1.0 * f; pInst[o + 7] = 0.75 * f; }
      pCount++;
    }
  }

  // ── per-frame gather ──
  const tmp = [], tmp2 = [], tst = [0, 0, 0];
  const events = { seeds: 0, cloud: 0, lastSeedX: 0, lastSeedY: 0, lastSeedZ: 0 };
  // a model module with replacesTrees takes over vegetation entirely
  const legacyTrees = () => !MODELS.some(m => m.replacesTrees);
  function update(dt, cam, g, drift) {
    if (legacyTrees()) updateTrees(cam.pos[0], cam.pos[2]); else tCount = 0;
    stepParticles(dt);
    const cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
    // clouds
    cCount = 0;
    let inside = 0;
    const addCloud = (p, dx, dz) => {
      for (let q = 0; q < p.length && cCount < CMAX; q += 6) {
        const x = p[q] + dx, y = p[q + 1], z = p[q + 2] + dz, r = p[q + 3];
        const ex = x - cx, ey = y - cy, ez = z - cz, d2 = ex * ex + ey * ey + ez * ez;
        const o = cCount * 7;
        cData[o] = x; cData[o + 1] = y; cData[o + 2] = z; cData[o + 3] = r; cData[o + 4] = p[q + 4]; cData[o + 5] = p[q + 5]; cData[o + 6] = (q * 0.37 + p[q] * 0.013) % 50;
        cDist[cCount] = d2; cIdx[cCount] = cCount; cCount++;
        const din = Math.sqrt(d2) / r;
        if (din < 0.95) inside = Math.max(inside, 1 - din / 0.95);
      }
    };
    WORLD.cloudsAround(cx - drift[0], cz - drift[2], 6500, tmp);
    for (const c of tmp) for (const p of c) addCloud(p, drift[0], drift[2]);
    WORLD.thermalsNear(cx, cz, 5000, tmp);
    for (const t of tmp) { WORLD.thermalState(t, GLX.env.time, tst); if (tst[2] > 0.05) addCloud(t.cloud, tst[0] - t.x, tst[1] - t.z); }
    const idx = cIdx.subarray(0, cCount);
    idx.sort((a, b) => cDist[b] - cDist[a]);
    for (let i = 0; i < cCount; i++) {
      const s = idx[i] * 7, d = i * 7;
      for (let k = 0; k < 7; k++) cSorted[d + k] = cData[s + k];
    }
    events.cloud = inside;

    // thermal fluff
    fCount = 0;
    WORLD.thermalsNear(cx, cz, 2400, tmp2);
    for (const t of tmp2) {
      if (fCount + FPER > FMAX) break;
      WORLD.thermalState(t, GLX.env.time, tst);
      if (tst[2] <= 0.02) continue;
      for (let k = 0; k < FPER; k++) {
        const o = fCount * 11;
        fInst[o] = tst[0]; fInst[o + 1] = tst[1]; fInst[o + 2] = t.r; fInst[o + 3] = t.ground;
        fInst[o + 4] = t.top; fInst[o + 5] = t.w; fInst[o + 6] = tst[2]; fInst[o + 7] = 0;
        fInst[o + 8] = hash2(k, 11 + Math.floor(t.x)); fInst[o + 9] = hash2(k + 91, 7); fInst[o + 10] = hash2(k * 3 + 5, Math.floor(t.z));
        fCount++;
      }
    }

    // seeds + collection
    sCount = 0; events.seeds = 0;
    const gx = g.pos[0], gy = g.pos[1], gz = g.pos[2];
    const addSeeds = (s) => {
      for (let q = 0; q < s.n && sCount < SMAX; q++) {
        if (s.got[q]) continue;
        const x = s.p[q * 3], y = s.p[q * 3 + 1], z = s.p[q * 3 + 2];
        const dx = x - gx, dy = y - gy, dz = z - gz;
        if (g.live && dx * dx + dy * dy + dz * dz < 64) {
          s.got[q] = 1; events.seeds++;
          events.lastSeedX = x; events.lastSeedY = y; events.lastSeedZ = z;
          for (let k = 0; k < 16; k++) emit(x, y, z, (Math.random() - 0.5) * 9, (Math.random() - 0.3) * 6, (Math.random() - 0.5) * 9, 0.9 + Math.random() * 0.5, 0.35, 2);
          continue;
        }
        const o = sCount * 4;
        sInst[o] = x; sInst[o + 1] = y; sInst[o + 2] = z; sInst[o + 3] = q * 1.7;
        sCount++;
      }
    };
    WORLD.seedsAround(cx, cz, 2100, tmp);
    for (const s of tmp) addSeeds(s);
    for (const t of tmp2) addSeeds(t.seeds);
  }

  function upload(buf, data, n) { if (n) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n); } }
  function drawOpaque() {
    if (!tCount) return;
    gl.useProgram(TreeP.p); setEnv(TreeP);
    gl.bindVertexArray(treeVao);
    gl.drawElementsInstanced(gl.TRIANGLES, TREE_IDX, gl.UNSIGNED_SHORT, 0, tCount);
  }
  function drawTransparent(cam, g, air, drift, streakAmt) {
    gl.enable(gl.BLEND); gl.depthMask(false);
    // clouds
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (cCount) {
      upload(cBuf, cSorted, cCount * 7);
      gl.useProgram(CloudP.p); setEnv(CloudP);
      gl.uniform3fv(CloudP.u.uCR, cam.r); gl.uniform3fv(CloudP.u.uCU, cam.u); gl.uniform3fv(CloudP.u.uCF, cam.f);
      gl.bindVertexArray(cloudVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cCount);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (fCount) {
      upload(fBuf, fInst, fCount * 11);
      gl.useProgram(FluffP.p); setEnv(FluffP);
      gl.uniform3fv(FluffP.u.uCR, cam.r); gl.uniform3fv(FluffP.u.uCU, cam.u);
      gl.bindVertexArray(fluffVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fCount);
    }
    if (sCount) {
      upload(sBuf, sInst, sCount * 4);
      gl.useProgram(SeedP.p); setEnv(SeedP);
      gl.uniform3fv(SeedP.u.uCR, cam.r); gl.uniform3fv(SeedP.u.uCU, cam.u);
      gl.bindVertexArray(seedVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sCount);
    }
    if (pCount) {
      upload(pBuf, pInst, pCount * 8);
      gl.useProgram(PartP.p); setEnv(PartP);
      gl.uniform3fv(PartP.u.uCR, cam.r); gl.uniform3fv(PartP.u.uCU, cam.u);
      gl.bindVertexArray(partVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pCount);
    }
    if (streakAmt > 0.01) {
      gl.useProgram(StreakP.p); setEnv(StreakP);
      gl.uniform3fv(StreakP.u.uAir, air);
      gl.uniform3f(StreakP.u.uWOff, drift[0] % 90, 0, drift[2] % 90);
      gl.uniform1f(StreakP.u.uAmt, streakAmt);
      gl.bindVertexArray(streakVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, WN);
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
  }
  return { update, drawOpaque, drawTransparent, emit, events, treeHit, stats: () => ({ trees: tCount, puffs: cCount, seeds: sCount }) };
})();
