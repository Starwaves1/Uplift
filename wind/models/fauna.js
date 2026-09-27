'use strict';
// ───────────────────────── Fauna: swallow & gull flocks (boids, scatter), grazing sheep ─────────────────────────
// Birds: two instanced meshes; wings flap/fold/sweep in the vertex shader from per-instance phase, amplitude and fold.
//   Flocks (boids: cohesion, alignment, separation, wander) spawn/recycle 200–900 m around the camera:
//   swallows dart low over meadows, gulls patrol water/coasts or circle in thermals, some flocks cross the flight path.
//   Birds within ~30 m of the glider's path panic and scatter (panic spreads through the flock).
// Sheep: deterministic flocks on flat, open grass (hash2 cells); head grazing / looking-up and tail wag in the shader,
//   they lift their heads and watch when the glider passes low. Two LODs share one instance buffer.
// Butterflies: up to 40 flutter over meadows ahead of the camera while the glider is below ~35 m (bird shader, palette mode).
const FAUNA = (() => {
  const { gl, program, buffer, env, setEnv } = GLX;
  const STRIDE = MESH.STRIDE, TAU = Math.PI * 2;
  const rnd = Math.random;

  // cubic Hermite through [[t, v0, v1...], ...] with Catmull-Rom tangents
  function spline(pts, t) {
    const n = pts.length;
    if (t <= pts[0][0]) return pts[0].slice(1);
    if (t >= pts[n - 1][0]) return pts[n - 1].slice(1);
    let k = 1;
    while (pts[k][0] < t) k++;
    const p0 = pts[Math.max(k - 2, 0)], p1 = pts[k - 1], p2 = pts[k], p3 = pts[Math.min(k + 1, n - 1)];
    const h = p2[0] - p1[0], u = (t - p1[0]) / h, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const out = [];
    for (let q = 1; q < p1.length; q++) {
      const m1 = (p2[q] - p0[q]) / ((p2[0] - p0[0]) || 1) * h, m2 = (p3[q] - p1[q]) / ((p3[0] - p1[0]) || 1) * h;
      out.push(h00 * p1[q] + h10 * m1 + h01 * p2[q] + h11 * m2);
    }
    return out;
  }
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // ═════════════════ bird meshes ═════════════════
  // model space: +Z forward (beak), +Y up, +X right wing. extra.z part: 0 body, 1 wing, 2 tail
  const AF = [[0, 0], [0.07, 0.72], [0.3, 1], [0.66, 0.55], [1, 0], [0.66, -0.08], [0.3, -0.22], [0.07, -0.3]];
  function buildBird(o) {
    const b = new MESH.Builder();
    // body: tube along z with an elliptic profile [[z, y, rx, ry]]
    const pr = o.body, z0 = pr[0][0], z1 = pr[pr.length - 1][0], N = o.rings, path = [], rad = [];
    for (let k = 0; k <= N; k++) {
      const z = z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos(Math.PI * k / N));
      const [y, rx, ry] = spline(pr, z);
      path.push([0, y, z]); rad.push([Math.max(rx, 0.004), Math.max(ry, 0.004)]);
    }
    const rel = p => { const s = spline(pr, p[2]); return (p[1] - s[0]) / Math.max(s[2], 1e-3); };
    b.tube(path, rad, {
      sides: o.sides, capStart: true, capEnd: true,
      color: (u, v, p) => o.bodyCol(p, rel(p)),
      ex: (u, v, p) => [o.bodyAO(p, rel(p)), 0, 0, 0],
    });
    // beak
    const bk = o.beak;
    b.tube([[0, bk.y, bk.z], [0, bk.y - bk.len * 0.03, bk.z + bk.len * 0.55], [0, bk.y - bk.len * bk.hook, bk.z + bk.len]],
      [[bk.r, bk.r * 0.85], [bk.r * 0.55, bk.r * 0.5], [0.004, 0.004]],
      { sides: 7, capStart: true, color: (u, v, p) => bk.col(p, (p[2] - bk.z) / bk.len), ex: () => [0.95, 0, 0, 0] });
    // tail: flat plate in the XZ plane (poly given as [x, z])
    const tl = o.tail;
    const tm = b.extrude(tl.poly, tl.th, { color: (n, p) => tl.col(p[0], p[1]), ex: (n, p) => [0.8 + 0.2 * Math.min(1, (tl.poly[0][1] - p[1]) * 2), 0, 2, 0] });
    b.rotate(tm, 'x', Math.PI / 2);
    b.rotate(tm, 'x', tl.tilt || 0, [0, 0, tl.poly[0][1]]);
    b.translate(tm, 0, tl.y, 0);
    // right-side parts, mirrored: wing + eye
    const mR = b.mark();
    const W = o.wing, rings = [], span = W.st[W.st.length - 1][0];
    for (const [s, le, te, t, dy] of W.st) {
      const c = le - te, ring = [];
      for (const [f, h] of AF) ring.push([W.x0 + s, W.y0 + dy + h * t, le - f * c]);
      rings.push(ring);
    }
    b.rings(rings, {
      closed: true,
      color: (u, v, p) => { const j = Math.round(u * 8) % 8; return W.col((p[0] - W.x0) / span, j >= 1 && j <= 3 ? 1 : j >= 5 ? 0 : 0.5, AF[j][0], p); },
      ex: (u, v, p) => { const j = Math.round(u * 8) % 8, s = (p[0] - W.x0) / span; return [(0.72 + 0.28 * Math.min(1, s * 3)) * (j >= 5 ? 0.9 : 1), 0, 1, 0]; },
    });
    const E = o.eye;
    b.ellipsoid(E.c, E.r, { seg: 7, stacks: 4, color: [0.035, 0.03, 0.03], ex: () => [1, 0, 0, 0] });
    b.ellipsoid([E.c[0] + E.r * 0.5, E.c[1] + E.r * 0.42, E.c[2] + E.r * 0.5], E.r * 0.32, { seg: 4, stacks: 2, color: [1, 1, 1], ex: () => [1, 0, 0, 1.3] });
    if (E.ring) b.ellipsoid([E.c[0] - E.r * 0.3, E.c[1], E.c[2]], [E.r, E.r * 1.35, E.r * 1.35], { seg: 7, stacks: 4, color: E.ring, ex: () => [1, 0, 0, 0] });
    b.mirrorX(mR);
    const m = b.upload();
    m.tris = m.count / 3;
    return m;
  }

  // swallow: glossy blue-black back, rust face, cream belly, long crescent wings, forked tail
  const SWALLOW = buildBird({
    rings: 14, sides: 12,
    body: [[-0.46, 0.0, 0.02, 0.02], [-0.38, 0.0, 0.07, 0.06], [-0.2, 0.0, 0.12, 0.12], [0.0, 0.0, 0.15, 0.15], [0.16, 0.02, 0.14, 0.14],
      [0.25, 0.04, 0.125, 0.125], [0.33, 0.05, 0.13, 0.13], [0.42, 0.045, 0.1, 0.1], [0.48, 0.035, 0.05, 0.05], [0.5, 0.03, 0.012, 0.012]],
    bodyCol: (p, h) => {
      const back = [0.1, 0.15, 0.34], belly = [0.9, 0.83, 0.7], rust = [0.78, 0.33, 0.17];
      let c = mix3(belly, back, ss(-0.25, 0.25, h + 0.1 * p[2]));
      const face = ss(0.24, 0.34, p[2]) * (1 - ss(0.15, 0.55, h));
      c = mix3(c, rust, face);
      return mix3(c, [0.13, 0.17, 0.33], ss(0.4, 0.6, p[2]) * ss(-0.1, 0.4, h) * 0.6);
    },
    bodyAO: (p, h) => 0.7 + 0.3 * ss(-1, 0.3, h),
    beak: { z: 0.46, y: 0.025, len: 0.1, r: 0.035, hook: 0.08, col: () => [0.12, 0.1, 0.1] },
    tail: {
      y: 0.0, th: 0.02, tilt: 0.06,
      poly: [[0.07, -0.34], [0.12, -0.55], [0.23, -0.98], [0.18, -0.95], [0.07, -0.66], [0, -0.6], [-0.07, -0.66], [-0.18, -0.95], [-0.23, -0.98], [-0.12, -0.55], [-0.07, -0.34]],
      col: () => [0.1, 0.13, 0.28],
    },
    wing: {
      x0: 0.08, y0: 0.06,
      st: [[0, 0.2, -0.13, 0.07, 0], [0.14, 0.2, -0.16, 0.06, 0.01], [0.36, 0.16, -0.18, 0.05, 0.01], [0.55, 0.09, -0.2, 0.04, 0],
        [0.74, -0.02, -0.24, 0.03, -0.01], [0.9, -0.15, -0.3, 0.02, -0.02], [1.03, -0.32, -0.38, 0.01, -0.03], [1.1, -0.46, -0.47, 0.004, -0.035]],
      col: (s, top, f) => {
        if (top === 1) return mix3([0.12, 0.17, 0.36], [0.06, 0.07, 0.12], ss(0.3, 1, s) * 0.7 + f * 0.2);
        if (top === 0) return mix3([0.62, 0.58, 0.52], [0.22, 0.22, 0.26], ss(0.35, 0.95, s));
        return f < 0.5 ? [0.1, 0.13, 0.28] : [0.3, 0.3, 0.34];
      },
    },
    eye: { c: [0.1, 0.078, 0.35], r: 0.038 },
  });
  // gull: soft white body, dove-grey mantle, black wingtips with white dots, yellow beak with red spot
  const GULL = buildBird({
    rings: 14, sides: 12,
    body: [[-0.5, 0.0, 0.02, 0.02], [-0.42, 0.0, 0.07, 0.06], [-0.22, -0.01, 0.13, 0.13], [0.0, -0.01, 0.16, 0.16], [0.18, 0.03, 0.135, 0.14],
      [0.28, 0.07, 0.108, 0.11], [0.38, 0.09, 0.13, 0.125], [0.47, 0.085, 0.1, 0.095], [0.53, 0.075, 0.045, 0.045], [0.55, 0.07, 0.012, 0.012]],
    bodyCol: (p, h) => mix3([0.8, 0.8, 0.78], [0.74, 0.77, 0.8], ss(0, 0.8, h) * ss(0.1, -0.2, p[2])),
    bodyAO: (p, h) => 0.68 + 0.32 * ss(-1, 0.3, h),
    beak: { z: 0.5, y: 0.068, len: 0.17, r: 0.035, hook: 0.2, col: (p, t) => (t > 0.62 && t < 0.86 && p[1] < 0.02 ? [0.8, 0.16, 0.1] : [0.95, 0.76, 0.22]) },
    tail: {
      y: 0.0, th: 0.022, tilt: 0.05,
      poly: [[0.06, -0.38], [0.13, -0.58], [0.1, -0.68], [0, -0.7], [-0.1, -0.68], [-0.13, -0.58], [-0.06, -0.38]],
      col: () => [0.79, 0.79, 0.77],
    },
    wing: {
      x0: 0.1, y0: 0.05,
      st: [[0, 0.17, -0.22, 0.08, 0], [0.3, 0.17, -0.25, 0.07, 0.015], [0.66, 0.15, -0.23, 0.056, 0.025], [0.95, 0.1, -0.18, 0.042, 0.02],
        [1.2, 0.02, -0.15, 0.032, 0.005], [1.42, -0.09, -0.17, 0.018, -0.01], [1.58, -0.2, -0.22, 0.006, -0.02], [1.63, -0.25, -0.26, 0.003, -0.022]],
      col: (s, top, f, p) => {
        const tip = ss(0.7, 0.76, s), spot = (s > 0.84 && s < 0.9 && f > 0.25 && f < 0.7) ? 1 : 0;
        const tipC = spot ? [0.8, 0.8, 0.78] : [0.09, 0.09, 0.1];
        if (top === 1) return mix3(mix3([0.5, 0.55, 0.62], [0.72, 0.74, 0.76], ss(0.62, 0.9, f) * (1 - tip)), tipC, tip);
        if (top === 0) return mix3([0.8, 0.8, 0.79], tipC, ss(0.74, 0.8, s));
        return f < 0.5 ? mix3([0.62, 0.66, 0.7], tipC, tip) : mix3([0.78, 0.78, 0.77], tipC, tip);
      },
    },
    eye: { c: [0.1, 0.12, 0.41], r: 0.03, ring: [0.85, 0.45, 0.2] },
  });

  // ═════════════════ sheep meshes ═════════════════
  // model space: +Z forward, feet at y=0. parts: 0 body/legs, 3 head (pivot HEADP), 4 tail. extra.y = wool flag
  const HEADP = [0, 0.58, 0.33], TAILP = [0, 0.6, -0.55];
  function buildSheep(lo) {
    const b = new MESH.Builder();
    const WOOL = [0.72, 0.69, 0.61], FACE = [0.15, 0.12, 0.11], LEG = [0.13, 0.11, 0.1];
    const bumps = [];
    const NB = lo ? 10 : 30;
    for (let k = 0; k < NB; k++) {
      const y = 1 - 2 * (k + 0.5) / NB, r = Math.sqrt(1 - y * y), a = k * 2.39996 + 0.4;
      bumps.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    const alpha = lo ? 0.9 : 0.5;
    const lump = d => {
      let m = 0;
      for (const c of bumps) {
        const q = d[0] * c[0] + d[1] * c[1] + d[2] * c[2];
        const a = Math.acos(Math.min(1, q)) / alpha;
        if (a < 1) m = Math.max(m, Math.sqrt(1 - a * a));
      }
      return m;
    };
    const woolCol = (d, m) => mix3(mix3(WOOL, [0.62, 0.57, 0.48], 0.35 * (1 - m)), [0.76, 0.74, 0.68], ss(0.2, 0.9, d[1]) * 0.5);
    // body
    b.ellipsoid([0, 0.6, -0.03], [0.37, 0.3, 0.54], {
      seg: lo ? 12 : 24, stacks: lo ? 8 : 15,
      disp: d => (1 + (lo ? 0.06 : 0.14) * lump(d)) * (d[1] < -0.5 ? 1 - (-0.5 - d[1]) * 0.3 : 1),
      color: d => woolCol(d, lump(d)),
      ex: d => [(0.5 + 0.5 * ss(-0.95, 0.45, d[1])) * (0.82 + 0.18 * lump(d)), 1, 0, 0],
    });
    // tail
    b.ellipsoid([0, 0.58, -0.6], [0.07, 0.1, 0.07], { seg: lo ? 5 : 8, stacks: lo ? 4 : 5, color: WOOL, ex: d => [0.7 + 0.3 * ss(-1, 0.5, d[1]), 1, 4, 0] });
    // legs (right side, mirrored)
    const mL = b.mark();
    for (const z of [0.3, -0.3]) {
      b.tube([[0.16, 0.42, z], [0.165, 0.2, z + 0.01], [0.16, 0.06, z], [0.16, 0.0, z + 0.01]], [0.056, 0.047, 0.046, 0.05],
        { sides: lo ? 4 : 6, capEnd: true, color: (u, v, p) => (p[1] < 0.07 ? [0.07, 0.06, 0.06] : LEG), ex: (u, v, p) => [0.55 + 0.4 * ss(0.5, 0.1, p[1]), 0, 0, 0] });
    }
    b.mirrorX(mL);
    // head group
    const mH = b.mark();
    b.tube([[0, 0.54, 0.18], [0, 0.6, 0.38], [0, 0.65, 0.5]], [0.15, 0.14, 0.1], {
      sides: lo ? 6 : 10, color: WOOL, ex: (u, v, p) => [0.72, 1, 3, 0],
    });
    const hc = [0, 0.66, 0.63];
    const hm = b.ellipsoid(hc, [0.1, 0.12, 0.18], {
      seg: lo ? 7 : 14, stacks: lo ? 5 : 9,
      disp: d => 1 - 0.12 * Math.max(0, d[2]) * Math.max(0, d[1]),
      color: d => mix3(FACE, [0.24, 0.19, 0.18], ss(0.6, 0.95, d[2])),
      ex: d => [0.72 + 0.28 * ss(-0.8, 0.5, d[1]), 0, 3, 0],
    });
    b.rotate(hm, 'x', 0.42, hc);
    // topknot
    b.ellipsoid([0, 0.78, 0.55], [0.12, 0.08, 0.12], {
      seg: lo ? 6 : 12, stacks: lo ? 4 : 7, disp: d => 1 + 0.18 * Math.abs(Math.sin(d[0] * 7) * Math.sin(d[2] * 6)),
      color: WOOL, ex: d => [0.75 + 0.25 * ss(-0.5, 0.6, d[1]), 1, 3, 0],
    });
    const mR = b.mark();
    const ear = b.ellipsoid([0.2, 0.7, 0.57], [0.1, 0.028, 0.048], { seg: lo ? 5 : 9, stacks: lo ? 3 : 5, color: d => (d[1] > 0 ? FACE : [0.3, 0.2, 0.19]), ex: () => [0.85, 0, 3, 0] });
    b.rotate(ear, 'z', -0.35, [0.1, 0.72, 0.57]);
    b.rotate(ear, 'y', 0.3, [0.1, 0.72, 0.57]);
    if (!lo) {
      b.ellipsoid([0.07, 0.725, 0.69], [0.034, 0.036, 0.03], { seg: 8, stacks: 5, color: [0.9, 0.88, 0.84], ex: () => [1, 0, 3, 0.12] });
      b.ellipsoid([0.086, 0.728, 0.708], 0.017, { seg: 6, stacks: 4, color: [0.03, 0.03, 0.03], ex: () => [1, 0, 3, 0] });
    }
    b.mirrorX(mR);
    // the ears/eyes/face attach in the head frame
    b.each(mH, o => { if (b.v[o + 11] < 0.5) b.v[o + 11] = 3; });
    const m = b.upload();
    m.tris = m.count / 3;
    return m;
  }
  const SHEEP = buildSheep(false), SHEEP_LO = buildSheep(true);

  // ═════════════════ shaders ═════════════════
  const R2 = 'vec2 r2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }\n';
  const BIRD_VS = GLSL_COMMON + R2 + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
layout(location=4) in vec4 iA; layout(location=5) in vec4 iB; layout(location=6) in vec4 iC;
uniform mat4 uVP;
uniform vec4 uSh;  // shoulder x, y, z, elbow span
uniform vec4 uFl;  // flap amp inner, amp outer, outer lag, sweep max
uniform vec4 uGl;  // glide dihedral inner, outer, body bob, model span
uniform vec2 uPx;  // world size of min pixels per metre distance, far cull
uniform vec3 uOff; // flap offset inner, outer (while flapping), palette mode (butterflies)
vec3 pal(float s){ return s < 0.3 ? vec3(0.95, 0.5, 0.13) : s < 0.55 ? vec3(0.98, 0.85, 0.26) : s < 0.8 ? vec3(0.38, 0.6, 0.95) : vec3(0.95, 0.94, 0.9); }
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec2 vAE; out float vFade;
void main(){
  vec3 rel0 = iA.xyz - uCam;
  float dist = length(rel0);
  float fade = iC.z*(1.0 - smoothstep(uPx.y*0.8, uPx.y, dist));
  vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vRel = rel0; vAE = vec2(1.0, 0.0); vFade = fade;
  if (fade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = aP, n = aN;
  float amp = iC.x, ph = iB.w, fold = iC.y;
  if (aX.z > 0.5 && aX.z < 1.5) {
    float sg = p.x < 0.0 ? -1.0 : 1.0;
    p.x *= sg; n.x *= sg;
    float s = p.x - uSh.x;
    if (s > 0.0) {
      bool hand = s > uSh.w + 1e-4;
      float L = uSh.w;
      // sweep back in the wing plane: gliding fold + hand flex on the upstroke
      float sw = fold*uFl.w + amp*0.3*max(cos(ph), 0.0);
      float swA = sw*0.3, swH = sw*0.7;
      vec2 q = vec2(s, p.z - uSh.z);
      q = hand ? r2(vec2(L, 0.0), -swA) + r2(vec2(s - L, q.y), -swA - swH) : r2(q, -swA);
      vec2 nq = r2(n.xz, hand ? -swA - swH : -swA);
      p.x = uSh.x + q.x; p.z = uSh.z + q.y; n.x = nq.x; n.z = nq.y;
      // flap: arm about the shoulder, hand about the wrist with a lag
      float g0 = 1.0 - min(amp, 1.0);
      float a1 = amp*uFl.x*sin(ph) + uGl.x*g0 + uOff.x*(1.0 - g0);
      float a2 = amp*uFl.y*sin(ph - uFl.z) + uGl.y*g0 + uOff.y*(1.0 - g0) - fold*0.25;
      float L2 = L*cos(swA);
      vec2 w = vec2(q.x, p.y - uSh.y);
      w = hand ? r2(vec2(L2, 0.0), a1) + r2(vec2(w.x - L2, w.y), a1 + a2) : r2(w, a1);
      vec2 nw = r2(n.xy, hand ? a1 + a2 : a1);
      p.x = uSh.x + w.x; p.y = uSh.y + w.y; n.x = nw.x; n.y = nw.y;
    }
    p.x *= sg; n.x *= sg;
  }
  p.y -= cos(ph)*uGl.z*amp;
  float cy = cos(iB.x), sy = sin(iB.x), cp = cos(iB.y), sp = sin(iB.y);
  vec3 F = vec3(sy*cp, sp, cy*cp);
  vec3 R = vec3(cy, 0.0, -sy);
  vec3 U = cross(F, R);
  float cb = cos(iB.z), sb = sin(iB.z);
  vec3 R2 = R*cb + U*sb, U2 = U*cb - R*sb;
  float sc = iA.w*max(1.0, dist*uPx.x/(iA.w*uGl.w));
  vec3 wp = (R2*p.x + U2*p.y + F*p.z)*sc;
  vN = R2*n.x + U2*n.y + F*n.z;
  vRel = rel0 + wp;
  vCol = aC*(0.93 + 0.14*iC.w);
  if (uOff.z > 0.5 && aX.z > 0.5 && aX.z < 1.5) vCol = mix(vec3(0.1, 0.07, 0.06), pal(iC.w), aC.r);
  vAE = aX.xw;
  gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const BIRD_FS = GLSL_COMMON + MESH.LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec2 vAE; in float vFade; out vec4 o;
void main(){
  if (vFade < 0.999 && bayer4(gl_FragCoord.xy) > vFade) discard;
  if (uShadowPass > 0.5) { o = vec4(0.0); return; }
  vec3 n = normalize(vN), v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;
  vec3 alb = toLin(vCol);
  gShadow = sunShadow(vRel, n);
  vec3 col = lightMesh(alb, n, v, vAE.x, vAE.y, 0.0);
  col += alb*uSunCol*pow(1.0 - abs(dot(n, v)), 3.0)*0.25*vAE.x;
  o = vec4(fogIt(col, vRel), 1.0);
}`;
  const BP = program(BIRD_VS, BIRD_FS);

  const SHEEP_VS = GLSL_COMMON + R2 + `
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC; layout(location=3) in vec4 aX;
layout(location=4) in vec4 iA; layout(location=5) in vec4 iB;
uniform mat4 uVP; uniform vec3 uG; uniform vec4 uLod; uniform vec2 uPx;
out vec3 vN; out vec3 vCol; out vec3 vRel; out vec3 vL; out vec3 vX; out float vFade;
const vec3 HEADP = vec3(${HEADP.join(', ')}), TAILP = vec3(${TAILP.join(', ')});
void main(){
  vec3 rel0 = iA.xyz - uCam;
  float dist = length(rel0);
  float band = smoothstep(uLod.x, uLod.y, dist);
  float fade = (uPx.y > 0.5 ? band : 1.0 - band)*(1.0 - smoothstep(uLod.z, uLod.w, dist));
  vN = vec3(0.0, 1.0, 0.0); vCol = vec3(0.0); vRel = rel0; vL = aP; vX = aX.xyw; vFade = fade;
  if (fade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float seed = fract(iB.y), black = step(5.0, iB.y);
  vec3 p = aP, n = aN;
  float cy = cos(iB.x), sy = sin(iB.x);
  if (aX.z > 2.5 && aX.z < 3.5) {
    vec3 gd = uG - iA.xyz;
    float alert = 1.0 - smoothstep(35.0, 85.0, length(gd));
    float c = fract(uTime*0.055 + seed*7.3);
    float up = smoothstep(0.0, 0.04, c)*(1.0 - smoothstep(0.2, 0.25, c));
    up = max(up, alert);
    float chew = sin(uTime*7.0 + seed*50.0)*0.04*step(0.5, fract(uTime*0.3 + seed*3.0));
    float pitch = mix(1.2 + chew, -0.15 + 0.07*sin(uTime*0.7 + seed*9.0), up);
    vec2 lg = vec2(gd.x*cy - gd.z*sy, gd.x*sy + gd.z*cy);
    float look = clamp(atan(lg.x, lg.y), -1.0, 1.0);
    float yawH = mix(0.3*sin(uTime*0.25 + seed*31.0), 0.55*sin(uTime*0.33 + seed*7.0), up);
    yawH = mix(yawH, look, alert);
    vec3 q = p - HEADP;
    q.yz = r2(q.yz, pitch); n.yz = r2(n.yz, pitch);
    q.zx = r2(q.zx, yawH); n.zx = r2(n.zx, yawH);
    p = HEADP + q;
  } else if (aX.z > 3.5) {
    float wag = sin(uTime*14.0 + seed*20.0)*0.5*step(0.85, fract(uTime*0.13 + seed*5.0));
    vec3 q = p - TAILP;
    q.zx = r2(q.zx, wag); p = TAILP + q;
  }
  float sc = iA.w*clamp(dist*uPx.x/1.3, 1.0, 3.5);
  vec3 lp = p*sc;
  vec3 wp = vec3(lp.x*cy + lp.z*sy, lp.y, -lp.x*sy + lp.z*cy);
  wp.y += wp.x*iB.z + wp.z*iB.w;
  vN = vec3(n.x*cy + n.z*sy, n.y, -n.x*sy + n.z*cy);
  vRel = rel0 + wp;
  vec3 tint = mix(vec3(0.95 + 0.1*seed, 0.95 + 0.08*seed, 0.93 + 0.06*seed), vec3(0.36, 0.29, 0.25), black);
  if (iA.w < 0.75) tint *= vec3(1.07, 1.07, 1.1);
  vCol = mix(aC, aC*tint, aX.y);
  gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const SHEEP_FS = GLSL_COMMON + MESH.LIGHT + `
in vec3 vN; in vec3 vCol; in vec3 vRel; in vec3 vL; in vec3 vX; in float vFade; out vec4 o;
uniform vec2 uPx;
void main(){
  float bd = bayer4(gl_FragCoord.xy);
  if (vFade < 0.999 && (uPx.y > 0.5 ? 1.0 - bd : bd) > vFade) discard;
  if (uShadowPass > 0.5) { o = vec4(0.0); return; }
  vec3 n = normalize(vN), v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;
  vec3 alb = toLin(vCol);
  float dist = length(vRel);
  if (vX.y > 0.5) {
    float k = 1.0 - smoothstep(6.0, 30.0, dist);
    vec3 q = vL*26.0;
    float w = vn(q.xy + q.z*0.7)*0.5 + vn(q.zy*1.3 + 7.0)*0.5;
    alb *= 1.0 + (w - 0.5)*0.32*k;
  }
  gShadow = sunShadow(vRel, n);
  vec3 col = lightMesh(alb, n, v, vX.x, vX.z, 0.0);
  float rim = pow(1.0 - abs(dot(n, v)), 2.5);
  float back = pow(max(dot(v, uSun), 0.0), 2.0);
  col += alb*(uSunCol*(0.2 + 0.9*back) + uAmb*0.1)*rim*vX.y;
  o = vec4(fogIt(col, vRel), 1.0);
}`;
  const SP = program(SHEEP_VS, SHEEP_FS);

  function vaoFor(mesh, ibuf, nv4) {
    const a = gl.createVertexArray();
    gl.bindVertexArray(a);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 4, 9]]) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4); gl.vertexAttribDivisor(loc, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    for (let k = 0; k < nv4; k++) {
      gl.enableVertexAttribArray(4 + k); gl.vertexAttribPointer(4 + k, 4, gl.FLOAT, false, nv4 * 16, k * 16); gl.vertexAttribDivisor(4 + k, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    return a;
  }

  // butterfly: dark body, fore + hind wings as flat fans (colour.r = palette mask; the shader picks the hue per instance)
  function buildButterfly() {
    const b = new MESH.Builder(), BODY = [0.1, 0.075, 0.06];
    b.tube([[0, 0, -0.6], [0, 0.01, -0.25], [0, 0.02, 0.15], [0, 0.03, 0.36]], [0.03, 0.075, 0.075, 0.05],
      { sides: 6, capStart: true, capEnd: true, color: BODY, ex: () => [0.9, 0, 0, 0] });
    b.ellipsoid([0, 0.04, 0.44], 0.085, { seg: 6, stacks: 4, color: BODY, ex: () => [0.9, 0, 0, 0] });
    const mR = b.mark();
    b.tube([[0.025, 0.07, 0.48], [0.1, 0.2, 0.74], [0.15, 0.25, 0.86]], [0.014, 0.012, 0.03], { sides: 3, capEnd: true, color: BODY, ex: () => [1, 0, 0, 0] });
    const fore = [[0.04, 0.3], [0.3, 0.52], [0.62, 0.68], [0.95, 0.7], [1.12, 0.52], [1.05, 0.25], [0.8, 0.02], [0.4, -0.04], [0.04, -0.02]];
    const hind = [[0.04, -0.02], [0.4, -0.06], [0.72, -0.2], [0.82, -0.45], [0.66, -0.72], [0.38, -0.82], [0.16, -0.66], [0.04, -0.35]];
    for (const poly of [fore, hind]) {
      let cx = 0, cz = 0;
      for (const [x, z] of poly) { cx += x; cz += z; }
      cx /= poly.length; cz /= poly.length;
      const c = b.vert([cx, 0.01, cz], [0, 1, 0], [1, 0, 0], [1, 0, 1, 0]), base = b.count;
      for (const [x, z] of poly) b.vert([x, 0.01, z], [0, 1, 0], [1 - ss(0.62, 1.0, Math.hypot(x, z * 0.95)), 0, 0], [0.9, 0, 1, 0]);
      for (let k = 0; k < poly.length; k++) b.tri(c, base + k, base + (k + 1) % poly.length);
    }
    b.mirrorX(mR);
    const m = b.upload();
    m.tris = m.count / 3;
    return m;
  }
  const BUTTERFLY = buildButterfly();

  // ═════════════════ bird simulation ═════════════════
  const MAXF = 8, MAXN = 40, MAXB = MAXF * MAXN, IF = 12;
  const SPEC = [
    { name: 'swallow', mesh: SWALLOW, scale: 0.2, cruise: 11, vmin: 6, vmax: 18, vup: 5, vdn: 7, sep: 1.8, sepK: 7, coh: 0.2, ali: 0.9, goal: 0.8,
      wander: 7, wf: 1.1, freq: 9, minAgl: 1.5, far: 750, flapOn: [0.45, 1.1], flapOff: [0.25, 0.7], glideFold: 0.75, panicR: 14,
      sh: [0.08, 0.06, 0.1, 0.36], fl: [0.95, 0.55, 0.9, 0.95], gl: [0.06, -0.08, 0.03, 2.4] },
    { name: 'gull', mesh: GULL, scale: 0.46, cruise: 9, vmin: 6, vmax: 15, vup: 3, vdn: 5, sep: 5, sepK: 3, coh: 0.06, ali: 0.5, goal: 0.45,
      wander: 1.5, wf: 0.3, freq: 2.7, minAgl: 5, far: 1150, flapOn: [0.9, 2.2], flapOff: [3, 9], glideFold: 0.08, panicR: 26,
      sh: [0.1, 0.05, 0.0, 0.66], fl: [0.75, 0.45, 0.8, 0.7], gl: [0.16, -0.22, 0.02, 3.5] },
    { name: 'butterfly', mesh: BUTTERFLY, scale: 0.105, far: 90, pix: 1.0,
      sh: [0.04, 0.0, 0.0, 10], fl: [1.0, 0, 0, 0], gl: [1.35, 0, 0.22, 2.3], off: [0.42, 0, 1] },
  ];
  for (const S of SPEC) if (!S.off) S.off = [0, 0, 0];
  const MEADOW = 0, COAST = 1, THERMAL = 2, CROSS = 3, ROAM = 4;
  const PLAN = [MEADOW, MEADOW, COAST, COAST, THERMAL, CROSS, CROSS, ROAM];
  const f32 = () => new Float32Array(MAXB);
  const px = f32(), py = f32(), pz = f32(), vx = f32(), vy = f32(), vz = f32();
  const ph = f32(), am = f32(), fo = f32(), bk = f32(), yw = f32(), pt = f32(), pn = f32(), gr = f32();
  const al = f32(), rr = f32(), ft = f32(), fl = f32(), sd = f32(), sx = f32(), sy = f32(), sz = f32();
  const flocks = [];
  for (let k = 0; k < MAXF; k++) {
    flocks.push({ on: false, slot: k, plan: PLAN[k], mode: PLAN[k], sp: 0, base: k * MAXN, n: 0, age: 0, fade: 0, wait: 0.3 + k * 0.25,
      cx: 0, cy: 0, cz: 0, mx: 0, my: 0, mz: 0, rad: 0, panic: 0, gx: 0, gz: 0, goalT: 0, hx: 0, hz: 0,
      tx: 0, tz: 0, tr: 0, ceil: 0, dir: 1, dx: 0, dz: 1, alt: 0, vis: false, th: null, nextSp: k & 1 });
  }
  const INST = SPEC.map(S => {
    const data = new Float32Array(MAXB * IF), buf = buffer(data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    return { data, buf, vao: vaoFor(S.mesh, buf, 3), n: 0 };
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  let simT = 0, frameNo = 0;
  const stats = { flocks: 0, birds: 0, drawn: 0, sheep: 0, sheepCells: 0, updMs: 0, drawMs: 0 };
  const sampleGround = (x, z) => Math.max(terrainH(x, z, 1), 0) + forestMask(x, z) * 14;

  function inView(cam, x, y, z, rad) {
    const dx = x - cam.pos[0], dy = y - cam.pos[1], dz = z - cam.pos[2];
    const zf = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
    if (zf < -rad) return false;
    const xr = dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2], yu = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
    if (Math.abs(xr) - zf * cam.tanX > rad * Math.sqrt(1 + cam.tanX * cam.tanX)) return false;
    if (Math.abs(yu) - zf * cam.tanY > rad * Math.sqrt(1 + cam.tanY * cam.tanY)) return false;
    return true;
  }

  const cand = [0, 0, 0];
  function candidate(cam, dmin, dmax) {
    const fwd = Math.atan2(cam.f[0], cam.f[2]);
    const a = rnd() < 0.7 ? fwd + (rnd() - 0.5) * 2.4 : rnd() * TAU;
    const d = dmin + rnd() * (dmax - dmin);
    cand[0] = cam.pos[0] + Math.sin(a) * d; cand[1] = cam.pos[2] + Math.cos(a) * d; cand[2] = d;
    return cand;
  }
  // a spawn point must not pop into view close by
  const hidden = (cam, x, y, z, d) => d > 480 || !inView(cam, x, y, z, 40);

  function makeFlock(F, sp, mode, x, y, z, heading, n) {
    const S = SPEC[sp];
    F.on = true; F.sp = sp; F.mode = mode; F.n = n; F.age = 0; F.fade = 0; F.hx = x; F.hz = z; F.goalT = 0; F.panic = 0;
    const R = sp === 0 ? 5 + n * 0.2 : 10 + n * 0.8;
    for (let k = 0; k < n; k++) {
      const i = F.base + k;
      px[i] = x + (rnd() - 0.5) * 2 * R; pz[i] = z + (rnd() - 0.5) * 2 * R;
      const spd = S.cruise * (0.9 + rnd() * 0.2), hd = heading + (rnd() - 0.5) * 0.3;
      vx[i] = Math.sin(hd) * spd; vz[i] = Math.cos(hd) * spd; vy[i] = 0;
      ph[i] = rnd() * TAU; am[i] = 0; fo[i] = 0; bk[i] = 0; yw[i] = hd; pt[i] = 0; pn[i] = 0;
      sd[i] = rnd(); ft[i] = rnd() * 1.5; fl[i] = rnd() < 0.5 ? 1 : 0; rr[i] = 0.7 + rnd() * 0.6;
      gr[i] = sampleGround(px[i], pz[i]);
      if (mode === MEADOW) al[i] = 2.5 + rnd() * 8;
      else if (mode === COAST) al[i] = 10 + rnd() * 38;
      else if (mode === ROAM) al[i] = sp ? 45 + rnd() * 60 : 22 + rnd() * 40;
      else al[i] = (rnd() - 0.5) * (sp ? 16 : 8);
      py[i] = mode === MEADOW || mode === COAST || mode === ROAM ? gr[i] + al[i] : Math.max(y + al[i], gr[i] + 8);
    }
    F.cx = x; F.cy = y; F.cz = z; F.mx = Math.sin(heading) * S.cruise; F.my = 0; F.mz = Math.cos(heading) * S.cruise; F.rad = R;
  }

  const tnB = [0, 0, 0];
  function acceptGoal(mode, x, z) {
    const h = terrainH(x, z, 1);
    if (mode === MEADOW) return h > 4 && h < 420 && forestMask(x, z) < 0.3 && terrainN(x, z, tnB)[1] > 0.86;
    if (mode === COAST) return h < 1.5;
    return h > 1;
  }
  function pickGoal(F) {
    const hd = Math.atan2(F.mx, F.mz), far = F.mode === MEADOW ? 1 : 2;
    for (let k = 0; k < 4; k++) {
      const a = hd + (rnd() - 0.5) * 2.6, d = (60 + rnd() * 110) * far;
      const x = F.cx + Math.sin(a) * d, z = F.cz + Math.cos(a) * d;
      if (Math.hypot(x - F.hx, z - F.hz) > 650) continue;
      if (acceptGoal(F.mode, x, z)) { F.gx = x; F.gz = z; F.goalT = 4 + rnd() * 6; return; }
    }
    F.gx = F.hx + (rnd() - 0.5) * 60; F.gz = F.hz + (rnd() - 0.5) * 60; F.goalT = 3 + rnd() * 3;
  }

  function spawnMeadow(F, cam) {
    for (let k = 0; k < 6; k++) {
      const c = candidate(cam, 220, 850), x = c[0], z = c[1];
      const h = terrainH(x, z, 1);
      if (h < 5 || h > 380 || forestMask(x, z) > 0.2 || terrainN(x, z, tnB)[1] < 0.9 || !hidden(cam, x, h + 6, z, c[2])) continue;
      makeFlock(F, 0, MEADOW, x, h + 6, z, rnd() * TAU, 16 + Math.floor(rnd() * 23));
      pickGoal(F);
      return true;
    }
    return false;
  }
  function spawnCoast(F, cam) {
    for (let k = 0; k < 14; k++) {
      const c = candidate(cam, 200, 900), x = c[0], z = c[1];
      if (terrainH(x, z, 1) > 0.5 || !hidden(cam, x, 25, z, c[2])) continue;
      makeFlock(F, 1, COAST, x, 25, z, rnd() * TAU, 10 + Math.floor(rnd() * 11));
      pickGoal(F);
      return true;
    }
    return false;
  }
  const thermList = [];
  function spawnThermal(F, cam) {
    WORLD.thermalsAround(cam.pos[0], cam.pos[2], 950, thermList);
    for (let k = 0; k < thermList.length; k++) {
      const t = thermList[k], d = Math.hypot(t.x - cam.pos[0], t.z - cam.pos[2]);
      if (d < 150 || d > 950) continue;
      let used = false;
      for (const G of flocks) if (G.on && G.th === t) used = true;
      if (used) continue;
      F.th = t; F.tx = t.x; F.tz = t.z; F.tr = t.r * 0.45 + 14; F.dir = rnd() < 0.5 ? -1 : 1;
      F.ceil = Math.min(t.top - 90, t.ground + 420);
      const y0 = t.ground + 60 + rnd() * Math.max(10, F.ceil - t.ground - 140);
      if (!hidden(cam, t.x, y0, t.z, d)) continue;
      makeFlock(F, 1, THERMAL, t.x + F.tr, y0, t.z, F.dir > 0 ? 0 : Math.PI, 10 + Math.floor(rnd() * 7));
      for (let q = 0; q < F.n; q++) { const i = F.base + q, a = rnd() * TAU, r = F.tr * rr[i]; px[i] = t.x + Math.cos(a) * r; pz[i] = t.z + Math.sin(a) * r; al[i] = (rnd() - 0.5) * 50; py[i] = y0 + al[i]; }
      return true;
    }
    return false;
  }
  function spawnRoam(F, cam, sp) {
    for (let k = 0; k < 6; k++) {
      const c = candidate(cam, 250, 850), x = c[0], z = c[1];
      const h = terrainH(x, z, 1);
      if (h < 2 || !hidden(cam, x, h + 50, z, c[2])) continue;
      makeFlock(F, sp, ROAM, x, h + 50, z, rnd() * TAU, sp ? 10 + Math.floor(rnd() * 8) : 18 + Math.floor(rnd() * 20));
      pickGoal(F);
      return true;
    }
    return false;
  }
  function spawnCross(F, cam, g) {
    const hv = Math.hypot(g.vel[0], g.vel[2]);
    if (!(hv > 8) || g.onGround) return false;
    const dx = g.vel[0] / hv, dz = g.vel[2] / hv, sp = F.nextSp;
    const S = SPEC[sp], D = 320 + rnd() * 320, T = D / Math.max(hv, 12);
    const side = rnd() < 0.5 ? -1 : 1, qx = -dz * side, qz = dx * side;
    const lat = clamp(S.cruise * 1.15 * T, 50, 420);
    const x = g.pos[0] + dx * D + qx * lat, z = g.pos[2] + dz * D + qz * lat;
    const gh = sampleGround(x, z), gAgl = g.pos[1] - groundH(g.pos[0], g.pos[2]);
    let y = gAgl > 450 ? gh + 60 + rnd() * 140 : g.pos[1] + clamp(g.vel[1] * T, -80, 80) + (rnd() - 0.6) * 16;
    y = Math.max(y, gh + (sp ? 22 : 14));
    F.nextSp ^= 1;
    makeFlock(F, sp, CROSS, x, y, z, Math.atan2(-qx, -qz), sp ? 10 + Math.floor(rnd() * 9) : 18 + Math.floor(rnd() * 22));
    F.dx = -qx; F.dz = -qz; F.alt = y;
    return true;
  }
  function trySpawn(F, cam, g) {
    switch (F.plan) {
      case MEADOW: return spawnMeadow(F, cam) || spawnRoam(F, cam, 0);
      case COAST: return spawnCoast(F, cam) || spawnThermal(F, cam) || spawnRoam(F, cam, 1);
      case THERMAL: return spawnThermal(F, cam) || spawnCoast(F, cam);
      case CROSS: return spawnCross(F, cam, g);
      default: return spawnRoam(F, cam, 0);
    }
  }

  function stepFlock(F, dt, g) {
    const S = SPEC[F.sp], i0 = F.base, i1 = i0 + F.n, mode = F.mode, cr = S.cruise;
    F.age += dt; F.fade = Math.min(1, F.fade + dt * 0.5);
    let cx = 0, cy = 0, cz = 0, mx = 0, my = 0, mz = 0;
    for (let i = i0; i < i1; i++) { cx += px[i]; cy += py[i]; cz += pz[i]; mx += vx[i]; my += vy[i]; mz += vz[i]; }
    const inv = 1 / F.n;
    cx *= inv; cy *= inv; cz *= inv; mx *= inv; my *= inv; mz *= inv;
    let r2 = 0;
    for (let i = i0; i < i1; i++) {
      const dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz, d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
      sx[i] = 0; sy[i] = 0; sz[i] = 0;
    }
    F.cx = cx; F.cy = cy; F.cz = cz; F.mx = mx; F.my = my; F.mz = mz; F.rad = Math.sqrt(r2);
    if (mode === MEADOW || mode === COAST || mode === ROAM) {
      F.goalT -= dt;
      const gdx = F.gx - cx, gdz = F.gz - cz;
      if (F.goalT <= 0 || gdx * gdx + gdz * gdz < 900) pickGoal(F);
    }
    // separation (+ panic spreading when anyone is spooked)
    const R = S.sep, RR = R * R, anyP = F.panic > 0.05, PR = S.panicR, PRR = PR * PR, RQ = anyP ? PR : R;
    for (let i = i0; i < i1; i++) {
      const xi = px[i], yi = py[i], zi = pz[i];
      for (let j = i + 1; j < i1; j++) {
        const dx = px[j] - xi; if (dx > RQ || dx < -RQ) continue;
        const dz = pz[j] - zi; if (dz > RQ || dz < -RQ) continue;
        const dy = py[j] - yi, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < RR && d2 > 1e-6) {
          const f = (RR - d2) / (RR * Math.sqrt(d2));
          sx[i] -= dx * f; sy[i] -= dy * f; sz[i] -= dz * f; sx[j] += dx * f; sy[j] += dy * f; sz[j] += dz * f;
        }
        if (anyP && d2 < PRR) { const a = pn[i] * 0.92, b = pn[j] * 0.92; if (a > pn[j]) pn[j] = a; if (b > pn[i]) pn[i] = b; }
      }
    }
    // glider threat: distance to the segment it will sweep in the next ~0.45 s
    const gx = g.pos[0], gy = g.pos[1], gz = g.pos[2];
    const lx = g.vel[0] * 0.45, ly = g.vel[1] * 0.45, lz = g.vel[2] * 0.45, ll = lx * lx + ly * ly + lz * lz + 1e-6;
    const ecx = cx - gx, ecy = cy - gy, ecz = cz - gz, reach = F.rad + 100 + Math.sqrt(ll);
    const near = g.live !== false && ecx * ecx + ecy * ecy + ecz * ecz < reach * reach;
    const TR2 = 30 * 30;
    const kSm = 1 - Math.exp(-dt * 5), kBank = 1 - Math.exp(-dt * 4);
    const therm = mode === THERMAL;
    const kc0 = therm ? 0 : S.coh, ka0 = therm ? 0.05 : S.ali;
    let pmax = 0;
    for (let i = i0; i < i1; i++) {
      const x = px[i], y = py[i], z = pz[i];
      let u = vx[i], v = vy[i], w = vz[i];
      const p = pn[i];
      let dvx, dvy, dvz;
      if (therm) {
        const rx = x - F.tx, rz = z - F.tz, r = Math.sqrt(rx * rx + rz * rz) + 1e-3;
        const pull = clamp((F.tr * rr[i] - r) * 0.25, -5, 5), d = F.dir;
        dvx = -rz / r * d * cr + rx / r * pull; dvz = rx / r * d * cr + rz / r * pull;
        dvy = clamp((F.ceil + al[i] - y) * 0.3, -1.5, 1.3);
      } else if (mode === CROSS) {
        dvx = F.dx * cr * 1.15; dvz = F.dz * cr * 1.15;
        dvy = clamp((Math.max(F.alt + al[i], gr[i] + 12) - y) * 0.5, -2.5, 2.5);
      } else {
        const tx = F.gx - x, tz = F.gz - z, l = Math.sqrt(tx * tx + tz * tz) + 1e-3;
        dvx = tx / l * cr; dvz = tz / l * cr;
        const swoop = F.sp === 0 ? Math.sin(simT * 0.9 + sd[i] * 40) * 2.2 : 0;
        dvy = clamp((gr[i] + al[i] + swoop - y) * 0.5, F.sp === 0 ? -5.5 : -3, 3);
      }
      const kg = S.goal * (1 - p * 0.8);
      let ax = (dvx - u) * kg, ay = (dvy - v) * kg * 1.5, az = (dvz - w) * kg;
      const kc = kc0 * (1 - p), ka = ka0 * (1 - p * 0.7);
      ax += (cx - x) * kc + (mx - u) * ka + sx[i] * S.sepK;
      ay += (cy - y) * kc * 0.4 + (my - v) * ka + sy[i] * S.sepK;
      az += (cz - z) * kc + (mz - w) * ka + sz[i] * S.sepK;
      const s = sd[i] * 50, tw = simT * S.wf * (0.8 + sd[i] * 0.4);
      ax += Math.sin(tw * 1.3 + s) * S.wander; az += Math.cos(tw + s * 1.7) * S.wander; ay += Math.sin(tw * 0.7 + s * 2.3) * S.wander * 0.3;
      const agl = y - gr[i], lim = S.minAgl * 2;
      if (agl < lim) ay += (lim - agl) * 5 - (v < 0 ? v * 2 : 0);
      if (near) {
        let ex = x - gx, ey = y - gy, ez = z - gz;
        let t = (ex * lx + ey * ly + ez * lz) / ll;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        ex -= lx * t; ey -= ly * t; ez -= lz * t;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < TR2) pn[i] = 1;
        if (pn[i] > 0.05 && d2 < 8100) {
          const d = Math.sqrt(d2) + 0.5, k = 40 * pn[i] / d;
          ax += ex * k + (sd[i] - 0.5) * 20 * pn[i]; ay += ey * k + (rr[i] - 1) * 20 * pn[i]; az += ez * k + (0.5 - sd[i]) * 12 * pn[i];
        }
      }
      u += ax * dt; v += ay * dt; w += az * dt;
      const vup = S.vup * (1 + pn[i]), vdn = S.vdn * (1 + pn[i]);
      if (v > vup) v = vup; else if (v < -vdn) v = -vdn;
      let spd = Math.sqrt(u * u + v * v + w * w);
      const vmax = S.vmax * (1 + pn[i] * 0.7);
      if (spd > vmax) { const k = vmax / spd; u *= k; v *= k; w *= k; spd = vmax; }
      else if (spd < S.vmin) { const k = S.vmin / (spd + 1e-6); u *= k; v *= k; w *= k; spd = S.vmin; }
      let ny = y + v * dt;
      if (ny < gr[i] + 0.8) { ny = gr[i] + 0.8; if (v < 0) v = 0; }
      px[i] = x + u * dt; py[i] = ny; pz[i] = z + w * dt; vx[i] = u; vy[i] = v; vz[i] = w;
      // wingbeats: bursts & glides, flap to climb / accelerate / flee
      ft[i] -= dt;
      if (ft[i] <= 0) { fl[i] = fl[i] > 0.5 ? 0 : 1; const rg = fl[i] > 0.5 ? S.flapOn : S.flapOff; ft[i] = rg[0] + rnd() * (rg[1] - rg[0]); }
      let want = fl[i], fold = want > 0.5 ? 0 : S.glideFold;
      if (therm) want = 0;
      else if (v > 1.2 || spd < cr * 0.75) want = 1;
      if (v < -3.5 && F.sp === 0) { want = 0; fold = 1; }
      if (pn[i] > 0.2) { want = 1.15; fold = 0.1; }
      am[i] += (want - am[i]) * kSm; fo[i] += (fold - fo[i]) * kSm;
      ph[i] += dt * TAU * S.freq * (1 + pn[i] * 0.4) * (0.9 + sd[i] * 0.2);
      if (ph[i] > TAU) ph[i] -= TAU;
      // attitude from velocity; bank into turns
      const hs = Math.sqrt(u * u + w * w) + 1e-6, nyaw = Math.atan2(u, w);
      let dyaw = nyaw - yw[i];
      if (dyaw > Math.PI) dyaw -= TAU; else if (dyaw < -Math.PI) dyaw += TAU;
      yw[i] = nyaw;
      bk[i] += (clamp(-dyaw / dt * spd / 9.81, -1.2, 1.2) - bk[i]) * kBank;
      pt[i] = Math.atan2(v, hs) * 0.85;
      if (pn[i] > pmax) pmax = pn[i];
      pn[i] = Math.max(0, pn[i] - dt * 0.3);
      // staggered ground probe, alternating under-bird / look-ahead
      if (((i + frameNo) & 3) === 0) {
        const la = (frameNo >> 2) & 1 ? 0.7 : 0;
        gr[i] = Math.max(sampleGround(px[i] + u * la, pz[i] + w * la), gr[i] - 3);
      }
    }
    F.panic = pmax;
  }

  function update(dt, ctx) {
    if (!(dt > 0)) { updateSheep(ctx.cam.pos[0], ctx.cam.pos[2]); return; }
    const t0 = performance.now();
    dt = Math.min(dt, 0.05);
    simT += dt; frameNo++;
    const cam = ctx.cam, g = ctx.g;
    let spawned = false, nf = 0, nb = 0;
    for (let k = 0; k < MAXF; k++) {
      const F = flocks[k];
      if (!F.on) {
        F.wait -= dt;
        if (F.wait <= 0 && !spawned) {
          spawned = true;
          if (!trySpawn(F, cam, g)) F.wait = F.plan === CROSS ? 2 + rnd() * 2 : 1.5 + rnd() * 1.5;
        }
        continue;
      }
      stepFlock(F, dt, g);
      nf++; nb += F.n;
      // recycle flocks left behind / out of range (never while in view nearby)
      const dx = F.cx - cam.pos[0], dz = F.cz - cam.pos[2], dh = Math.sqrt(dx * dx + dz * dz);
      let kill = dh > 1200;
      if (!kill && !F.vis && F.age > 8) {
        if (dh > 800) kill = true;
        if (F.mode === CROSS && F.age > 12) {
          const hv = Math.hypot(g.vel[0], g.vel[2]) + 1e-3;
          if (((F.cx - g.pos[0]) * g.vel[0] + (F.cz - g.pos[2]) * g.vel[2]) / hv < -220) kill = true;
        }
        if (F.mode === THERMAL && F.th && Math.hypot(F.cx - F.th.x, F.cz - F.th.z) > 300) kill = true;
      }
      if (kill) { F.on = false; F.th = null; F.wait = F.plan === CROSS ? 5 + rnd() * 10 : 1 + rnd() * 3; }
    }
    stats.flocks = nf; stats.birds = nb;
    stepButterflies(dt, cam, g);
    updateSheep(cam.pos[0], cam.pos[2]);
    stats.updMs = performance.now() - t0;
  }

  function fillBirds(cam) {
    let n0 = 0, n1 = 0;
    for (let k = 0; k < MAXF; k++) {
      const F = flocks[k];
      if (!F.on) continue;
      F.vis = inView(cam, F.cx, F.cy, F.cz, F.rad + 4);
      if (!F.vis) continue;
      const S = SPEC[F.sp], far2 = S.far * S.far, data = INST[F.sp].data;
      for (let i = F.base, i1 = F.base + F.n; i < i1; i++) {
        const dx = px[i] - cam.pos[0], dy = py[i] - cam.pos[1], dz = pz[i] - cam.pos[2];
        if (dx * dx + dy * dy + dz * dz > far2) continue;
        const o = (F.sp ? n1++ : n0++) * IF;
        data[o] = px[i]; data[o + 1] = py[i]; data[o + 2] = pz[i]; data[o + 3] = S.scale * (0.9 + sd[i] * 0.2);
        data[o + 4] = yw[i]; data[o + 5] = pt[i]; data[o + 6] = bk[i]; data[o + 7] = ph[i];
        data[o + 8] = am[i]; data[o + 9] = fo[i]; data[o + 10] = F.fade; data[o + 11] = sd[i];
      }
    }
    INST[0].n = n0; INST[1].n = n1;
    // butterflies
    let n2 = 0;
    const data = INST[2].data, S = SPEC[2];
    for (let i = 0; i < BMAX; i++) {
      if (!BON[i]) continue;
      const o = n2++ * IF;
      data[o] = BX[i]; data[o + 1] = BY[i]; data[o + 2] = BZ[i]; data[o + 3] = S.scale * (0.85 + BSD[i] * 0.3);
      data[o + 4] = Math.atan2(BVX[i], BVZ[i]); data[o + 5] = clamp(BVY[i] * 0.3, -0.5, 0.5); data[o + 6] = Math.sin(BPH[i] * 0.375) * 0.25; data[o + 7] = BPH[i];
      data[o + 8] = BAM[i]; data[o + 9] = 0; data[o + 10] = BFD[i]; data[o + 11] = BSD[i];
    }
    INST[2].n = n2;
  }
  function drawBirds(cam) {
    const pixK = 2 * cam.tanY / Math.max(1, gl.drawingBufferHeight) * 2.2;
    let used = false;
    for (let s = 0; s < 3; s++) {
      const I = INST[s], S = SPEC[s];
      if (!I.n) continue;
      if (!used) { gl.useProgram(BP.p); setEnv(BP); gl.uniform1f(BP.u.uSpec, 0.1); used = true; }
      gl.bindBuffer(gl.ARRAY_BUFFER, I.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, I.data, 0, I.n * IF);
      gl.uniform4fv(BP.u.uSh, S.sh); gl.uniform4fv(BP.u.uFl, S.fl); gl.uniform4fv(BP.u.uGl, S.gl); gl.uniform3fv(BP.u.uOff, S.off);
      gl.uniform2f(BP.u.uPx, pixK * (S.pix || 1), S.far);
      gl.bindVertexArray(I.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, S.mesh.count, gl.UNSIGNED_INT, 0, I.n);
    }
    stats.drawn = INST[0].n + INST[1].n; stats.butterflies = INST[2].n;
  }
  for (const S of SPEC) { S.sh = new Float32Array(S.sh); S.fl = new Float32Array(S.fl); S.gl = new Float32Array(S.gl); S.off = new Float32Array(S.off); }

  // ═════════════════ butterflies: flutter over meadows ahead of the camera while the glider is low ═════════════════
  const BMAX = 40, fb = () => new Float32Array(BMAX);
  const BX = fb(), BY = fb(), BZ = fb(), BVX = fb(), BVY = fb(), BVZ = fb(), BPH = fb(), BSD = fb(), BGR = fb(), BH = fb(), BAM = fb(), BFD = fb(), BFT = fb();
  const BON = new Uint8Array(BMAX);
  function spawnButterfly(i, cam, g) {
    const fx = cam.f[0], fz = cam.f[2], fl = Math.hypot(fx, fz) || 1;
    const d = 10 + rnd() * (22 + Math.min(g.V, 40) * 1.3), s = (rnd() - 0.5) * (12 + d * 0.7);
    const x = cam.pos[0] + fx / fl * d - fz / fl * s, z = cam.pos[2] + fz / fl * d + fx / fl * s;
    const h = terrainH(x, z, 1);
    if (h < 2 || forestMask(x, z) > 0.35 || (x - g.pos[0]) ** 2 + (z - g.pos[2]) ** 2 < 196) return false;
    BON[i] = 1; BX[i] = x; BZ[i] = z; BGR[i] = h; BH[i] = 0.4 + rnd() * 2.2; BY[i] = h + BH[i];
    const a = rnd() * TAU; BVX[i] = Math.sin(a); BVZ[i] = Math.cos(a); BVY[i] = 0;
    BPH[i] = rnd() * TAU; BSD[i] = rnd(); BAM[i] = 1; BFD[i] = 0; BFT[i] = rnd();
    return true;
  }
  function stepButterflies(dt, cam, g) {
    const low = g.agl < 35 && groundH(g.pos[0], g.pos[2]) > 1.5;
    let budget = 2, live = 0;
    const gx = g.pos[0], gy = g.pos[1], gz = g.pos[2];
    for (let i = 0; i < BMAX; i++) {
      if (!BON[i]) { if (low && budget > 0) { budget--; spawnButterfly(i, cam, g); } continue; }
      const dx = BX[i] - cam.pos[0], dz = BZ[i] - cam.pos[2], d2 = dx * dx + dz * dz;
      const ahead = dx * cam.f[0] + dz * cam.f[2];
      if (d2 > 95 * 95 || (ahead < -12 && d2 > 300) || (!low && d2 > 60 * 60)) { BON[i] = 0; continue; }
      live++;
      const t = simT * 1.2 + BSD[i] * 20, s = BSD[i] * 9;
      let tvx = (Math.sin(t * 0.9 + s) + 0.6 * Math.sin(t * 2.3 + s * 2)) * 1.3;
      let tvz = (Math.cos(t * 0.7 + s * 1.3) + 0.6 * Math.cos(t * 2.9 + s)) * 1.3;
      let tvy = (BGR[i] + BH[i] - BY[i]) * 1.2 + Math.sin(t * 4.1 + s) * 0.7;
      const ex = BX[i] - gx, ey = BY[i] - gy, ez = BZ[i] - gz, e2 = ex * ex + ey * ey + ez * ez;
      if (e2 < 144) { const e = Math.sqrt(e2) + 0.3; tvx += ex / e * 6; tvy += 2.5; tvz += ez / e * 6; BAM[i] = 1.2; }
      const k = 1 - Math.exp(-dt * 2.5);
      BVX[i] += (tvx - BVX[i]) * k; BVY[i] += (tvy - BVY[i]) * k; BVZ[i] += (tvz - BVZ[i]) * k;
      BX[i] += BVX[i] * dt; BY[i] += BVY[i] * dt; BZ[i] += BVZ[i] * dt;
      if (BY[i] < BGR[i] + 0.15) { BY[i] = BGR[i] + 0.15; if (BVY[i] < 0) BVY[i] = 0; }
      // flutter with short glides (wings held up)
      BFT[i] -= dt;
      if (BFT[i] < 0) BFT[i] = 0.5 + rnd() * 1.4;
      const want = BFT[i] < 0.25 && e2 > 144 ? 0 : 1;
      BAM[i] += (want - BAM[i]) * (1 - Math.exp(-dt * 8));
      BPH[i] += dt * TAU * (8 + BSD[i] * 3);
      if (BPH[i] > TAU * 64) BPH[i] -= TAU * 64;
      BFD[i] = Math.min(1, BFD[i] + dt * 1.5);
      if (((i + frameNo) & 7) === 0) BGR[i] = terrainH(BX[i], BZ[i], 1);
    }
    stats.bflies = live;
  }

  // ═════════════════ sheep placement (deterministic cells) ═════════════════
  const SHC = 170, SHR = 560, SHMAX = 1200, SIF = 8, LOD_D = 95;
  const shCells = new Map(), shNeed = [];
  const shData = new Float32Array(SHMAX * SIF), shBuf = buffer(shData, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  const shVao = vaoFor(SHEEP, shBuf, 2), shVaoLo = vaoFor(SHEEP_LO, shBuf, 2);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  let shKey = NaN, shCount = 0, shDirty = false;
  const EMPTY = new Float32Array(0), tn = [0, 0, 0];
  function sheepCell(i, j) {
    if (hash2(i * 2 + 17, j * 3 - 29) > 0.26) return EMPTY;
    const cx = (i + 0.2 + 0.6 * hash2(i + 11, j + 5)) * SHC, cz = (j + 0.2 + 0.6 * hash2(i + 3, j + 17)) * SHC;
    const h = terrainH(cx, cz, 1);
    if (h < 10 || h > 300 || forestMask(cx, cz) > 0.04) return EMPTY;
    terrainN(cx, cz, tn);
    if (tn[1] < 0.955) return EMPTY;
    const n = 5 + Math.floor(hash2(i + 23, j + 31) * 16), R = 5 + n * 0.9;
    const gx = -tn[0] / tn[1], gz = -tn[2] / tn[1], yaw0 = hash2(i + 41, j + 43) * TAU;
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = hash2(i * 31 + k, j * 17 + 3) * TAU, d = Math.sqrt(hash2(i * 13 + k * 7, j * 29 + k)) * R;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d * 0.8;
      let ok = true;
      for (let q = 0; q < out.length; q += SIF) { const ex = out[q] - x, ez = out[q + 2] - z; if (ex * ex + ez * ez < 2.2) { ok = false; break; } }
      if (!ok) continue;
      const y = terrainH(x, z, 1);
      if (y < 8 || forestMask(x, z) > 0.1) continue;
      const r1 = hash2(k + 91, i + j * 7), r2 = hash2(k * 3 + 5, j - i * 5);
      const lamb = r1 < 0.2, black = r2 < 0.035;
      const s = lamb ? 0.56 + r2 * 0.1 : 0.9 + r2 * 0.2;
      out.push(x, y - 0.04, z, s, yaw0 + (hash2(k + 7, i * 3 + j) - 0.5) * 2.8, hash2(k + 13, i - j) * 0.999 + (black ? 10 : 0), gx, gz);
    }
    return new Float32Array(out);
  }
  function updateSheep(cx, cz) {
    const i0 = Math.floor((cx - SHR) / SHC), i1 = Math.floor((cx + SHR) / SHC);
    const j0 = Math.floor((cz - SHR) / SHC), j1 = Math.floor((cz + SHR) / SHC);
    const key = i0 * 100003 + j0;
    if (key !== shKey) {
      shKey = key; shNeed.length = 0; shDirty = true;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const dx = Math.max(i * SHC - cx, 0, cx - (i + 1) * SHC), dz = Math.max(j * SHC - cz, 0, cz - (j + 1) * SHC);
        if (dx * dx + dz * dz < (SHR + 60) * (SHR + 60)) shNeed.push(i * 100003 + j);
      }
    }
    let budget = 3;
    for (let q = 0; q < shNeed.length; q++) {
      const k = shNeed[q];
      if (!shCells.has(k) && budget-- > 0) {
        const i = Math.round(k / 100003), j = k - i * 100003;
        shCells.set(k, sheepCell(i, j)); shDirty = true;
      }
    }
    if (shDirty) {
      shDirty = false; shCount = 0;
      for (let q = 0; q < shNeed.length; q++) {
        const c = shCells.get(shNeed[q]);
        if (!c || !c.length) { if (!c) shDirty = true; continue; }
        const n = Math.min(c.length / SIF, SHMAX - shCount);
        shData.set(n * SIF === c.length ? c : c.subarray(0, n * SIF), shCount * SIF); shCount += n;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, shBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, shData, 0, shCount * SIF);
      if (shCells.size > 600) for (const [k] of shCells) { const i = Math.round(k / 100003), j = k - i * 100003; if (Math.abs(i * SHC - cx) > 2500 || Math.abs(j * SHC - cz) > 2500) shCells.delete(k); }
    }
    stats.sheep = shCount; stats.sheepCells = shCells.size;
  }
  const gU = new Float32Array(3);
  function drawSheep(cam, gpos) {
    if (!shCount) return;
    gl.useProgram(SP.p); setEnv(SP);
    gl.uniform1f(SP.u.uSpec, 0.04);
    gU[0] = gpos[0]; gU[1] = gpos[1]; gU[2] = gpos[2];
    gl.uniform3fv(SP.u.uG, gU);
    const pixK = 2 * cam.tanY / Math.max(1, gl.drawingBufferHeight) * 2.6;
    gl.uniform4f(SP.u.uLod, LOD_D - 12, LOD_D + 12, 470, 530);
    gl.uniform2f(SP.u.uPx, pixK, 0);
    gl.bindVertexArray(shVao);
    gl.drawElementsInstanced(gl.TRIANGLES, SHEEP.count, gl.UNSIGNED_INT, 0, shCount);
    gl.uniform2f(SP.u.uPx, pixK, 1);
    gl.bindVertexArray(shVaoLo);
    gl.drawElementsInstanced(gl.TRIANGLES, SHEEP_LO.count, gl.UNSIGNED_INT, 0, shCount);
  }

  function drawOpaque(ctx) {
    if (ctx.shadow >= 0) { if (ctx.shadow < 2) { drawSheep(ctx.cam, ctx.g.pos); gl.bindVertexArray(null); } return; } // only sheep cast shadows, near
    const t0 = performance.now();
    fillBirds(ctx.cam);
    drawBirds(ctx.cam);
    drawSheep(ctx.cam, ctx.g.pos);
    gl.bindVertexArray(null);
    stats.drawMs = performance.now() - t0;
  }

  // ═════════════════ viewer showcase ═════════════════
  const FAR_G = [1e6, 1e6, 1e6];
  let pvSheep = false;
  function preview(ctx) {
    const t = ctx.time, cam = ctx.cam;
    const n = [0, 0, 0];
    const put = (s, x, y, z, yaw, pitch, bank, phase, amp, fold, seed, scale) => {
      const d = INST[s].data, o = n[s]++ * IF;
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = SPEC[s].scale * (scale || 1);
      d[o + 4] = yaw; d[o + 5] = pitch; d[o + 6] = bank; d[o + 7] = phase;
      d[o + 8] = amp; d[o + 9] = fold; d[o + 10] = 1; d[o + 11] = seed;
    };
    // pose line-up (facing +Z): swallows front row, gulls behind
    const sw = SPEC[0], gu = SPEC[1];
    const sPh = [Math.PI / 2, 0, -Math.PI / 2];
    for (let k = 0; k < 3; k++) put(0, -1.6 + k * 0.8, 1.5, 0, 0, 0, 0, sPh[k] + t * TAU * sw.freq * 0.12, 1, 0, 0.5);
    put(0, 0.8, 1.5, 0, 0, 0, 0, 0, 0, 0, 0.5);
    put(0, 1.6, 1.5, 0, 0, -0.15, 0, 0, 0, 1, 0.5);
    for (let k = 0; k < 3; k++) put(1, -3 + k * 2, 2.4, -2.5, 0, 0, 0, sPh[k] + t * TAU * gu.freq * 0.25, 1, 0, 0.5);
    put(1, 3, 2.4, -2.5, 0, 0, 0, 0, 0, 0, 0.5);
    // flock circling above the origin
    for (let k = 0; k < 24; k++) {
      const r = 7 + (k % 5) * 1.3, w = sw.cruise / r * 0.55, a = t * w + k * 0.26 + Math.sin(k * 1.7) * 0.2;
      const y = 7 + Math.sin(k * 2.3) * 1.5 + Math.sin(t * 1.3 + k) * 0.6;
      put(0, Math.sin(a) * r, y, Math.cos(a) * r, a + Math.PI / 2, 0, -0.55, t * TAU * sw.freq + k * 1.1,
        (Math.sin(t * 1.7 + k * 0.9) > -0.2) ? 1 : 0, (Math.sin(t * 1.7 + k * 0.9) > -0.2) ? 0 : 0.7, (k * 0.37) % 1);
    }
    for (let k = 0; k < 8; k++) {
      const r = 18 + (k % 3) * 3, a = -t * 0.35 - k * 0.7, flap = Math.sin(t * 0.6 + k * 2.1) > 0.75 ? 1 : 0;
      put(1, Math.sin(a) * r, 15 + (k % 4) * 1.5, Math.cos(a) * r, a - Math.PI / 2, 0, 0.35, t * TAU * gu.freq + k, flap, 0, (k * 0.61) % 1);
    }
    // butterflies fluttering over the sheep, plus a close-up pair (flapping / wings up)
    for (let k = 0; k < 8; k++) {
      const a = t * 0.5 + k * 0.8, x = 6 + Math.sin(a * 1.3 + k) * 3, z = 4 + Math.cos(a + k * 2) * 3;
      put(2, x, 0.7 + (k % 3) * 0.35 + Math.sin(t * 4 + k) * 0.12, z, a * 1.3 + k, 0, Math.sin(t * 3 + k) * 0.2, t * TAU * 9 + k, 1, 0, (k * 0.13 + 0.05) % 1);
    }
    put(2, -0.3, 1.0, 1.2, 0.3, 0, 0, t * TAU * 1.5, 1, 0, 0.1);
    put(2, 0.3, 1.0, 1.2, -0.3, 0, 0, 0, 0, 0, 0.62);
    INST[0].n = n[0]; INST[1].n = n[1]; INST[2].n = n[2];
    drawBirds(cam);
    // sheep group on the grass
    if (!pvSheep) {
      pvSheep = true;
      const pos = [[5, 3, 0.4, 1], [6.8, 4.6, 2.2, 1.05], [4.2, 5.8, -0.8, 0.95], [7.6, 2.2, 1.2, 0.6], [6, 7.2, 2.9, 1],
        [8.8, 5.6, -1.6, 1.08], [3.4, 1.4, 1.9, 0.58], [9.6, 8.4, 0.5, 1], [2.2, 8, 2.6, 0.97], [11, 3.4, 3.4, 1.02]];
      shCount = 0;
      for (const [x, z, yaw, s] of pos) {
        const o = shCount++ * SIF;
        shData[o] = x; shData[o + 1] = 0; shData[o + 2] = z; shData[o + 3] = s;
        shData[o + 4] = yaw; shData[o + 5] = ((shCount * 0.137) % 1) + (shCount === 5 ? 10 : 0); shData[o + 6] = 0; shData[o + 7] = 0;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, shBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, shData, 0, shCount * SIF);
    }
    drawSheep(cam, FAR_G);
    gl.bindVertexArray(null);
  }

  return {
    name: 'fauna', update, drawOpaque, preview, stats, flocks, debug: { px, py, pz, vx, vy, vz, gr, pn, am, BX, BY, BZ, BON },
    tris: { swallow: SWALLOW.tris, gull: GULL.tris, sheep: SHEEP.tris, sheepLo: SHEEP_LO.tris, butterfly: BUTTERFLY.tris },
  };
})();
MODELS.push(FAUNA);
