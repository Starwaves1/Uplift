'use strict';
// ───────────────────────── Glider: procedural wing, engine pod, handlebar, rider ─────────────────────────
const GLIDER = (() => {
  const { gl, program, buffer, attribs, env, setEnv } = GLX;
  const V = [], I = [];
  const vcount = () => V.length / 9;
  const CREAM = [0.84, 0.82, 0.76], TEAL = [0.16, 0.46, 0.52], UNDER = [0.7, 0.7, 0.68], DARK = [0.16, 0.16, 0.18];

  // wing: airfoil sections along the span, each side
  const SPAN = 3.8, NS = 14, NC = 9;
  const zLE = x => -1.0 + x * 0.33, chord = x => 1.9 - x * 0.36;
  const yOff = x => x * 0.07 + (x > 3.25 ? (x - 3.25) * (x - 3.25) * 1.1 : 0);
  function wingSide(sgn) {
    for (const top of [true, false]) {
      const base = vcount();
      for (let s = 0; s <= NS; s++) {
        const t = s / NS, x = t * SPAN, c = chord(x);
        for (let k = 0; k < NC; k++) {
          const u = k / (NC - 1), uu = u * u;
          const th = c * 0.075 * (Math.sqrt(u) - u) * 2.2 * (1 - t * 0.4);
          const cam = c * 0.035 * 4 * u * (1 - u);
          const y = yOff(x) + cam + (top ? th : -th * 0.45);
          const stripe = u < 0.16 || x > 3.2 || (u > 0.72 && u < 0.78 && x < 2.8);
          const col = top ? (stripe ? TEAL : CREAM) : UNDER;
          V.push(sgn * x, y, zLE(x) + uu * 0 + u * c, 0, 0, 0, col[0], col[1], col[2]);
        }
      }
      for (let s = 0; s < NS; s++) for (let k = 0; k < NC - 1; k++) {
        const a = base + s * NC + k, b = a + 1, c = a + NC, d = c + 1;
        const flip = (sgn > 0) !== top;
        if (flip) I.push(a, b, c, b, d, c); else I.push(a, c, b, b, c, d);
      }
    }
  }
  wingSide(1); wingSide(-1);

  // lathe helper (engine pod)
  function lathe(z0, z1, cy, prof, seg, colFn) {
    const rings = prof.length, base = vcount();
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1), z = z0 + (z1 - z0) * t, r = prof[i];
      const col = colFn(t);
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * Math.PI * 2;
        V.push(Math.cos(a) * r, cy + Math.sin(a) * r, z, 0, 0, 0, col[0], col[1], col[2]);
      }
    }
    for (let i = 0; i < rings - 1; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
  }
  lathe(-1.75, 1.55, -0.24, [0.02, 0.15, 0.22, 0.26, 0.26, 0.25, 0.22, 0.18, 0.15, 0.13], 12,
    t => (t < 0.06 ? DARK : t > 0.93 ? DARK : t > 0.2 && t < 0.26 ? TEAL : CREAM));

  // rounded tube through points with per-point radii (smooth normals come from the averaging pass)
  function tube(pts, rad, col, sides) {
    sides = sides || 10;
    const base = vcount();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const tl = Math.hypot(...t); t = t.map(c => c / tl);
      const up = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      let n1 = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
      const nl = Math.hypot(...n1); n1 = n1.map(c => c / nl);
      const n2 = [t[1] * n1[2] - t[2] * n1[1], t[2] * n1[0] - t[0] * n1[2], t[0] * n1[1] - t[1] * n1[0]];
      for (let k = 0; k <= sides; k++) {
        const ang = k / sides * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = rad[i];
        V.push(pts[i][0] + (n1[0] * c + n2[0] * s) * r, pts[i][1] + (n1[1] * c + n2[1] * s) * r, pts[i][2] + (n1[2] * c + n2[2] * s) * r, 0, 0, 0, col[0], col[1], col[2]);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a = base + i * (sides + 1) + k, b = a + 1, c = a + sides + 1, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
  }
  function blob(c, rx, rz, col) {
    const pts = [], rad = [];
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i / 6 * Math.PI; pts.push([c[0], c[1], c[2] + Math.sin(a) * rz]); rad.push(Math.max(0.002, Math.cos(a) * rx)); }
    tube(pts, rad, col, 10);
  }
  const WOOD = [0.44, 0.29, 0.16], METAL = [0.3, 0.29, 0.28], SLEEVE = [0.23, 0.35, 0.55], GLOVE = [0.38, 0.26, 0.17], SKIN = [0.86, 0.68, 0.55];
  tube([[-0.34, 0.17, -0.74], [0.34, 0.17, -0.74]], [0.014, 0.014], METAL, 8);
  tube([[-0.47, 0.17, -0.74], [-0.34, 0.17, -0.74]], [0.022, 0.022], WOOD, 8);
  tube([[0.34, 0.17, -0.74], [0.47, 0.17, -0.74]], [0.022, 0.022], WOOD, 8);
  tube([[0.26, 0.06, -0.7], [0.26, 0.17, -0.74]], [0.012, 0.01], METAL, 6);
  tube([[-0.26, 0.06, -0.7], [-0.26, 0.17, -0.74]], [0.012, 0.01], METAL, 6);
  // arms reaching forward to the grips
  for (const s of [1, -1]) {
    tube([[0.17 * s, 0.2, 0.08], [0.25 * s, 0.13, -0.18], [0.33 * s, 0.13, -0.42], [0.4 * s, 0.17, -0.68]], [0.055, 0.047, 0.042, 0.034], SLEEVE, 10);
    blob([0.41 * s, 0.175, -0.74], 0.042, 0.06, GLOVE);
  }
  const FP_COUNT = I.length;
  // rider body + head (chase view only)
  tube([[0, 0.17, 0.95], [0, 0.22, 0.6], [0, 0.24, 0.3], [0, 0.26, 0.08]], [0.12, 0.15, 0.16, 0.13], SLEEVE, 10);
  for (const s of [1, -1]) tube([[0.1 * s, 0.14, 0.95], [0.11 * s, 0.12, 1.3], [0.11 * s, 0.1, 1.6]], [0.07, 0.06, 0.05], [0.32, 0.26, 0.2], 8);
  blob([0, 0.38, 0.02], 0.1, 0.12, SKIN);
  blob([0, 0.42, 0.06], 0.105, 0.1, [0.45, 0.22, 0.14]);
  const ALL_COUNT = I.length;

  // smooth normals per mesh vertex
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 9, b = I[i + 1] * 9, c = I[i + 2] * 9;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { V[o + 3] += nx; V[o + 4] += ny; V[o + 5] += nz; }
  }
  for (let o = 0; o < V.length; o += 9) {
    const l = Math.hypot(V[o + 3], V[o + 4], V[o + 5]) || 1;
    V[o + 3] /= l; V[o + 4] /= l; V[o + 5] /= l;
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  attribs(buffer(new Float32Array(V)), [[0, 3, 9, 0], [1, 3, 9, 3], [2, 3, 9, 6]]);
  buffer(new Uint16Array(I), gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);

  const QROT = `vec3 qrot(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz, v) + q.w*v); }`;
  const P = program(GLSL_COMMON + QROT + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aCol;
uniform mat4 uVPg; uniform vec4 uQ; uniform vec3 uPos;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec3 vL;
void main(){ vec3 p = qrot(uQ, aP) + uPos; vN = qrot(uQ, aN); vCol = aCol; vRel = p; vL = aP; gl_Position = uVPg*vec4(p, 1.0); }`,
  GLSL_COMMON + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec3 vL; uniform float uFogOn; out vec4 o;
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;
  float w = clamp((dot(n, uSun) + 0.15)/1.15, 0.0, 1.0);
  vec3 amb = mix(uAmb*0.5, uAmb, n.y*0.5 + 0.5);
  vec3 alb = vCol;
  if (abs(vL.x) > 0.5 && vL.y > -0.1) {
    float rib = smoothstep(0.44, 0.5, abs(fract(abs(vL.x)*2.1) - 0.5));
    float seam = smoothstep(0.012, 0.0, abs(fract(vL.z*1.6 + 0.3) - 0.5) - 0.48);
    alb *= 1.0 - rib*0.1 - seam*0.05;
  }
  vec3 col = alb*(uSunCol*w*0.72 + amb*0.5);
  float sp = pow(max(dot(reflect(v, n), uSun), 0.0), 36.0);
  col += uSunCol*sp*0.18;
  col += skyCol(reflect(v, n))*pow(1.0 - max(dot(-v, n), 0.0), 3.0)*0.16;
  if (uFogOn > 0.5) col = fogIt(col, vRel);
  o = vec4(col, 1.0);
}`);

  // jet flame sprite
  const FP_ = program(QROT + `
layout(location=0) in vec2 aC; uniform mat4 uVPg; uniform vec4 uQ; uniform vec3 uPos, uCR, uCU; uniform float uPow;
out vec2 vUV;
void main(){ vec3 c = qrot(uQ, vec3(0.0, -0.24, 1.72)) + uPos; vUV = aC; gl_Position = uVPg*vec4(c + (uCR*aC.x + uCU*aC.y)*(0.35 + uPow*0.25), 1.0); }`,
  `in vec2 vUV; uniform float uPow, uT; out vec4 o;
void main(){ float d = length(vUV); float a = exp(-d*d*4.0)*uPow*(0.85 + 0.15*sin(uT*60.0)); o = vec4(vec3(0.75, 0.88, 1.0)*a*1.6, 0.0); }`);
  const fvao = gl.createVertexArray();
  gl.bindVertexArray(fvao);
  attribs(buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);

  const rel = new Float32Array(3), qf = new Float32Array(4);
  function draw(g, cam, vp, firstPerson, jet) {
    rel[0] = g.pos[0] - cam.pos[0]; rel[1] = g.pos[1] - cam.pos[1]; rel[2] = g.pos[2] - cam.pos[2];
    qf[0] = g.q[0]; qf[1] = g.q[1]; qf[2] = g.q[2]; qf[3] = g.q[3];
    gl.useProgram(P.p); setEnv(P);
    gl.uniformMatrix4fv(P.u.uVPg, false, vp);
    gl.uniform4fv(P.u.uQ, qf); gl.uniform3fv(P.u.uPos, rel);
    gl.uniform1f(P.u.uFogOn, firstPerson ? 0 : 1);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, firstPerson ? FP_COUNT : ALL_COUNT, gl.UNSIGNED_SHORT, 0);
    if (jet > 0.02 && !firstPerson) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.useProgram(FP_.p);
      gl.uniformMatrix4fv(FP_.u.uVPg, false, vp);
      gl.uniform4fv(FP_.u.uQ, qf); gl.uniform3fv(FP_.u.uPos, rel);
      gl.uniform3fv(FP_.u.uCR, cam.r); gl.uniform3fv(FP_.u.uCU, cam.u);
      gl.uniform1f(FP_.u.uPow, jet); gl.uniform1f(FP_.u.uT, env.time);
      gl.bindVertexArray(fvao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }
  return { draw, HEAD: [0, 0.4, 0.0] };
})();
