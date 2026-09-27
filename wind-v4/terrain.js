'use strict';
// ───────────────────────── Terrain (CDLOD, heights on GPU), water, sky ─────────────────────────
const TERRAIN = (() => {
  const { gl, program, buffer, attribs, env, setEnv } = GLX;
  const N = 32, LEAF = 64, LEVELS = 9, MINH = -120, MAXH = 1350;
  const RANGE = new Float64Array(LEVELS);
  for (let L = 0; L < LEVELS; L++) RANGE[L] = LEAF * Math.pow(2, L) * 2.2;

  // grid + quadrant-ordered indices
  const gv = new Float32Array((N + 1) * (N + 1) * 2);
  for (let j = 0, k = 0; j <= N; j++) for (let i = 0; i <= N; i++) { gv[k++] = i; gv[k++] = j; }
  const gi = new Uint16Array(N * N * 6);
  let ki = 0;
  const quad = (i0, j0) => {
    for (let j = j0; j < j0 + N / 2; j++) for (let i = i0; i < i0 + N / 2; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      if ((i + j) & 1) { gi[ki++] = a; gi[ki++] = c; gi[ki++] = b; gi[ki++] = b; gi[ki++] = c; gi[ki++] = d; }
      else { gi[ki++] = a; gi[ki++] = c; gi[ki++] = d; gi[ki++] = a; gi[ki++] = d; gi[ki++] = b; }
    }
  };
  quad(0, 0); quad(N / 2, 0); quad(0, N / 2); quad(N / 2, N / 2);
  const QIDX = N * N * 6 / 4;

  const MAXI = 4096;
  const inst = new Float32Array(MAXI * 4);
  const lists = [[], [], [], [], []]; // full, q0..q3 (flat arrays of x,z,size,lod)
  const tvao = gl.createVertexArray();
  gl.bindVertexArray(tvao);
  attribs(buffer(gv), [[0, 2, 2, 0, 0]]);
  const ibuf = buffer(inst, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(ibuf, [[1, 4, 4, 0, 1]]);
  buffer(gi, gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);

  const TVS = GLSL_COMMON + `
layout(location=0) in vec2 aGrid;
layout(location=1) in vec4 aNode;
uniform mat4 uVP;
out vec3 vRel; out vec3 vN; out float vH; out float vForest; out float vVar; out float vVar2;
void main(){
  float cell = aNode.z / 32.0;
  vec2 wp = aNode.xy + aGrid*cell;
  float range = 64.0*exp2(aNode.w)*2.2;
  float dy = max(uCam.y - 1350.0, 0.0);
  vec2 dd = wp - uCam.xz;
  float d = sqrt(dot(dd,dd) + dy*dy);
  float k = clamp((d - range*0.62)/(range*0.36), 0.0, 1.0);
  wp -= fract(aGrid*0.5)*2.0*cell*k;
  dd = wp - uCam.xz;
  float dm = sqrt(dot(dd,dd) + dy*dy);
  float det = 1.0 - smoothstep(1400.0, 2600.0, dm);
  float e = clamp(dm*0.006, 0.75, 60.0);
  float h = terrainH(wp, det);
  float hx = terrainH(wp + vec2(e, 0.0), det);
  float hz = terrainH(wp + vec2(0.0, e), det);
  vN = vec3(h - hx, e, h - hz);
  vH = h;
  vForest = forestMask(wp);
  vVar = vn(wp*0.004 + vec2(5.5, 2.5));
  vVar2 = vn(wp*0.021 + vec2(1.5, 8.5));
  vRel = vec3(wp.x - uCam.x, h - uCam.y, wp.y - uCam.z);
  gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const TFS = GLSL_COMMON + `
in vec3 vRel; in vec3 vN; in float vH; in float vForest; in float vVar; in float vVar2;
uniform vec3 uG, uGR, uGF, uGV; uniform float uGAgl;
out vec4 o;
float gliderShadow(vec3 wp){
  if (uSun.y < 0.05) return 0.0;
  float t = (uG.y - wp.y)/uSun.y;
  if (t < 0.0 || t > 420.0) return 0.0;
  vec3 sp = wp + uSun*t - uG;
  float lx = dot(sp, uGR), lz = -dot(sp, uGF);
  float ax = abs(lx);
  float le = -1.0 + ax*0.33, te = le + max(1.9 - ax*0.36, 0.0);
  float s = 0.2 + t*0.018;
  float m = smoothstep(3.8+s, 3.8-s, ax)*smoothstep(le-s, le+s, lz)*smoothstep(te+s, te-s, lz);
  if (ax < 0.35) m = max(m, smoothstep(0.35+s, 0.2, ax)*smoothstep(-1.7-s, -1.5, lz)*smoothstep(1.5+s, 1.3, lz));
  return m*(1.0 - smoothstep(40.0, 420.0, t));
}
void main(){
  vec3 n = normalize(vN);
  vec3 wp = vRel + uCam;
  float dist = length(vRel);
  float slope = 1.0 - n.y;
  vec3 col = mix(vec3(0.33,0.58,0.22), vec3(0.62,0.72,0.28), smoothstep(0.3, 0.78, vVar));
  col = mix(col, vec3(0.22,0.46,0.20), smoothstep(0.5, 0.85, vVar2)*0.55);
  col = mix(col, vec3(0.11,0.28,0.13), vForest*0.88);
  col = mix(vec3(0.86,0.80,0.62), col, smoothstep(1.2, 5.0, vH));
  float strata = 0.95 + 0.05*sin(vH*0.11 + vVar*9.0 + vVar2*4.0);
  float rk = smoothstep(0.3, 0.5, slope + (vVar-0.5)*0.16);
  vec3 rock = mix(vec3(0.62,0.56,0.47), vec3(0.74,0.64,0.5), vVar2)*strata;
  col = mix(col, rock, rk);
  float sn = smoothstep(640.0, 780.0, vH + vVar*90.0)*smoothstep(0.55, 0.3, slope);
  col = mix(col, vec3(0.95,0.96,0.98), sn);
  if (vH < 0.0) col = mix(vec3(0.60,0.64,0.50), vec3(0.06,0.27,0.35), smoothstep(0.0, 22.0, -vH));
  float grass = (1.0-rk)*(1.0-sn)*(1.0-vForest*0.8)*smoothstep(2.0, 6.0, vH);
  vec2 wd = vec2(0.917, 0.4);
  float wave = sin(dot(wp.xz, wd)*0.055 - uTime*1.8 + sin(dot(wp.xz, vec2(-wd.y, wd.x))*0.012)*3.0);
  wave = smoothstep(0.5, 1.0, wave)*(1.0 - smoothstep(300.0, 1600.0, dist));
  col *= 1.0 + wave*0.15*grass;
  float sp = hash2(ivec2(floor(wp.xz*1.4)));
  col *= 1.0 + (sp-0.5)*0.14*grass*(1.0 - smoothstep(25.0, 120.0, dist));
  // grass pressed by the glider's passage
  if (uGAgl < 30.0) {
    vec2 d = wp.xz - uG.xz;
    vec2 vd = normalize(uGV.xz + vec2(1e-4));
    float along = -dot(d, vd), across = abs(dot(d, vec2(-vd.y, vd.x)));
    float w = (1.0 - uGAgl/30.0);
    float trail = smoothstep(2.5 + along*0.3, 0.0, across)*smoothstep(-4.0, 2.0, along)*exp(-max(along,0.0)/35.0);
    float ring = exp(-dot(d,d)/(30.0 + uGAgl*6.0));
    col *= 1.0 + w*grass*(trail*(0.2 + 0.12*sin(along*0.7 - uTime*9.0)) + ring*0.22);
  }
  float wrap = clamp((dot(n, uSun) + 0.22)/1.22, 0.0, 1.0);
  vec3 amb = mix(uAmb*0.5, uAmb, n.y*0.5 + 0.5);
  float cs = smoothstep(0.52, 0.7, vn(wp.xz*0.0008 + uTime*vec2(0.0045, 0.0017)));
  vec3 lit = col*(uSunCol*wrap*(1.0 - cs*0.38) + amb*0.6);
  lit *= 1.0 - gliderShadow(wp)*0.5;
  o = vec4(fogIt(lit, vRel), 1.0);
}`;
  const TP = program(TVS, TFS);

  // ── water: one huge camera-centred quad at y=0 ──
  const WVS = GLSL_COMMON + `
layout(location=0) in vec2 aP;
uniform mat4 uVP;
out vec3 vRel;
void main(){ vRel = vec3(aP.x*30000.0, -uCam.y, aP.y*30000.0); gl_Position = uVP*vec4(vRel, 1.0); }`;
  const WFS = GLSL_COMMON + `
in vec3 vRel; uniform vec3 uG, uGV; uniform float uGAgl; out vec4 o;
void main(){
  vec3 wp = vRel + uCam; float dist = length(vRel); vec3 v = vRel/dist;
  vec2 p = wp.xz; vec2 g = vec2(0.0);
  g += 0.6*vec2(0.8,0.6)*cos(dot(p, vec2(0.8,0.6))*0.35 + uTime*1.3);
  g += 0.4*vec2(-0.5,0.85)*cos(dot(p, vec2(-0.5,0.85))*0.57 + uTime*1.7);
  g += 0.3*vec2(0.95,-0.3)*cos(dot(p, vec2(0.95,-0.3))*1.13 + uTime*2.3);
  g += 0.2*vec2(0.3,0.95)*cos(dot(p, vec2(0.3,0.95))*2.1 + uTime*3.1);
  float fade = 1.0 - smoothstep(60.0, 2200.0, dist);
  vec3 n = normalize(vec3(-g.x*0.1*fade, 1.0, -g.y*0.1*fade));
  float fres = pow(1.0 - max(dot(-v, n), 0.0), 4.0);
  vec3 rd = reflect(v, n); rd.y = abs(rd.y);
  vec3 col = mix(vec3(0.05,0.25,0.33)*(uSunCol*0.45 + uAmb*0.6), skyCol(rd), 0.22 + fres*0.72);
  col += uSunCol*pow(max(dot(rd, uSun), 0.0), 220.0)*3.0;
  float foam = 0.0;
  if (uGAgl < 12.0) {
    vec2 d = p - uG.xz; vec2 vd = normalize(uGV.xz + vec2(1e-4));
    float along = -dot(d, vd), across = abs(dot(d, vec2(-vd.y, vd.x)));
    foam = smoothstep(1.2 + along*0.18, 0.0, across)*smoothstep(-2.0, 1.0, along)*exp(-max(along,0.0)/45.0)*(1.0 - uGAgl/12.0);
    foam *= 0.6 + 0.4*sin(along*1.3 - uTime*10.0);
  }
  col = mix(col, vec3(0.95,0.97,1.0)*(uSunCol*0.6+uAmb*0.5), clamp(foam, 0.0, 1.0));
  o = vec4(fogIt(col, vRel), mix(0.7, 0.96, fres) + foam*0.3);
}`;
  const WP = program(WVS, WFS);
  const wvao = gl.createVertexArray();
  gl.bindVertexArray(wvao);
  attribs(buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);

  // ── sky ──
  const SVS = `out vec2 vP; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vP = p*2.0-1.0; gl_Position = vec4(vP, 1.0, 1.0); }`;
  const SFS = GLSL_COMMON + `
in vec2 vP; uniform vec3 uCR, uCU, uCF; uniform vec2 uTan; out vec4 o;
void main(){
  vec3 d = normalize(uCF + uCR*vP.x*uTan.x + uCU*vP.y*uTan.y);
  vec3 col = skyCol(d);
  if (d.y > 0.0) {
    vec2 p = d.xz/(d.y + 0.08)*0.9 + uTime*vec2(0.0015, 0.0006);
    float c = vn(p*vec2(1.2, 5.0)) *0.65 + vn(p*vec2(3.1, 11.0))*0.35;
    col = mix(col, uSunCol*0.55 + uHor*0.5, smoothstep(0.55, 0.95, c)*0.4*smoothstep(0.02, 0.3, d.y)*(1.0 - smoothstep(0.5, 0.9, d.y)));
  }
  float s = dot(d, uSun);
  col = mix(col, vec3(1.0, 0.97, 0.9)*1.3, smoothstep(0.99955, 0.9998, s));
  o = vec4(col, 1.0);
}`;
  const SP = program(SVS, SFS);
  const svao = gl.createVertexArray();

  // ── selection ──
  const planes = new Float64Array(24);
  function setFrustum(m) {
    for (let p = 0; p < 6; p++) {
      const row = p >> 1, sgn = (p & 1) ? -1 : 1;
      planes[p * 4] = m[3] + sgn * m[row];
      planes[p * 4 + 1] = m[7] + sgn * m[4 + row];
      planes[p * 4 + 2] = m[11] + sgn * m[8 + row];
      planes[p * 4 + 3] = m[15] + sgn * m[12 + row];
    }
  }
  let cx = 0, cy = 0, cz = 0;
  function visible(x, z, s) {
    const x0 = x - cx, x1 = x0 + s, z0 = z - cz, z1 = z0 + s, y0 = MINH - cy, y1 = MAXH - cy;
    for (let p = 0; p < 6; p++) {
      const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
      if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
    }
    return true;
  }
  function boxDist(x, z, s) {
    const dx = Math.max(x - cx, 0, cx - x - s), dz = Math.max(z - cz, 0, cz - z - s);
    const dy = cy > MAXH ? cy - MAXH : 0;
    return Math.sqrt(dx * dx + dz * dz + dy * dy);
  }
  let count = 0;
  function add(list, x, z, s, L) { if (count < MAXI) { list.push(x, z, s, L); count++; } }
  function select(x, z, s, L) {
    const d = boxDist(x, z, s);
    if (d > RANGE[L]) return false;
    if (!visible(x, z, s)) return true;
    if (L === 0 || d > RANGE[L - 1]) { add(lists[0], x, z, s, L); return true; }
    const h = s / 2;
    for (let q = 0; q < 4; q++) {
      const qx = x + (q & 1) * h, qz = z + (q >> 1) * h;
      if (!select(qx, qz, h, L - 1)) add(lists[q + 1], x, z, s, L);
    }
    return true;
  }

  const stats = { nodes: 0 };
  function draw(g, cam) {
    cx = cam.pos[0]; cy = cam.pos[1]; cz = cam.pos[2];
    setFrustum(env.vp);
    for (const l of lists) l.length = 0;
    count = 0;
    const RS = LEAF * Math.pow(2, LEVELS - 1);
    const rx = Math.floor(cx / RS), rz = Math.floor(cz / RS);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const x = (rx + i) * RS, z = (rz + j) * RS;
      if (!select(x, z, RS, LEVELS - 1) && visible(x, z, RS)) add(lists[0], x, z, RS, LEVELS - 1);
    }
    stats.nodes = count;

    // sky
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(SP.p); setEnv(SP);
    gl.uniform3fv(SP.u.uCR, cam.r); gl.uniform3fv(SP.u.uCU, cam.u); gl.uniform3fv(SP.u.uCF, cam.f);
    gl.uniform2f(SP.u.uTan, cam.tanX, cam.tanY);
    gl.bindVertexArray(svao); gl.drawArrays(gl.TRIANGLES, 0, 3);

    // terrain
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(TP.p); setEnv(TP);
    gl.uniform3fv(TP.u.uG, g.pos); gl.uniform3fv(TP.u.uGR, g.r); gl.uniform3fv(TP.u.uGF, g.f);
    gl.uniform3fv(TP.u.uGV, g.vel); gl.uniform1f(TP.u.uGAgl, g.agl);
    gl.bindVertexArray(tvao);
    let off = 0;
    for (let s = 0; s < 5; s++) { inst.set(lists[s], off); off += lists[s].length; }
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, off);
    off = 0;
    for (let s = 0; s < 5; s++) {
      const n = lists[s].length / 4;
      if (n) {
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, off * 16);
        if (s === 0) gl.drawElementsInstanced(gl.TRIANGLES, gi.length, gl.UNSIGNED_SHORT, 0, n);
        else gl.drawElementsInstanced(gl.TRIANGLES, QIDX, gl.UNSIGNED_SHORT, (s - 1) * QIDX * 2, n);
      }
      off += n;
    }
    gl.disable(gl.CULL_FACE);
  }
  function drawWater(g) {
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(WP.p); setEnv(WP);
    gl.uniform3fv(WP.u.uG, g.pos); gl.uniform3fv(WP.u.uGV, g.vel); gl.uniform1f(WP.u.uGAgl, g.pos[1]);
    gl.bindVertexArray(wvao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }
  return { draw, drawWater, stats };
})();
