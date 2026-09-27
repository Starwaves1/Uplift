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
function vn(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

// terrain height (meters). det fades the finest octaves with distance on the GPU; CPU uses 1.
function terrainH(x, z, det) {
  const wx = vn(x * 0.00035 + 3.1, z * 0.00035 + 1.7) - 0.5;
  const wz = vn(x * 0.00035 + 8.3, z * 0.00035 + 4.9) - 0.5;
  const px = x + wx * 1100, pz = z + wz * 1100;
  const c = (0.5 * vn(px * 0.00015 + 0.5, pz * 0.00015 + 0.5) + 0.25 * vn(px * 0.0003 + 2.1, pz * 0.0003 + 7.3)
    + 0.125 * vn(px * 0.0006 + 4.4, pz * 0.0006 + 1.9)) / 0.875;
  const land = ss(0.3, 0.5, c), high = ss(0.52, 0.8, c);
  let hl = 0, amp = 0.5, f = 1 / 1100;
  for (let i = 0; i < 4; i++) { hl += amp * vn(px * f + 11.5, pz * f + 2.2); f *= 2.07; amp *= 0.5; }
  hl /= 0.9375;
  let rg = 0; amp = 0.5; f = 1 / 2600;
  for (let i = 0; i < 4; i++) { let n = 1 - Math.abs(vn(px * f + 5.3, pz * f + 9.1) * 2 - 1); rg += amp * n * n; f *= 2.1; amp *= 0.5; }
  rg /= 0.9375;
  const vly = Math.abs(vn(px * 0.00036 + 1.9, pz * 0.00036 + 6.4) - 0.5);
  const valley = 1 - ss(0, 0.075, vly);
  let h = -55 + land * 80 + land * hl * 130 + high * (rg * rg * 950 + hl * 140);
  h -= valley * (35 * land + 420 * high);
  if (det > 0) {
    let d = 0; amp = 0.5; f = 1 / 160;
    for (let i = 0; i < 3; i++) { d += amp * (vn(px * f + 3.3, pz * f + 7.1) - 0.5); f *= 2.1; amp *= 0.5; }
    h += det * d * 24 * (0.35 + land);
  }
  return h;
}
function forestMask(x, z) {
  return ss(0.54, 0.66, vn(x * 0.0021 + 7.7, z * 0.0021 + 3.3) * 0.7 + vn(x * 0.009 + 1.1, z * 0.009 + 9.9) * 0.3);
}
const groundH = (x, z) => Math.max(terrainH(x, z, 1), 0);
function terrainN(x, z, out) {
  const e = 1.5, h = terrainH(x, z, 1);
  const nx = h - terrainH(x + e, z, 1), nz = h - terrainH(x, z + e, 1);
  const l = Math.hypot(nx, e, nz);
  out[0] = nx / l; out[1] = e / l; out[2] = nz / l;
  return out;
}

const GLSL_COMMON = `
float hash2(ivec2 p){
  uint h = uint(p.x)*374761393u + uint(p.y)*668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u; h = h ^ (h >> 16u);
  return float(h & 16777215u) / 16777216.0;
}
float vn(vec2 p){
  vec2 i = floor(p), f = p - i;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  ivec2 ii = ivec2(i);
  float a = hash2(ii), b = hash2(ii+ivec2(1,0)), c = hash2(ii+ivec2(0,1)), d = hash2(ii+ivec2(1,1));
  return a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
}
float terrainH(vec2 q, float det){
  float wx = vn(q*0.00035 + vec2(3.1,1.7)) - 0.5;
  float wz = vn(q*0.00035 + vec2(8.3,4.9)) - 0.5;
  vec2 p = q + vec2(wx, wz)*1100.0;
  float c = (0.5*vn(p*0.00015+vec2(0.5)) + 0.25*vn(p*0.0003+vec2(2.1,7.3)) + 0.125*vn(p*0.0006+vec2(4.4,1.9))) / 0.875;
  float land = smoothstep(0.3, 0.5, c), high = smoothstep(0.52, 0.8, c);
  float hl = 0.0, amp = 0.5, f = 1.0/1100.0;
  for (int i=0;i<4;i++){ hl += amp*vn(p*f + vec2(11.5,2.2)); f *= 2.07; amp *= 0.5; }
  hl /= 0.9375;
  float rg = 0.0; amp = 0.5; f = 1.0/2600.0;
  for (int i=0;i<4;i++){ float n = 1.0 - abs(vn(p*f + vec2(5.3,9.1))*2.0-1.0); rg += amp*n*n; f *= 2.1; amp *= 0.5; }
  rg /= 0.9375;
  float vly = abs(vn(p*0.00036 + vec2(1.9,6.4)) - 0.5);
  float valley = 1.0 - smoothstep(0.0, 0.075, vly);
  float h = -55.0 + land*80.0 + land*hl*130.0 + high*(rg*rg*950.0 + hl*140.0);
  h -= valley*(35.0*land + 420.0*high);
  if (det > 0.0) {
    float d = 0.0; amp = 0.5; f = 1.0/160.0;
    for (int i=0;i<3;i++){ d += amp*(vn(p*f + vec2(3.3,7.1)) - 0.5); f *= 2.1; amp *= 0.5; }
    h += det*d*24.0*(0.35 + land);
  }
  return h;
}
float forestMask(vec2 p){
  return smoothstep(0.54, 0.66, vn(p*0.0021 + vec2(7.7,3.3))*0.7 + vn(p*0.009 + vec2(1.1,9.9))*0.3);
}
uniform vec3 uSun, uSunCol, uZen, uHor, uAmb, uCam;
uniform float uFog, uTime;
vec3 skyCol(vec3 d){
  float y = d.y;
  vec3 col = mix(uHor, uZen, pow(clamp(y,0.0,1.0), 0.48));
  col = mix(col, uHor*0.86 + uAmb*0.1, clamp(-y*5.0, 0.0, 1.0));
  float s = max(dot(d, uSun), 0.0);
  col += uSunCol*(pow(s, 5.0)*0.16 + pow(s, 48.0)*0.32);
  return col;
}
vec3 fogIt(vec3 col, vec3 rel){
  float d = length(rel);
  float hgt = max(uCam.y + rel.y*0.5, 0.0);
  float f = 1.0 - exp(-d*uFog*(0.45 + 0.55*exp(-hgt*0.0012)));
  return mix(col, skyCol(rel/max(d,1e-3)), clamp(f, 0.0, 1.0));
}
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
};

// ── GL ──
const GLX = (() => {
  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', {
    antialias: (window.devicePixelRatio || 1) < 1.6, alpha: false, depth: true, stencil: false,
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
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + fs));
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
    vp: new Float32Array(16),
  };
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
  }
  return { gl, canvas, program, buffer, attribs, env, setEnv };
})();
