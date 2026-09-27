'use strict';
// ───────────────────────── Model viewer: renders registered MODELS on demand for inspection ─────────────────────────
// VIEWER.frame({ yaw, pitch, dist, target:[x,y,z], fov, time, fp, stick:[x,y], jet, ground }) renders one frame.
// Angles in degrees. Nothing animates unless you call frame() again with a new time.
const VIEWER = (() => {
  const { gl, canvas, env, program } = GLX;
  const n = Math.hypot(0.42, 0.64, -0.64);
  env.sun.set([0.42 / n, 0.64 / n, -0.64 / n]);
  ATMOS.setHaze(1.6);
  const invVP = new Float32Array(16);
  // same lighting path as the game: atmosphere LUTs → scene-linear light → HDR target → post
  function applyLight() {
    const L = ATMOS.light;
    if (L.ready) { env.sunCol.set(L.sun); env.amb.set(L.amb); env.zen.set(L.zen); env.hor.set(L.hor); return; }
    const c = ATMOS.lighting(env.cam[1], env.sun);
    for (let k = 0; k < 3; k++) { env.sunCol[k] = c.sun[k] / Math.PI; env.amb[k] = c.sky[k] / Math.PI; env.zen[k] = env.amb[k] * 0.9; env.hor[k] = env.amb[k] * 1.3; }
  }

  const SKY = program(`out vec2 vP; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vP = p*2.0-1.0; gl_Position = vec4(vP, 1.0, 1.0); }`,
    GLSL_COMMON + `in vec2 vP; uniform vec3 uCR, uCU, uCF; uniform vec2 uTan; out vec4 o;
void main(){ vec3 d = normalize(uCF + uCR*vP.x*uTan.x + uCU*vP.y*uTan.y); o = vec4(skyCol(d), 1.0); }`);
  const GROUND = program(GLSL_COMMON + `layout(location=0) in vec2 aP; uniform mat4 uVP; out vec3 vRel;
void main(){ vRel = vec3(aP.x*400.0, -uCam.y, aP.y*400.0); gl_Position = uVP*vec4(vRel, 1.0); }`,
    GLSL_COMMON + `in vec3 vRel; out vec4 o;
void main(){
  vec2 p = vRel.xz + uCam.xz;
  vec3 c = vec3(0.4, 0.6, 0.28);
  vec2 g1 = abs(fract(p) - 0.5), g5 = abs(fract(p/5.0) - 0.5);
  float l1 = 1.0 - smoothstep(0.0, 0.02, min(0.5 - g1.x, 0.5 - g1.y)) ;
  float l5 = 1.0 - smoothstep(0.0, 0.006, min(0.5 - g5.x, 0.5 - g5.y));
  c *= 1.0 - l1*0.12 - l5*0.25;
  o = vec4(fogIt(toLin(c)*(uSunCol*max(uSun.y, 0.0)*sunShadow(vRel, vec3(0.0, 1.0, 0.0)) + uAmb), vRel), 1.0);
}`);
  const vaoS = gl.createVertexArray();
  const vaoG = gl.createVertexArray();
  gl.bindVertexArray(vaoG);
  GLX.attribs(GLX.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);

  const cam = { pos: [0, 0, 0], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1], q: [0, 0, 0, 1], fovY: 0.9, tanX: 1, tanY: 1 };
  const proj = new Float32Array(16), view = new Float32Array(16);
  // a stand-in for FLIGHT.g so the glider module can be previewed
  const g = { pos: [0, 0, 0], vel: [0, 0, -25], q: [0, 0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1], stick: [0, 0], boost: false,
    jet: 0, V: 25, alpha: 0.02, beta: 0, phi: 0, rollRate: 0, yawRateW: 0, nload: 1, agl: 50, onGround: false, crashT: 0, live: true, breath: 1 };
  let last = {};

  function frame(o = {}) {
    o = Object.assign({ yaw: 35, pitch: 18, dist: 14, target: [0, 1.5, 0], fov: 50, time: env.time, fp: false, ground: true }, last, o);
    last = o;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    env.time = o.time;
    g.stick[0] = o.stick ? o.stick[0] : 0; g.stick[1] = o.stick ? o.stick[1] : 0; g.jet = o.jet || 0;
    g.rollRate = g.stick[0] * 1.5;
    const aspect = w / h;
    if (o.fp && typeof GLIDER !== 'undefined' && GLIDER.HEAD) {
      cam.pos = GLIDER.HEAD.slice();
      const yaw = (o.yaw || 0) * Math.PI / 180, pitch = (o.pitch || 0) * Math.PI / 180;
      cam.f = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    } else {
      const yaw = o.yaw * Math.PI / 180, pitch = o.pitch * Math.PI / 180;
      const off = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      cam.pos = [o.target[0] + off[0] * o.dist, o.target[1] + off[1] * o.dist, o.target[2] + off[2] * o.dist];
      cam.f = MESH.V3.norm(MESH.V3.sub(o.target, cam.pos));
    }
    cam.r = MESH.V3.norm(MESH.V3.cross(cam.f, [0, 1, 0]));
    cam.u = MESH.V3.cross(cam.r, cam.f);
    Q.fromBasis(cam.q, cam.r, cam.u, [-cam.f[0], -cam.f[1], -cam.f[2]]);
    cam.fovY = o.fov * Math.PI / 180; cam.tanY = Math.tan(cam.fovY / 2); cam.tanX = cam.tanY * aspect;
    env.cam[0] = cam.pos[0]; env.cam[1] = cam.pos[1]; env.cam[2] = cam.pos[2];
    M4.persp(proj, cam.fovY, aspect, o.fp ? 0.02 : 0.1, 20000);
    M4.view(view, cam.r, cam.u, cam.f);
    M4.mul(env.vp, proj, view);
    M4.inv(invVP, env.vp);
    ATMOS.update(Math.max(cam.pos[1], 1) + 60, env.sun, invVP);
    applyLight();
    env.atm[0] = 1 / w; env.atm[1] = 1 / h; env.atm[2] = 1.4; env.atm[3] = ATMOS.state.camH;
    const ctx = { dt: 0, time: env.time, cam, g, env, drift: [0, 0, 0], fp: !!o.fp, mode: 'viewer', viewer: true, opts: o, vp: env.vp, shadow: -1 };
    const drawModels = () => {
      for (const m of MODELS) {
        if (m.preview) m.preview(ctx);
        else { if (m.update) m.update(0, ctx); if (m.drawOpaque) m.drawOpaque(ctx); if (m.drawTransparent && ctx.shadow < 0) m.drawTransparent(ctx); }
      }
    };
    SHADOW.render(cam, i => { ctx.shadow = i; drawModels(); ctx.shadow = -1; });
    POST.begin(w, h, 4);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(SKY.p); GLX.setEnv(SKY);
    gl.uniform3fv(SKY.u.uCR, cam.r); gl.uniform3fv(SKY.u.uCU, cam.u); gl.uniform3fv(SKY.u.uCF, cam.f); gl.uniform2f(SKY.u.uTan, cam.tanX, cam.tanY);
    gl.bindVertexArray(vaoS); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    if (o.ground) { gl.useProgram(GROUND.p); GLX.setEnv(GROUND); gl.bindVertexArray(vaoG); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
    const t0 = performance.now();
    drawModels();
    const ms = performance.now() - t0;
    POST.opts.exposure = 1.0;
    POST.end(env.time);
    const err = gl.getError();
    document.getElementById('info').textContent =
      `models: ${MODELS.map(m => m.name || '?').join(', ')}\ncam yaw ${o.yaw} pitch ${o.pitch} dist ${o.dist} fov ${o.fov}${o.fp ? ' (first person)' : ''}\ncpu ${ms.toFixed(2)} ms  gl error ${err}`;
    return { ms, glError: err };
  }
  window.addEventListener('resize', () => frame());
  // keep presenting the last requested view so screenshots always have a fresh frame
  const loop = () => { requestAnimationFrame(loop); frame(); };
  requestAnimationFrame(loop);
  return { frame, cam, g };
})();
VIEWER.frame();
