'use strict';
// ───────────────────────── Sun shadows: stable cascaded shadow maps + a far terrain cascade ─────────────────────────
// Cascades are sphere-fitted to slices of the view frustum (their size never changes with camera rotation) and their
// centres snap to the shadow-map texel grid in world space, so shadows don't shimmer as the camera moves or turns.
// Each cascade keeps the matrix it was rendered with, anchored to the camera position at that moment; sampling adds the
// camera's movement since, so far cascades can be refreshed only every few frames. Everything is camera-relative.
const SHADOW = (() => {
  const { gl, env } = GLX;
  const MAXC = 5, UNIT = 13;
  // quality presets: map size, cascade split distances (m), refresh interval per cascade (frames), PCF taps
  const PRESETS = {
    high: { size: 2048, splits: [0.5, 24, 100, 420, 2000], far: 14000, every: [1, 1, 2, 4], pcf: 9 },
    medium: { size: 1536, splits: [0.5, 30, 160, 900], far: 12000, every: [1, 2, 4], pcf: 4 },
    low: { size: 1024, splits: [0.5, 60, 600], far: 0, every: [1, 3], pcf: 1 },
  };
  let P = PRESETS.high, size = 0, tex = null, fbos = [];
  const cas = []; // per cascade: matrix (rel at render), camera at render, texel size, radius, frame age
  for (let i = 0; i < MAXC; i++) cas.push({ m: new Float32Array(16), cam: [0, 0, 0], texel: 1, r: 1, cx: 0, cy: 0, cz: 0, valid: false, last: -1e9 });
  const uM = new Float32Array(16 * MAXC), uP = new Float32Array(4 * MAXC), uS = new Float32Array(4);
  let count = 0, frame = 0, enabled = true;

  function allocate(sz) {
    if (tex) { gl.deleteTexture(tex); for (const f of fbos) gl.deleteFramebuffer(f); fbos = []; }
    size = sz;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT32F, sz, sz, MAXC);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    for (let i = 0; i < MAXC; i++) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, tex, 0, i);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      fbos.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const c of cas) c.valid = false;
  }

  // light basis: lf from the sun into the scene
  const lf = [0, -1, 0], lr = [1, 0, 0], lu = [0, 0, 1];
  function basis() {
    lf[0] = -env.sun[0]; lf[1] = -env.sun[1]; lf[2] = -env.sun[2];
    const up = Math.abs(lf[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    lr[0] = lf[1] * up[2] - lf[2] * up[1]; lr[1] = lf[2] * up[0] - lf[0] * up[2]; lr[2] = lf[0] * up[1] - lf[1] * up[0];
    const l = Math.hypot(lr[0], lr[1], lr[2]); lr[0] /= l; lr[1] /= l; lr[2] /= l;
    lu[0] = lr[1] * lf[2] - lr[2] * lf[1]; lu[1] = lr[2] * lf[0] - lr[0] * lf[2]; lu[2] = lr[0] * lf[1] - lr[1] * lf[0];
  }
  const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;

  // sphere enclosing the view slice [n, f]: centre on the view axis at the distance that minimises the radius
  function sliceSphere(n, f, tanX, tanY, out) {
    const k = 1 + tanX * tanX + tanY * tanY;
    const d = Math.min(f, 0.5 * (n + f) * k);
    const r = Math.max(Math.sqrt((f - d) * (f - d) + f * f * (k - 1)), Math.sqrt((d - n) * (d - n) + n * n * (k - 1)));
    out[0] = d; out[1] = Math.ceil(r * 1.04);
    return out;
  }
  // cascade matrix for a sphere at distance d along the view axis with radius R
  function fit(c, cam, d, R, toSun) {
    // world-space centre, snapped to the texel grid on the light's axes
    let wx = cam.pos[0] + cam.f[0] * d, wy = cam.pos[1] + cam.f[1] * d, wz = cam.pos[2] + cam.f[2] * d;
    const texel = 2 * R / size;
    const a = dot(lr, wx, wy, wz), b = dot(lu, wx, wy, wz);
    const da = Math.round(a / texel) * texel - a, db = Math.round(b / texel) * texel - b;
    wx += lr[0] * da + lu[0] * db; wy += lr[1] * da + lu[1] * db; wz += lr[2] * da + lu[2] * db;
    // camera-relative centre at render time
    const cx = wx - cam.pos[0], cy = wy - cam.pos[1], cz = wz - cam.pos[2];
    const zmin = -(R + toSun), zmax = R + 60, kz = 2 / (zmax - zmin), m = c.m;
    m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = -dot(lr, cx, cy, cz) / R;
    m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = -dot(lu, cx, cy, cz) / R;
    m[2] = lf[0] * kz; m[6] = lf[1] * kz; m[10] = lf[2] * kz; m[14] = -(dot(lf, cx, cy, cz) + zmin) * kz - 1;
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    c.cam[0] = cam.pos[0]; c.cam[1] = cam.pos[1]; c.cam[2] = cam.pos[2];
    c.texel = texel; c.r = R; c.cx = wx; c.cy = wy; c.cz = wz; c.valid = true;
  }

  const saveVP = new Float32Array(16), sph = [0, 0];
  // render the cascades that are due this frame. drawCasters(i, cascade) draws into the bound depth target with
  // env.vp set to the cascade's matrix and env.shadowPass = 1.
  function render(cam, drawCasters) {
    if (!enabled) return;
    if (size !== P.size) allocate(P.size);
    frame++;
    basis();
    const tanY = Math.tan(cam.fovY / 2), tanX = tanY * (gl.canvas.width / gl.canvas.height);
    const nc = P.splits.length - 1;
    count = nc + (P.far ? 1 : 0);
    saveVP.set(env.vp);
    env.shadowPass = 1;
    // the map can't stay bound for sampling while it is the render target (WebGL rejects the feedback loop)
    gl.activeTexture(gl.TEXTURE0 + UNIT); gl.bindTexture(gl.TEXTURE_2D_ARRAY, null); gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(false, false, false, false);
    for (let i = 0; i < count; i++) {
      const c = cas[i], isFar = i === nc;
      let due;
      if (isFar) {
        // terrain-only, huge: refresh when the camera has drifted a good way across it
        const moved = Math.hypot(cam.pos[0] - c.cam[0], cam.pos[2] - c.cam[2]);
        due = !c.valid || moved > c.r * 0.08 || frame - c.last > 600;
      } else due = !c.valid || (frame + i) % P.every[i] === 0;
      if (!due) continue;
      if (isFar) fit(c, cam, 0, P.far, 3500); // a square around the camera: valid whichever way it turns
      else { sliceSphere(P.splits[i], P.splits[i + 1], tanX, tanY, sph); fit(c, cam, sph[0], sph[1], 3000); } // reach 3 km toward the sun for hills
      c.last = frame;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
      gl.viewport(0, 0, size, size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      // slope-scaled depth bias grows with texel size
      gl.polygonOffset(1.6, 2.0);
      env.vp.set(c.m);
      drawCasters(i, { far: isFar, near: i < 2, texel: c.texel, r: c.r });
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.CULL_FACE);
    env.vp.set(saveVP);
    env.shadowPass = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // uniforms for sampling: matrices (rel at render), offsets camNow − camRender, texel size
    for (let i = 0; i < MAXC; i++) {
      const c = cas[i];
      uM.set(c.m, i * 16);
      uP[i * 4] = cam.pos[0] - c.cam[0]; uP[i * 4 + 1] = cam.pos[1] - c.cam[1]; uP[i * 4 + 2] = cam.pos[2] - c.cam[2];
      uP[i * 4 + 3] = c.texel;
    }
    uS[0] = count; uS[1] = P.pcf; uS[2] = 1; uS[3] = count ? cas[count - 1].r : 0;
    gl.activeTexture(gl.TEXTURE0 + UNIT); gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex); gl.activeTexture(gl.TEXTURE0);
  }
  function disable() { uS[2] = 0; }
  function setEnvShadow(u) {
    if (!u.uShadowMap) return;
    gl.uniform1i(u.uShadowMap, UNIT);
    gl.uniformMatrix4fv(u.uCasM, false, uM);
    gl.uniform4fv(u.uCasP, uP);
    gl.uniform4fv(u.uShadowP, uS);
  }
  // world-space sphere of cascade i (for casters to cull against)
  function sphere(i) { const c = cas[i]; return [c.cx, c.cy, c.cz, c.r]; }
  return { render, disable, setEnvShadow, sphere, PRESETS, cascades: cas,
    get preset() { return P; }, set preset(p) { P = PRESETS[p] || PRESETS.high; for (const c of cas) c.valid = false; },
    get enabled() { return enabled; }, set enabled(v) { enabled = !!v; if (!v) uS[2] = 0; },
    get count() { return count; } };
})();
