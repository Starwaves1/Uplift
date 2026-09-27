'use strict';
// ───────────────────────── Sun shafts: light marched through the haze against the shadow maps and cloud shadows ─────────────────────────
// Each view ray is sampled at reduced resolution. Sunlit haze scatters sunlight toward the eye (mostly forward: bright
// shafts toward the sun through cloud gaps and trees); haze the sun can't reach loses the in-scattered light the aerial
// perspective assumed it had (mountain and cloud shadows reach out into the air at dusk). The result is blended over the
// scene before transparents: rgb added (signed), cloud transmittance hides shafts behind clouds.
const SHAFTS = (() => {
  const { gl, env, program } = GLX;
  const FS_VS = `out vec2 vUV; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const vao = gl.createVertexArray();
  const MARCH = program(FS_VS, GLSL_COMMON + `
uniform sampler2D uDepth, uCloudT; uniform mat4 uInvVP; uniform vec2 uDepthScale;
uniform vec4 uK; // (haze extinction at sea level /m, steps, max distance m, frame)
uniform float uHasClouds;
uniform vec4 uSunScr; // sun on screen: (u, v, strength, aspect)
in vec2 vUV; out vec4 o;
// sun visibility for a point in the air: first cascade that holds it, one hardware-filtered tap
float volShadow(vec3 rel){
  if (uShadowP.z < 0.5) return 1.0;
  int nc = int(uShadowP.x);
  for (int i = 0; i < 5; i++){
    if (i >= nc) break;
    vec3 sc = (uCasM[i]*vec4(rel + uCasP[i].xyz, 1.0)).xyz*0.5 + 0.5;
    if (sc.x > 0.01 && sc.y > 0.01 && sc.x < 0.99 && sc.y < 0.99 && sc.z < 1.0) return texture(uShadowMap, vec4(sc.xy, float(i), sc.z));
  }
  return 1.0;
}
float hgPhase(float c, float g){ float g2 = g*g; return (1.0 - g2)/(12.566371*pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5)); }
void main(){
  vec2 ndc = vUV*2.0 - 1.0;
  vec4 w = uInvVP*vec4(ndc, 1.0, 1.0); vec3 rd = normalize(w.xyz/w.w);
  float z = texelFetch(uDepth, ivec2(gl_FragCoord.xy*uDepthScale), 0).r;
  float sceneD = 1e9;
  if (z < 1.0) { vec4 q = uInvVP*vec4(ndc, z*2.0 - 1.0, 1.0); sceneD = length(q.xyz/q.w); }
  float tMax = min(sceneD, uK.z);
  int steps = int(uK.y);
  float jitter = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uK.w*0.618034);
  // steps spaced quadratically: dense near the camera where shadow detail is finest
  float lit = 0.0, all_ = 0.0, T = 1.0, prevT = 0.0;
  for (int i = 0; i < 48; i++){
    if (i >= steps) break;
    float f = (float(i) + jitter)/float(steps), t = f*f*tMax;
    float ds = t - prevT; prevT = t;
    vec3 p = rd*t;
    float sig = uK.x*exp(-max(uCam.y + p.y, 0.0)/1300.0);
    float vis = volShadow(p)*cloudShadow(p);
    float wgt = sig*T*ds;
    lit += vis*wgt; all_ += wgt;
    T *= exp(-sig*ds);
  }
  float mu = dot(rd, uSun);
  float ph = hgPhase(mu, 0.6)*0.8 + 0.0796*0.2;
  vec3 sunE = uSunCol*3.14159265;
  vec3 shaft = sunE*ph*lit;                                  // sunlight scattered by lit haze (extra, forward-peaked)
  float shadowFrac = all_ > 0.0 ? 1.0 - lit/all_ : 0.0;       // share of this ray's haze the sun can't reach
  vec3 ap = aerial(tMax).rgb;                                 // the haze glow the aerial perspective already added
  vec3 L = shaft - ap*shadowFrac*0.9; // the rays are mostly carved out of the existing haze glow
  // screen-space beams: sky visibility (terrain and clouds block it) traced toward the sun, so light fans out
  // around peaks and cloud edges when the sun is in view
  if (uSunScr.z > 0.001) {
    vec2 dv = (uSunScr.xy - vUV)/32.0;
    vec2 uv = vUV + dv*jitter;
    vec2 dsz = vec2(textureSize(uDepth, 0));
    float sum = 0.0, decay = 1.0;
    for (int i = 0; i < 32; i++){
      float zz = texelFetch(uDepth, ivec2(clamp(uv, 0.0, 0.999)*dsz), 0).r;
      float ct = uHasClouds > 0.5 ? texture(uCloudT, uv).a : 1.0;
      vec2 q = (uv - uSunScr.xy)*vec2(uSunScr.w, 1.0);
      sum += step(1.0, zz)*ct*exp(-dot(q, q)*18.0)*decay;
      decay *= 0.965;
      uv += dv;
    }
    L += sunE*(sum/32.0)*uSunScr.z;
  }
  // shafts behind a cloud are hidden by it
  if (uHasClouds > 0.5) L *= texture(uCloudT, vUV).a;
  o = vec4(L, 1.0);
}`);
  const COMP = program(FS_VS, `uniform sampler2D uS; uniform vec2 uTx; in vec2 vUV; out vec4 o;
void main(){
  vec3 c = texture(uS, vUV).rgb*0.4 + (texture(uS, vUV + vec2(uTx.x, 0.0)).rgb + texture(uS, vUV - vec2(uTx.x, 0.0)).rgb
         + texture(uS, vUV + vec2(0.0, uTx.y)).rgb + texture(uS, vUV - vec2(0.0, uTx.y)).rgb)*0.15;
  o = vec4(c, 0.0);
}`);
  let rt = null, rw = 0, rh = 0, frame = 0;
  function target(w, h) {
    if (rt && w === rw && h === rh) return;
    if (rt) { gl.deleteTexture(rt.t); gl.deleteFramebuffer(rt.f); }
    rw = w; rh = h;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    rt = { t, f };
  }
  const PRESETS = { high: { div: 3, steps: 24, maxD: 9000 }, medium: { div: 4, steps: 14, maxD: 7000 }, low: null };
  let P = PRESETS.high;
  const invVP = new Float32Array(16);
  // march into the reduced target; needs the resolved scene depth and (optionally) the clouds' transmittance
  function render(depthTex, cloudTex, sceneW, sceneH, haze) {
    if (!P) return false;
    const w = Math.max(1, Math.round(sceneW / P.div)), h = Math.max(1, Math.round(sceneH / P.div));
    target(w, h);
    M4.inv(invVP, env.vp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.f);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    gl.useProgram(MARCH.p); GLX.setEnv(MARCH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.uniform1i(MARCH.u.uDepth, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, cloudTex); gl.uniform1i(MARCH.u.uCloudT, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(MARCH.u.uHasClouds, cloudTex ? 1 : 0);
    // the sun's screen position (a direction: w = 0); beams fade as it leaves the view and are strongest when it's low
    const m = env.vp, sx = env.sun[0], sy = env.sun[1], sz = env.sun[2];
    const cx = m[0] * sx + m[4] * sy + m[8] * sz, cy = m[1] * sx + m[5] * sy + m[9] * sz, cw = m[3] * sx + m[7] * sy + m[11] * sz;
    let str = 0, u = 0.5, v = 0.5;
    if (cw > 1e-4) {
      u = cx / cw * 0.5 + 0.5; v = cy / cw * 0.5 + 0.5;
      const off = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
      str = Math.max(0, Math.min(1, (0.95 - off) / 0.4)) * (0.025 + 0.055 * (1 - Math.min(1, sy / 0.6)));
    }
    gl.uniform4f(MARCH.u.uSunScr, u, v, str, sceneW / sceneH);
    gl.uniformMatrix4fv(MARCH.u.uInvVP, false, invVP);
    gl.uniform2f(MARCH.u.uDepthScale, sceneW / w, sceneH / h);
    gl.uniform4f(MARCH.u.uK, 1 / 70000 * (haze || 1), P.steps, P.maxD, frame++ % 64);
    const ax = env.atm[0], ay = env.atm[1];
    env.atm[0] = 1 / w; env.atm[1] = 1 / h; gl.uniform4fv(MARCH.u.uAtm, env.atm); env.atm[0] = ax; env.atm[1] = ay;
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
  function composite() {
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(COMP.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.t); gl.uniform1i(COMP.u.uS, 0);
    gl.uniform2f(COMP.u.uTx, 0.8 / rw, 0.8 / rh);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  return { render, composite, PRESETS, get enabled() { return !!P; },
    get preset() { return P; }, set preset(p) { P = p in PRESETS ? PRESETS[p] : PRESETS.high; } };
})();
