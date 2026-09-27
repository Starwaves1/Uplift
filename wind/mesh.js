'use strict';
// ───────────────────────── Mesh: procedural geometry builder + standard lit shaders ─────────────────────────
// Vertex layout (13 floats): position xyz, normal xyz, color rgb, extra = (ao, sway, part, emissive)
//   ao       0..1 baked occlusion multiplier
//   sway     0..1 how much wind moves this vertex (instanced shader only)
//   part     integer id → uParts[id] rigid transform (static shader only, 0 = identity)
//   emissive 0..n self-lit amount (albedo * emissive is added)
// Model modules register themselves in MODELS with any of:
//   update(dt, ctx), drawOpaque(ctx), drawTransparent(ctx), hit(x, y, z) → bool, preview(ctx)
const MODELS = [];

const MESH = (() => {
  const { gl, program, buffer, env, setEnv } = GLX;
  const STRIDE = 13;

  // ── tiny vector helpers (arrays) ──
  const V3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  const colorAt = (c, ...args) => (typeof c === 'function' ? c(...args) : c);

  // 3×3 rotation helpers returning functions p → p'
  const rot = {
    x: a => { const c = Math.cos(a), s = Math.sin(a); return p => [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; },
    y: a => { const c = Math.cos(a), s = Math.sin(a); return p => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; },
    z: a => { const c = Math.cos(a), s = Math.sin(a); return p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; },
  };

  // ear-clipping triangulation for a simple 2D polygon [[x,y]...] (either winding)
  function earcut(poly) {
    const n = poly.length, idx = [...Array(n).keys()], out = [];
    let area = 0;
    for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const ccw = area > 0;
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inside = (p, a, b, c) => { const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let clipped = false;
      for (let k = 0; k < idx.length; k++) {
        const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
        const a = poly[ia], b = poly[ib], c = poly[ic];
        const cr = cross(a, b, c);
        if (ccw ? cr <= 1e-12 : cr >= -1e-12) continue;
        let ok = true;
        for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inside(poly[j], a, b, c)) { ok = false; break; } }
        if (!ok) continue;
        out.push(ccw ? [ia, ib, ic] : [ia, ic, ib]);
        idx.splice(k, 1); clipped = true; break;
      }
      if (!clipped) break;
    }
    if (idx.length === 3) out.push(ccw ? [idx[0], idx[1], idx[2]] : [idx[0], idx[2], idx[1]]);
    return out; // triangles CCW in the polygon's plane
  }

  class Builder {
    constructor() { this.v = []; this.i = []; }
    get count() { return this.v.length / STRIDE; }
    mark() { return { v: this.count, i: this.i.length }; }
    vert(p, n, c, ex) {
      ex = ex || [1, 0, 0, 0];
      this.v.push(p[0], p[1], p[2], n ? n[0] : 0, n ? n[1] : 1, n ? n[2] : 0, c[0], c[1], c[2], ex[0], ex[1], ex[2], ex[3]);
      return this.count - 1;
    }
    tri(a, b, c) { this.i.push(a, b, c); return this; }
    quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); return this; }

    // grid of rings: rings[k] = array of points; connects ring k→k+1. opts: closed (wrap ring), color(u,v,p), ex(u,v,p), flip
    rings(rings, opts = {}) {
      const m = this.mark(), R = rings.length, C = rings[0].length, closed = !!opts.closed;
      for (let k = 0; k < R; k++) for (let j = 0; j < C; j++) {
        const p = rings[k][j], u = closed ? j / C : j / Math.max(1, C - 1), v = k / Math.max(1, R - 1);
        this.vert(p, null, colorAt(opts.color || [0.8, 0.8, 0.8], u, v, p), opts.ex ? opts.ex(u, v, p) : null);
      }
      for (let k = 0; k < R - 1; k++) for (let j = 0; j < (closed ? C : C - 1); j++) {
        const a = m.v + k * C + j, b = m.v + k * C + (j + 1) % C, c = b + C, d = a + C;
        if (opts.flip) this.quad(a, d, c, b); else this.quad(a, b, c, d);
      }
      if (opts.smooth !== false) this.smooth(m);
      return m;
    }
    // tube along a path with per-point radius (number or [rx, ry]); parallel-transport frames
    tube(path, radii, opts = {}) {
      const sides = opts.sides || 10, rings = [];
      let prevN = null;
      for (let i = 0; i < path.length; i++) {
        const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
        const t = V3.norm(V3.sub(b, a));
        let n;
        if (!prevN) { const up = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]; n = V3.norm(V3.cross(t, up)); }
        else n = V3.norm(V3.sub(prevN, V3.mul(t, V3.dot(prevN, t))));
        prevN = n;
        const bn = V3.cross(t, n);
        const r = typeof radii === 'function' ? radii(i / (path.length - 1)) : Array.isArray(radii) ? radii[i] : radii;
        const rx = Array.isArray(r) ? r[0] : r, ry = Array.isArray(r) ? r[1] : r;
        const ring = [];
        for (let s = 0; s < sides; s++) {
          const ang = s / sides * Math.PI * 2 + (opts.twist || 0) * i;
          const c = Math.cos(ang) * rx, sn = Math.sin(ang) * ry;
          ring.push([path[i][0] + n[0] * c + bn[0] * sn, path[i][1] + n[1] * c + bn[1] * sn, path[i][2] + n[2] * c + bn[2] * sn]);
        }
        rings.push(ring);
      }
      const m = this.rings(rings, { closed: true, color: opts.color, ex: opts.ex, flip: !!opts.flip, smooth: true });
      if (opts.capStart) this.cap(rings[0], path[0], opts, true);
      if (opts.capEnd) this.cap(rings[rings.length - 1], path[path.length - 1], opts, false);
      return m;
    }
    cap(ring, center, opts, start) {
      const c0 = this.count;
      const n = V3.norm(V3.cross(V3.sub(ring[1], ring[0]), V3.sub(ring[2], ring[0])));
      const nn = start ? V3.mul(n, -1) : n;
      const col = colorAt(opts.color || [0.8, 0.8, 0.8], 0, start ? 0 : 1, center);
      const ce = this.vert(center, nn, col, opts.ex ? opts.ex(0, start ? 0 : 1, center) : null);
      for (const p of ring) this.vert(p, nn, col, opts.ex ? opts.ex(0, start ? 0 : 1, p) : null);
      for (let s = 0; s < ring.length; s++) {
        const a = c0 + 1 + s, b = c0 + 1 + (s + 1) % ring.length;
        if (start) this.tri(ce, a, b); else this.tri(ce, b, a);
      }
    }
    // surface of revolution around +Y: profile [[radius, y], ...] bottom→top
    lathe(profile, opts = {}) {
      const sides = opts.sides || 16, rings = [];
      for (const [r, y] of profile) {
        const ring = [];
        for (let s = 0; s < sides; s++) { const a = s / sides * Math.PI * 2; ring.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
        rings.push(ring);
      }
      return this.rings(rings, { closed: true, color: opts.color, ex: opts.ex, flip: !opts.flip });
    }
    // ellipsoid via UV sphere; disp(dir) → radius multiplier; color(dir, p)
    ellipsoid(c, r, opts = {}) {
      const seg = opts.seg || 14, st = opts.stacks || Math.max(6, Math.round(seg * 0.6)), rings = [];
      const rr = Array.isArray(r) ? r : [r, r, r];
      for (let k = 0; k <= st; k++) {
        const phi = -Math.PI / 2 + k / st * Math.PI, ring = [];
        for (let s = 0; s < seg; s++) {
          const th = s / seg * Math.PI * 2;
          const d = [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)];
          const m = opts.disp ? opts.disp(d) : 1;
          ring.push([c[0] + d[0] * rr[0] * m, c[1] + d[1] * rr[1] * m, c[2] + d[2] * rr[2] * m]);
        }
        rings.push(ring);
      }
      const dir = p => V3.norm([(p[0] - c[0]) / rr[0], (p[1] - c[1]) / rr[1], (p[2] - c[2]) / rr[2]]);
      return this.rings(rings, {
        closed: true, flip: !opts.flip,
        color: opts.color ? (u, v, p) => colorAt(opts.color, dir(p), p) : [0.8, 0.8, 0.8],
        ex: opts.ex ? (u, v, p) => opts.ex(dir(p), p) : null,
      });
    }
    // axis-aligned box with flat faces (then transform the returned mark if needed)
    box(c, size, opts = {}) {
      const m = this.mark(), [hx, hy, hz] = size.map(s => s / 2);
      const F = [
        [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
        [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
        [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
        [[0, -1, 0], [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]],
        [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
        [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
      ];
      for (const [n, q] of F) {
        const b = this.count;
        for (const p of q) { const wp = [c[0] + p[0], c[1] + p[1], c[2] + p[2]]; this.vert(wp, n, colorAt(opts.color || [0.8, 0.8, 0.8], n, wp), opts.ex ? opts.ex(n, wp) : null); }
        this.quad(b, b + 1, b + 2, b + 3);
      }
      return m;
    }
    // extrude a 2D polygon (XY plane) along +Z by depth, centred on z=0; flat shaded with caps
    extrude(poly, depth, opts = {}) {
      const m = this.mark(), h = depth / 2, col = opts.color || [0.8, 0.8, 0.8];
      const tris = earcut(poly);
      for (const z of [h, -h]) {
        const n = [0, 0, z > 0 ? 1 : -1], b = this.count;
        for (const p of poly) { const wp = [p[0], p[1], z]; this.vert(wp, n, colorAt(col, n, wp), opts.ex ? opts.ex(n, wp) : null); }
        for (const [a, bb, c] of tris) { if (z > 0) this.tri(b + a, b + bb, b + c); else this.tri(b + a, b + c, b + bb); }
      }
      let area = 0;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a[0] * b[1] - b[0] * a[1]; }
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        let n = V3.norm([b[1] - a[1], -(b[0] - a[0]), 0]);
        if (area < 0) n = V3.mul(n, -1);
        const q = [[a[0], a[1], -h], [b[0], b[1], -h], [b[0], b[1], h], [a[0], a[1], h]], s = this.count;
        for (const p of q) this.vert(p, n, colorAt(col, n, p), opts.ex ? opts.ex(n, p) : null);
        if (area > 0) this.quad(s, s + 1, s + 2, s + 3); else this.quad(s, s + 3, s + 2, s + 1);
      }
      return m;
    }

    // ── range operations (mark → end of buffer) ──
    each(m, fn) { for (let k = m.v; k < this.count; k++) fn(k * STRIDE, k); return this; }
    xform(m, fn) { // fn(p) → p' ; normals transformed by finite difference of fn
      return this.each(m, o => {
        const p = [this.v[o], this.v[o + 1], this.v[o + 2]], n = [this.v[o + 3], this.v[o + 4], this.v[o + 5]];
        const q = fn(p), e = 1e-3, qn = fn([p[0] + n[0] * e, p[1] + n[1] * e, p[2] + n[2] * e]);
        const nn = V3.norm(V3.sub(qn, q));
        this.v[o] = q[0]; this.v[o + 1] = q[1]; this.v[o + 2] = q[2];
        this.v[o + 3] = nn[0]; this.v[o + 4] = nn[1]; this.v[o + 5] = nn[2];
      });
    }
    translate(m, x, y, z) { return this.each(m, o => { this.v[o] += x; this.v[o + 1] += y; this.v[o + 2] += z; }); }
    rotate(m, axis, a, pivot) {
      const f = rot[axis](a), pv = pivot || [0, 0, 0];
      return this.each(m, o => {
        const p = f([this.v[o] - pv[0], this.v[o + 1] - pv[1], this.v[o + 2] - pv[2]]), n = f([this.v[o + 3], this.v[o + 4], this.v[o + 5]]);
        this.v[o] = p[0] + pv[0]; this.v[o + 1] = p[1] + pv[1]; this.v[o + 2] = p[2] + pv[2];
        this.v[o + 3] = n[0]; this.v[o + 4] = n[1]; this.v[o + 5] = n[2];
      });
    }
    scale(m, sx, sy, sz) {
      return this.each(m, o => {
        this.v[o] *= sx; this.v[o + 1] *= sy; this.v[o + 2] *= sz;
        const n = V3.norm([this.v[o + 3] / sx, this.v[o + 4] / sy, this.v[o + 5] / sz]);
        this.v[o + 3] = n[0]; this.v[o + 4] = n[1]; this.v[o + 5] = n[2];
      });
    }
    setEx(m, fn) { return this.each(m, o => { const e = fn([this.v[o], this.v[o + 1], this.v[o + 2]], [this.v[o + 9], this.v[o + 10], this.v[o + 11], this.v[o + 12]]); for (let q = 0; q < 4; q++) this.v[o + 9 + q] = e[q]; }); }
    setColor(m, fn) { return this.each(m, o => { const c = fn([this.v[o], this.v[o + 1], this.v[o + 2]], [this.v[o + 3], this.v[o + 4], this.v[o + 5]], [this.v[o + 6], this.v[o + 7], this.v[o + 8]]); this.v[o + 6] = c[0]; this.v[o + 7] = c[1]; this.v[o + 8] = c[2]; }); }
    // duplicate a range mirrored across x=0 (winding flipped)
    mirrorX(m) {
      const vs = this.count, base = this.count - m.v;
      for (let k = m.v; k < vs; k++) {
        const o = k * STRIDE, row = this.v.slice(o, o + STRIDE);
        row[0] = -row[0]; row[3] = -row[3];
        this.v.push(...row);
      }
      const ie = this.i.length;
      for (let t = m.i; t < ie; t += 3) this.i.push(this.i[t] + base, this.i[t + 2] + base, this.i[t + 1] + base);
      return this;
    }
    // smooth normals for triangles added since mark
    smooth(m) {
      for (let k = m.v; k < this.count; k++) { const o = k * STRIDE; this.v[o + 3] = this.v[o + 4] = this.v[o + 5] = 0; }
      for (let t = m.i; t < this.i.length; t += 3) {
        const a = this.i[t] * STRIDE, b = this.i[t + 1] * STRIDE, c = this.i[t + 2] * STRIDE;
        const ux = this.v[b] - this.v[a], uy = this.v[b + 1] - this.v[a + 1], uz = this.v[b + 2] - this.v[a + 2];
        const vx = this.v[c] - this.v[a], vy = this.v[c + 1] - this.v[a + 1], vz = this.v[c + 2] - this.v[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { this.v[o + 3] += nx; this.v[o + 4] += ny; this.v[o + 5] += nz; }
      }
      for (let k = m.v; k < this.count; k++) {
        const o = k * STRIDE, l = Math.hypot(this.v[o + 3], this.v[o + 4], this.v[o + 5]);
        if (l > 1e-12) { this.v[o + 3] /= l; this.v[o + 4] /= l; this.v[o + 5] /= l; } else this.v[o + 4] = 1;
      }
      return this;
    }
    // unweld a range so every triangle is flat-shaded (faceted look)
    facet(m) {
      const tris = this.i.splice(m.i), src = this.v.slice();
      for (let t = 0; t < tris.length; t += 3) {
        const ids = [tris[t], tris[t + 1], tris[t + 2]], P = ids.map(id => src.slice(id * STRIDE, id * STRIDE + STRIDE));
        const n = V3.norm(V3.cross(V3.sub(P[1], P[0]), V3.sub(P[2], P[0])));
        const b = this.count;
        for (const row of P) { row[3] = n[0]; row[4] = n[1]; row[5] = n[2]; this.v.push(...row); }
        this.tri(b, b + 1, b + 2);
      }
      return this;
    }
    append(other, fn) {
      const base = this.count, m = this.mark();
      this.v.push(...other.v);
      for (const i of other.i) this.i.push(i + base);
      if (fn) this.xform(m, fn);
      return m;
    }
    bounds() {
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let o = 0; o < this.v.length; o += STRIDE) for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], this.v[o + q]); hi[q] = Math.max(hi[q], this.v[o + q]); }
      return { lo, hi };
    }
    upload() {
      const vbo = buffer(new Float32Array(this.v));
      const ibo = buffer(new Uint32Array(this.i), gl.ELEMENT_ARRAY_BUFFER);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      return { vbo, ibo, count: this.i.length, verts: this.count, bounds: this.bounds() };
    }
  }

  // ── shaders ──
  const LIGHT = `
uniform float uSpec, uNoFog;
// ambient: the sky dome above, sunlit ground below (scene-linear, see core.js)
vec3 ambientLight(vec3 n){
  vec3 ground = (uSunCol*max(uSun.y, 0.0) + uAmb)*vec3(0.16, 0.2, 0.12);
  return mix(ground, uAmb, n.y*0.5 + 0.5);
}
// alb is linear albedo. foliage > 0 wraps light around the terminator and lets it through leaves toward the sun.
// uSpec is a gloss amount: 0 = matte, ~0.2 = satin paint, ~0.5 = varnish/glass.
vec3 lightMesh(vec3 alb, vec3 n, vec3 v, float ao, float emit, float foliage){
  float nl = dot(n, uSun);
  float wrap = foliage*0.4;
  float diff = clamp((nl + wrap)/(1.0 + wrap), 0.0, 1.0);
  float occ = mix(1.0, ao, 0.6); // baked AO also stands in for local self-shadowing of the sun
  vec3 sun = uSunCol*gShadow;
  vec3 col = alb*(sun*diff*occ + ambientLight(n)*ao);
  col += alb*sun*pow(max(dot(v, uSun), 0.0), 4.0)*1.2*foliage*ao;
  // Schlick Fresnel sky reflection + normalised Blinn-Phong sun highlight (dielectric, F0 = 0.04)
  float nv = max(dot(-v, n), 0.0);
  float g = clamp(uSpec*2.5, 0.0, 1.0);
  float F = 0.04 + 0.96*pow(1.0 - nv, 5.0);
  col += skyCol(reflect(v, n))*F*mix(0.25, 1.0, g)*ao;
  vec3 h = normalize(uSun - v);
  float p = mix(12.0, 400.0, g*g);
  float Fh = 0.04 + 0.96*pow(1.0 - max(dot(h, uSun), 0.0), 5.0);
  col += sun*Fh*(p + 8.0)*0.125*pow(max(dot(n, h), 0.0), p)*max(nl, 0.0)*occ*mix(0.3, 1.0, g);
  return col + alb*emit*4.0;
}
float bayer4(vec2 p){ ivec2 q = ivec2(p) & 3; int x = q.x, y = q.y, xy = x ^ y;
  return (float(((xy&1)<<3)|((y&1)<<2)|(xy&2)|((y&2)>>1)) + 0.5)/16.0; }
`;
  const FS = GLSL_COMMON + LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec4 vEx; in float vFade; out vec4 o;
void main(){
  if (vFade < 0.999 && bayer4(gl_FragCoord.xy) > vFade) discard;
  if (uShadowPass > 0.5) { o = vec4(0.0); return; }
  vec3 n = normalize(vN); vec3 v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;
  gShadow = sunShadow(vRel, n);
  vec3 col = lightMesh(toLin(vCol), n, v, vEx.x, vEx.w, min(vEx.y*2.0, 1.0));
  if (uNoFog < 0.5) col = fogIt(col, vRel);
  o = vec4(col, 1.0);
}`;
  // single mesh, quaternion + position, rigid part matrices
  const STATIC = program(GLSL_COMMON + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
uniform mat4 uVPm; uniform vec4 uQ; uniform vec3 uPos; uniform float uScale; uniform mat4 uParts[24];
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec4 vEx; out float vFade;
vec3 qrot(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz, v) + q.w*v); }
void main(){
  mat4 pm = uParts[int(aX.z + 0.5)];
  vec3 lp = (pm*vec4(aP, 1.0)).xyz, ln = mat3(pm)*aN;
  vec3 p = qrot(uQ, lp*uScale) + uPos;
  vN = qrot(uQ, ln); vCol = aC; vRel = p; vEx = aX; vFade = 1.0;
  gl_Position = uVPm*vec4(p, 1.0);
}`, FS);
  // instanced: inst0 = (x, y, z, scale) world; inst1 = (rotY, tint, seed, unused)
  const INST = program(GLSL_COMMON + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
layout(location=4) in vec4 iA; layout(location=5) in vec4 iB;
uniform mat4 uVP; uniform vec2 uFade; uniform float uSway;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec4 vEx; out float vFade;
void main(){
  float c = cos(iB.x), s = sin(iB.x);
  vec3 lp = aP*iA.w;
  vec3 p = vec3(lp.x*c + lp.z*s, lp.y, -lp.x*s + lp.z*c);
  vec3 n = vec3(aN.x*c + aN.z*s, aN.y, -aN.x*s + aN.z*c);
  if (aX.y > 0.0) {
    float t = uTime*1.6 + iB.z*6.2831 + (iA.x + iA.z)*0.02;
    vec2 wd = vec2(0.917, 0.4);
    float amt = (sin(t) *0.6 + sin(t*2.3 + p.y*0.4)*0.25 + sin(t*5.1 + p.x)*0.08)*aX.y*uSway*iA.w;
    p.xz += wd*amt; p.y -= abs(amt)*0.15;
  }
  vec3 rel = iA.xyz + p - uCam;
  vec3 tint = mix(vec3(0.86, 0.9, 0.95), vec3(1.12, 1.08, 0.86), iB.y);
  vN = n; vCol = aC*tint; vRel = rel; vEx = aX;
  float d = length(iA.xz - uCam.xz);
  float fin = uFade.x > 0.0 ? clamp((d - uFade.x + 30.0)/30.0, 0.0, 1.0) : 1.0;
  float fout = uFade.y > 0.0 ? clamp((uFade.y - d)/30.0, 0.0, 1.0) : 1.0;
  vFade = min(fin, fout);
  gl_Position = uVP*vec4(rel, 1.0);
}`, FS);

  const IDENT = new Float32Array(16 * 24);
  for (let k = 0; k < 24; k++) { IDENT[k * 16] = IDENT[k * 16 + 5] = IDENT[k * 16 + 10] = IDENT[k * 16 + 15] = 1; }
  function vao(mesh, inst) {
    const a = gl.createVertexArray();
    gl.bindVertexArray(a);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    const L = [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]];
    for (const [loc, size, off] of L) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4); gl.vertexAttribDivisor(loc, 0); }
    if (inst) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      for (const [loc, off] of [[4, 0], [5, 4]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off * 4); gl.vertexAttribDivisor(loc, 1); }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    return a;
  }

  // draw one mesh: q = quaternion [x,y,z,w], pos = WORLD position, parts = Float32Array(16*n) or null
  const posRel = new Float32Array(3), qv = new Float32Array(4);
  function drawStatic(mesh, vp, q, pos, scale, opts = {}) {
    if (!mesh.vaoS) mesh.vaoS = vao(mesh, null);
    gl.useProgram(STATIC.p); setEnv(STATIC);
    gl.uniformMatrix4fv(STATIC.u.uVPm, false, vp || env.vp);
    qv[0] = q[0]; qv[1] = q[1]; qv[2] = q[2]; qv[3] = q[3];
    posRel[0] = pos[0] - env.cam[0]; posRel[1] = pos[1] - env.cam[1]; posRel[2] = pos[2] - env.cam[2];
    gl.uniform4fv(STATIC.u.uQ, qv); gl.uniform3fv(STATIC.u.uPos, posRel); gl.uniform1f(STATIC.u.uScale, scale || 1);
    gl.uniformMatrix4fv(STATIC.u.uParts, false, opts.parts || IDENT);
    gl.uniform1f(STATIC.u.uSpec, opts.spec != null ? opts.spec : 0.15);
    gl.uniform1f(STATIC.u.uNoFog, opts.noFog ? 1 : 0);
    gl.bindVertexArray(mesh.vaoS);
    gl.drawElements(gl.TRIANGLES, opts.count || mesh.count, gl.UNSIGNED_INT, 0);
  }
  // instance set: n instances of 8 floats; set(i, x,y,z, scale, rotY, tint, seed)
  function instances(mesh, max) {
    const data = new Float32Array(max * 8), buf = buffer(data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const set = { mesh, max, data, buf, n: 0, vao: vao(mesh, buf), dirty: true,
      clear() { this.n = 0; this.dirty = true; },
      push(x, y, z, s, r, tint, seed) {
        if (this.n >= this.max) return;
        const o = this.n++ * 8; data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = s;
        data[o + 4] = r; data[o + 5] = tint; data[o + 6] = seed; data[o + 7] = 0; this.dirty = true;
      },
    };
    return set;
  }
  // fade = [near, far]: dithered cross-fade in over [near-30, near], out over [far-30, far]; near<=0 → no fade-in
  function drawInstances(set, opts = {}) {
    if (!set.n) return;
    if (set.dirty) { gl.bindBuffer(gl.ARRAY_BUFFER, set.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, set.data, 0, set.n * 8); set.dirty = false; }
    gl.useProgram(INST.p); setEnv(INST);
    const f = opts.fade || [0, 0];
    gl.uniform2f(INST.u.uFade, f[0], f[1]);
    gl.uniform1f(INST.u.uSway, opts.sway != null ? opts.sway : 1);
    gl.uniform1f(INST.u.uSpec, opts.spec != null ? opts.spec : 0.05);
    gl.uniform1f(INST.u.uNoFog, 0);
    gl.bindVertexArray(set.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, set.mesh.count, gl.UNSIGNED_INT, 0, set.n);
  }
  // rigid part matrix helpers (column-major mat4) for drawStatic opts.parts
  function partMatrix(out, k, quat, pivot, offset) {
    const [x, y, z, w] = quat, o = k * 16;
    const m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - z * w), m02 = 2 * (x * z + y * w);
    const m10 = 2 * (x * y + z * w), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - x * w);
    const m20 = 2 * (x * z - y * w), m21 = 2 * (y * z + x * w), m22 = 1 - 2 * (x * x + y * y);
    const px = pivot ? pivot[0] : 0, py = pivot ? pivot[1] : 0, pz = pivot ? pivot[2] : 0;
    const ox = offset ? offset[0] : 0, oy = offset ? offset[1] : 0, oz = offset ? offset[2] : 0;
    out[o] = m00; out[o + 1] = m10; out[o + 2] = m20; out[o + 3] = 0;
    out[o + 4] = m01; out[o + 5] = m11; out[o + 6] = m21; out[o + 7] = 0;
    out[o + 8] = m02; out[o + 9] = m12; out[o + 10] = m22; out[o + 11] = 0;
    out[o + 12] = px - (m00 * px + m01 * py + m02 * pz) + ox;
    out[o + 13] = py - (m10 * px + m11 * py + m12 * pz) + oy;
    out[o + 14] = pz - (m20 * px + m21 * py + m22 * pz) + oz;
    out[o + 15] = 1;
    return out;
  }
  const newParts = () => IDENT.slice();

  return { Builder, V3, rot, earcut, drawStatic, instances, drawInstances, partMatrix, newParts, LIGHT, STRIDE };
})();
