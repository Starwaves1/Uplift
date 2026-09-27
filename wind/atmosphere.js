'use strict';
// ───────────────────────── Atmosphere: physically based sky + aerial perspective (after Hillaire 2020) ─────────────────────────
// LUTs: transmittance (static), multiple scattering (static), sky-view (per frame), aerial perspective froxels (per frame).
// All radiance is scene-linear, scaled so the sun's illuminance at the top of the atmosphere is SUN_I.
const ATMOS = (() => {
  const { gl, program } = GLX;
  const SUN_I = 5.0;          // sun illuminance multiplier (scene-linear); exposure maps it to screen
  const AP_SLICES = ATMOS_AP_SLICES, AP_RANGE = ATMOS_AP_RANGE_M / 1000; // aerial perspective froxels, km
  const COMMON = `
const float PI = 3.14159265;
const float Rg = 6360.0, Rt = 6460.0;
const vec3 RAY_S = vec3(5.802, 13.558, 33.1)*1e-3;
const float RAY_H = 8.0;
const float MIE_S = 3.996e-3, MIE_E = 4.40e-3, MIE_H = 1.2;
const vec3 OZONE_A = vec3(0.650, 1.881, 0.085)*1e-3;
uniform float uHaze;  // scales Mie density: 1 = clear, >1 hazy
void medium(float h, out vec3 scatR, out float scatM, out vec3 ext){
  float rd = exp(-h/RAY_H), md = exp(-h/MIE_H)*uHaze, od = max(0.0, 1.0 - abs(h - 25.0)/15.0);
  scatR = RAY_S*rd; scatM = MIE_S*md; ext = scatR + vec3(MIE_E*md) + OZONE_A*od;
}
float raySphere(vec3 ro, vec3 rd, float R){ // distance to exit (or first hit) of sphere at origin; -1 if miss
  float b = dot(ro, rd), c = dot(ro, ro) - R*R, d = b*b - c;
  if (d < 0.0) return -1.0;
  float s = sqrt(d);
  return (-b - s > 0.0) ? -b - s : -b + s;
}
float phaseR(float c){ return 3.0/(16.0*PI)*(1.0 + c*c); }
float phaseM(float c){ const float g = 0.8; float g2 = g*g;
  return 3.0/(8.0*PI)*((1.0 - g2)*(1.0 + c*c))/((2.0 + g2)*pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5)); }
const float H_ = 1153.6; // sqrt(Rt²-Rg²)
vec2 transUV(float r, float mu){
  float rho = sqrt(max(0.0, r*r - Rg*Rg));
  float disc = r*r*(mu*mu - 1.0) + Rt*Rt;
  float d = max(0.0, -r*mu + sqrt(max(disc, 0.0)));
  float dmin = Rt - r, dmax = rho + H_;
  return vec2((d - dmin)/(dmax - dmin), rho/H_);
}
`;
  const FS_VS = `out vec2 vUV; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const vao = gl.createVertexArray();

  const TRANS = program(FS_VS, COMMON + `in vec2 vUV; out vec4 o;
void main(){
  float xmu = gl_FragCoord.x/256.0, xr = gl_FragCoord.y/64.0;
  float rho = H_*xr, r = sqrt(rho*rho + Rg*Rg);
  float dmin = Rt - r, dmax = rho + H_, d = dmin + xmu*(dmax - dmin);
  float mu = d == 0.0 ? 1.0 : clamp((H_*H_ - rho*rho - d*d)/(2.0*r*d), -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0), rd = vec3(sqrt(1.0 - mu*mu), mu, 0.0);
  float len = raySphere(ro, rd, Rt);
  vec3 od = vec3(0.0); const int N = 40;
  for (int i = 0; i < N; i++){
    vec3 p = ro + rd*len*(float(i) + 0.5)/float(N);
    vec3 sR; float sM; vec3 e; medium(length(p) - Rg, sR, sM, e);
    od += e*len/float(N);
  }
  o = vec4(exp(-od), 1.0);
}`);
  const LUTS = `
uniform sampler2D uTrans, uMulti;
vec3 trans(float r, float mu){ return texture(uTrans, transUV(r, mu)).rgb; }
vec3 multi(float r, float mu){ return texture(uMulti, vec2(mu*0.5 + 0.5, (r - Rg)/(Rt - Rg))).rgb; }
`;
  const MULTI = program(FS_VS, COMMON + `uniform sampler2D uTrans; vec3 trans(float r, float mu){ return texture(uTrans, transUV(r, mu)).rgb; }
in vec2 vUV; out vec4 o;
void main(){
  float mus = (gl_FragCoord.x/32.0)*2.0 - 1.0, r = Rg + (gl_FragCoord.y/32.0)*(Rt - Rg);
  vec3 ro = vec3(0.0, r, 0.0), sun = vec3(sqrt(max(0.0, 1.0 - mus*mus)), mus, 0.0);
  vec3 L2 = vec3(0.0), Fms = vec3(0.0);
  const int D = 8;
  for (int a = 0; a < D; a++) for (int b = 0; b < D; b++){
    float th = PI*(float(a) + 0.5)/float(D), ph = 2.0*PI*(float(b) + 0.5)/float(D);
    vec3 rd = vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph));
    float tG = raySphere(ro, rd, Rg), tT = raySphere(ro, rd, Rt);
    float len = tG > 0.0 ? tG : tT;
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    const int N = 20;
    float dt = len/float(N);
    for (int i = 0; i < N; i++){
      vec3 p = ro + rd*dt*(float(i) + 0.5); float pr = length(p);
      vec3 sR; float sM; vec3 e; medium(pr - Rg, sR, sM, e);
      vec3 ts = trans(pr, dot(p/pr, sun));
      vec3 S = (sR + sM)*(1.0/(4.0*PI))*ts, Sf = (sR + sM)*(1.0/(4.0*PI));
      vec3 st = exp(-e*dt);
      L += T*(S - S*st)/max(e, vec3(1e-6)); F += T*(Sf - Sf*st)/max(e, vec3(1e-6));
      T *= st;
    }
    if (tG > 0.0) { vec3 p = ro + rd*tG; float pr = length(p); L += T*trans(pr, dot(p/pr, sun))*max(dot(p/pr, sun), 0.0)*(0.3/PI); }
    // second-order light = the isotropic average over the sphere of L (L already carries the 1/4π phase);
    // Fms = the average transfer, whose geometric series 1/(1 - Fms) sums all higher orders (Hillaire 2020)
    L2 += L/float(D*D); Fms += F*(4.0*PI/float(D*D));
  }
  o = vec4(L2/(1.0 - Fms), 1.0);
}`);
  // integrate in-scattering along a ray (shared by sky-view and aerial perspective)
  const MARCH = `
uniform vec3 uSunDir; uniform float uSunI;
vec3 inscatter(vec3 ro, vec3 rd, float tMax, int N, out vec3 T){
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu), pM = phaseM(mu);
  T = vec3(1.0); vec3 L = vec3(0.0);
  float dt = tMax/float(N);
  for (int i = 0; i < 64; i++){
    if (i >= N) break;
    vec3 p = ro + rd*dt*(float(i) + 0.5); float pr = length(p);
    vec3 up = p/pr;
    vec3 sR; float sM; vec3 e; medium(pr - Rg, sR, sM, e);
    float cs = dot(up, uSunDir);
    vec3 ts = trans(pr, cs);
    float earthShadow = raySphere(p, uSunDir, Rg) > 0.0 ? 0.0 : 1.0;
    vec3 S = uSunI*(earthShadow*ts*(sR*pR + sM*pM) + multi(pr, cs)*(sR + sM));
    vec3 st = exp(-e*dt);
    L += T*(S - S*st)/max(e, vec3(1e-6));
    T *= st;
  }
  return L;
}
`;
  const SKY = program(FS_VS, COMMON + LUTS + MARCH + `uniform float uCamH; in vec2 vUV; out vec4 o;
void main(){
  float r = Rg + uCamH;
  vec3 ro = vec3(0.0, r, 0.0);
  float vH = sqrt(max(r*r - Rg*Rg, 0.0)), beta = acos(clamp(vH/r, -1.0, 1.0)), zh = PI - beta;
  float v = vUV.y, zen;
  if (v < 0.5) { float c = 1.0 - 2.0*v; c = 1.0 - c*c; zen = zh*c; } else { float c = 2.0*v - 1.0; zen = zh + beta*c*c; }
  float az = (vUV.x - 0.5)*2.0*PI;
  vec3 rd = vec3(sin(zen)*cos(az), cos(zen), sin(zen)*sin(az));
  // sun sits at azimuth 0 in this LUT
  vec3 sunL = normalize(vec3(sqrt(max(0.0, 1.0 - uSunDir.y*uSunDir.y)), uSunDir.y, 0.0));
  float tG = raySphere(ro, rd, Rg), tT = raySphere(ro, rd, Rt);
  float len = tG > 0.0 ? tG : tT;
  vec3 T; vec3 L;
  vec3 sd = uSunDir;
  { // inscatter uses uSunDir; rotate our frame so the sun is at azimuth 0
    L = vec3(0.0); T = vec3(1.0);
    float mu = dot(rd, sunL), pR = phaseR(mu), pM = phaseM(mu);
    float dt = len/30.0;
    for (int i = 0; i < 30; i++){
      vec3 p = ro + rd*dt*(float(i) + 0.5); float pr = length(p); vec3 up = p/pr;
      vec3 sR; float sM; vec3 e; medium(pr - Rg, sR, sM, e);
      float cs = dot(up, sunL);
      vec3 ts = trans(pr, cs);
      float sh = raySphere(p, sunL, Rg) > 0.0 ? 0.0 : 1.0;
      vec3 S = uSunI*(sh*ts*(sR*pR + sM*pM) + multi(pr, cs)*(sR + sM));
      vec3 st = exp(-e*dt);
      L += T*(S - S*st)/max(e, vec3(1e-6)); T *= st;
    }
  }
  o = vec4(L, 1.0);
}`);
  // aerial perspective: one slice per draw; rgb = in-scattered light, a = mean transmittance
  const AP = program(FS_VS, COMMON + LUTS + MARCH + `uniform float uCamH, uSlice; uniform mat4 uInvVP; in vec2 vUV; out vec4 o;
void main(){
  vec4 w = uInvVP*vec4(vUV*2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(w.xyz/w.w);
  float s = (uSlice + 0.5)/${AP_SLICES}.0;
  float dist = s*s*${AP_RANGE.toFixed(1)};
  vec3 ro = vec3(0.0, Rg + uCamH, 0.0);
  float tG = raySphere(ro, rd, Rg);
  if (tG > 0.0) dist = min(dist, tG);
  vec3 T; vec3 L = inscatter(ro, rd, dist, max(4, int(s*16.0) + 2), T);
  o = vec4(L, dot(T, vec3(1.0/3.0)));
}`);

  function makeTex(w, h, internal) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  const trans = makeTex(256, 64, gl.RGBA16F), multi = makeTex(32, 32, gl.RGBA16F), sky = makeTex(192, 108, gl.RGBA16F);
  sky.skyWrap = true;
  gl.bindTexture(gl.TEXTURE_2D, sky.t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  const ap = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, ap);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, 32, 32, AP_SLICES);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  const apFbo = gl.createFramebuffer();

  const state = { sun: [0, 1, 0], haze: 1.0, camH: 0.1, dirty: true, skyH: -1, skySun: [0, 0, 0] };
  function run(p, target, setup) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.f);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(p.p); gl.bindVertexArray(vao);
    if (setup) setup(p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const bindLuts = p => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trans.t); gl.uniform1i(p.u.uTrans, 0);
    if (p.u.uMulti) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, multi.t); gl.uniform1i(p.u.uMulti, 1); }
    gl.uniform1f(p.u.uHaze, state.haze);
  };
  function precompute() {
    state.skyH = -1;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(false);
    run(TRANS, trans, p => gl.uniform1f(p.u.uHaze, state.haze));
    run(MULTI, multi, p => bindLuts(p));
    state.dirty = false;
  }
  // per frame: camera altitude (m), sun direction, camera-relative inverse view-projection (for AP froxels)
  function update(camY, sunDir, invVP) {
    if (state.dirty) precompute();
    state.camH = Math.max(0.001, camY / 1000 + 0.001);
    state.sun[0] = sunDir[0]; state.sun[1] = sunDir[1]; state.sun[2] = sunDir[2];
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(false);
    // the sky-view LUT only depends on altitude and the sun: refresh it when either has moved
    const ss = state.skySun;
    if (Math.abs(state.camH - state.skyH) > 0.012 || ss[0] !== state.sun[0] || ss[1] !== state.sun[1] || ss[2] !== state.sun[2]) {
      run(SKY, sky, p => { bindLuts(p); gl.uniform3fv(p.u.uSunDir, state.sun); gl.uniform1f(p.u.uSunI, SUN_I); gl.uniform1f(p.u.uCamH, state.camH); });
      state.skyH = state.camH; ss[0] = state.sun[0]; ss[1] = state.sun[1]; ss[2] = state.sun[2];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, apFbo);
    gl.viewport(0, 0, 32, 32);
    gl.useProgram(AP.p); gl.bindVertexArray(vao); bindLuts(AP);
    gl.uniform3fv(AP.u.uSunDir, state.sun); gl.uniform1f(AP.u.uSunI, SUN_I); gl.uniform1f(AP.u.uCamH, state.camH);
    gl.uniformMatrix4fv(AP.u.uInvVP, false, invVP);
    for (let s = 0; s < AP_SLICES; s++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ap, 0, s);
      gl.uniform1f(AP.u.uSlice, s);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    envPass();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    bindLutsForScene();
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }

  // ── CPU twin: sun colour and sky irradiance for surface lighting ──
  const RAY = [5.802e-3, 13.558e-3, 33.1e-3], OZ = [0.65e-3, 1.881e-3, 0.085e-3];
  function opticalDepth(r0, mu, out) {
    const b = r0 * mu, c = r0 * r0 - 6460 * 6460, len = -b + Math.sqrt(Math.max(b * b - c, 0));
    out[0] = out[1] = out[2] = 0;
    const N = 48, dt = len / N;
    for (let i = 0; i < N; i++) {
      const t = dt * (i + 0.5), x = Math.sqrt(1 - mu * mu) * t, y = r0 + mu * t, h = Math.hypot(x, y) - 6360;
      if (h < 0) { out[0] = out[1] = out[2] = 1e9; return out; }
      const rd = Math.exp(-h / 8), md = Math.exp(-h / 1.2) * state.haze, od = Math.max(0, 1 - Math.abs(h - 25) / 15);
      for (let k = 0; k < 3; k++) out[k] += (RAY[k] * rd + 4.4e-3 * md + OZ[k] * od) * dt;
    }
    return out;
  }
  const od = [0, 0, 0];
  // returns { sun: rgb illuminance at altitude, sky: approx hemisphere irradiance from the sky (for ambient) }
  function lighting(camY, sunDir) {
    const r0 = 6360 + Math.max(camY, 0) / 1000 + 0.002;
    opticalDepth(r0, sunDir[1], od);
    const sun = od.map(d => SUN_I * Math.exp(-d));
    // sky irradiance: Rayleigh-dominated, scaled by sun elevation and reddened with the sun
    const e = Math.max(0, sunDir[1]);
    const k = 0.95 * Math.pow(e + 0.08, 0.7);
    const sky = [0.18 * k * SUN_I * 0.55, 0.32 * k * SUN_I * 0.55, 0.62 * k * SUN_I * 0.55];
    for (let i = 0; i < 3; i++) sky[i] = sky[i] * 0.75 + sun[i] * 0.05 * e;
    return { sun, sky };
  }

  // ── ENV: 4×1 summary of the lighting for surface shaders, read back asynchronously into uniforms ──
  // texel 0: sun irradiance/π at the camera   1: sky irradiance/π on an up-facing surface
  // texel 2: zenith sky radiance               3: mean sky radiance just above the horizon
  const ENV = program(FS_VS, COMMON + `uniform sampler2D uTrans, uSky; uniform vec3 uSunDir; uniform float uSunI, uCamH; out vec4 o;
vec3 trans(float r, float mu){ return texture(uTrans, transUV(r, mu)).rgb; }
vec3 skyL(vec3 d){
  float r = Rg + uCamH;
  float vH = sqrt(max(r*r - Rg*Rg, 0.0)), beta = acos(clamp(vH/r, -1.0, 1.0)), zh = PI - beta;
  float zen = acos(clamp(d.y, -1.0, 1.0)), v;
  if (zen < zh) { float c = zen/zh; v = 0.5*(1.0 - sqrt(max(1.0 - c, 0.0))); }
  else { float c = (zen - zh)/beta; v = 0.5 + 0.5*sqrt(max(c, 0.0)); }
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5, 0.0));
  float az = atan(d.z, d.x) - atan(sh.y, sh.x);
  return texture(uSky, vec2(fract(az/(2.0*PI) + 0.5), clamp(v, 0.004, 0.996))).rgb;
}
void main(){
  int i = int(gl_FragCoord.x);
  float r = Rg + uCamH;
  vec3 res = vec3(0.0);
  if (i == 0) {
    float muH = -sqrt(max(1.0 - (Rg/r)*(Rg/r), 0.0)); // the sun sets behind the planet's limb
    res = uSunI*trans(r, max(uSunDir.y, muH + 0.001))*smoothstep(muH - 0.004, muH + 0.012, uSunDir.y)/PI;
  } else if (i == 1) {
    for (int a = 0; a < 8; a++) for (int b = 0; b < 16; b++) {
      float ct = (float(a) + 0.5)/8.0, st = sqrt(1.0 - ct*ct), ph = (float(b) + 0.5)/16.0*2.0*PI;
      res += skyL(vec3(st*cos(ph), ct, st*sin(ph)))*ct;
    }
    res *= 2.0*PI/(8.0*16.0)/PI; // ∫L cosθ dω / π  (dω = dcosθ dφ)
  } else if (i == 2) res = skyL(vec3(0.0, 1.0, 0.0));
  else { for (int b = 0; b < 16; b++) { float ph = (float(b) + 0.5)/16.0*2.0*PI; res += skyL(normalize(vec3(cos(ph), 0.05, sin(ph)))); } res /= 16.0; }
  o = vec4(res, 1.0);
}`);
  const envT = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, envT); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 1);
  const envF = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, envF); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, envT, 0);
  const pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 64, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const envData = new Float32Array(16);
  let fence = null, envReady = false, envFrame = 0;
  // results land in these (scene-linear, see core.js): sunCol, amb, zen, hor
  const light = { sun: new Float32Array(3), amb: new Float32Array(3), zen: new Float32Array(3), hor: new Float32Array(3), ready: false };
  function envPass() {
    if (fence) { // a readback is in flight: collect it when the GPU is done, never stall
      const st = gl.clientWaitSync(fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return;
      gl.deleteSync(fence); fence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, envData); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (let k = 0; k < 3; k++) { light.sun[k] = envData[k]; light.amb[k] = envData[4 + k]; light.zen[k] = envData[8 + k]; light.hor[k] = envData[12 + k]; }
      light.ready = true;
    }
    if (++envFrame % 3 && light.ready) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, envF); gl.viewport(0, 0, 4, 1);
    gl.useProgram(ENV.p); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trans.t); gl.uniform1i(ENV.u.uTrans, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sky.t); gl.uniform1i(ENV.u.uSky, 1);
    gl.uniform1f(ENV.u.uHaze, state.haze);
    gl.uniform3fv(ENV.u.uSunDir, state.sun); gl.uniform1f(ENV.u.uSunI, SUN_I); gl.uniform1f(ENV.u.uCamH, state.camH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }
  // bind the sky-view and aerial-perspective LUTs to their reserved units (see GLX.setEnv)
  function bindLutsForScene() {
    gl.activeTexture(gl.TEXTURE0 + GLX.UNIT_SKY); gl.bindTexture(gl.TEXTURE_2D, sky.t);
    gl.activeTexture(gl.TEXTURE0 + GLX.UNIT_AP); gl.bindTexture(gl.TEXTURE_3D, ap);
    gl.activeTexture(gl.TEXTURE0);
  }
  return { update, lighting, light, state, SUN_I,
    setHaze(h) { if (h !== state.haze) { state.haze = h; state.dirty = true; } } };

})();
