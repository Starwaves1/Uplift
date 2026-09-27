'use strict';
// ───────────────────────── Water: FFT ocean (Tessendorf), screen-space + mirrored-cloud reflections, refraction, absorption ─────────────────────────
// Waves: a Phillips spectrum driven by the wind, evolved in time with deep-water dispersion (ω = √(g k)) and brought to
// the spatial domain by a GPU inverse FFT (Stockham radix-2, one pass per stage) in three cascades of different patch
// sizes, so there is no visible tiling and wavelengths run from tens of metres down to ripples a few centimetres long.
// Each cascade yields surface slopes, their squares (for LEAN-style roughness: detail too fine for a pixel becomes
// micro-roughness instead of aliasing) and the Jacobian of the choppy displacement (compressed crests → whitecaps).
// Shading: screen-space reflections of the land against the depth buffer, sky + clouds seen by a mirrored camera where
// they miss, refraction of the bottom through the waves, absorption over the real water depth, GGX sun glitter.
const WATER = (() => {
  const { gl, env, program } = GLX;
  const N = 256, LOGN = 8, NC = 3;
  const PATCH = [94.0, 16.7, 3.1];             // cascade patch sizes (m); ratios avoid a shared repeat
  const FS_VS = `out vec2 vUV; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const vao = gl.createVertexArray();
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  // ── spectrum: h0(k) and conj(h0(−k)) for all cascades, side by side in one N·NC × N atlas (RGBA32F) ──
  const INIT = program(FS_VS, `uniform vec3 uPatch; uniform vec2 uWind; uniform float uWindSpeed, uAmp; out vec4 o;
float hash(vec2 p){ vec3 q = fract(vec3(p.xyx)*vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
vec2 gauss(vec2 p){ // Box–Muller from two hashes
  float u1 = max(hash(p), 1e-6), u2 = hash(p + 17.31);
  float r = sqrt(-2.0*log(u1)); return vec2(r*cos(6.2831853*u2), r*sin(6.2831853*u2));
}
float kc(int c){ return c == 0 ? 6.2831853/uPatch.y*6.0 : 6.2831853/uPatch.z*6.0; }
float phillips(vec2 k, int c){
  float kl = length(k);
  if (kl < 1e-5) return 0.0;
  // cascade band limits: each cascade owns its own range of wavenumbers
  if (c == 0 && kl >= kc(0)) return 0.0;
  if (c == 1 && (kl < kc(0) || kl >= kc(1))) return 0.0;
  if (c == 2 && kl < kc(1)) return 0.0;
  float L = uWindSpeed*uWindSpeed/9.81;
  float kw = dot(k/kl, uWind);
  float dir = kw*kw*(kw < 0.0 ? 0.25 : 1.0);            // waves running against the wind are weak
  float small = 0.0012;                                  // capillary cutoff (m)
  return uAmp*exp(-1.0/(kl*L*kl*L))/(kl*kl*kl*kl)*dir*exp(-kl*kl*small*small);
}
vec2 h0(ivec2 id, int c){
  float P = c == 0 ? uPatch.x : c == 1 ? uPatch.y : uPatch.z;
  vec2 n = vec2(id.x < ${N / 2} ? id.x : id.x - ${N}, id.y < ${N / 2} ? id.y : id.y - ${N});
  vec2 k = n*6.2831853/P;
  float dk = 6.2831853/P;                                // each discrete mode carries P(k)·Δk² of variance
  return gauss(vec2(id) + float(c)*531.7)*sqrt(phillips(k, c)*dk*dk*0.5);
}
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int c = px.x/${N}; ivec2 id = ivec2(px.x - c*${N}, px.y);
  vec2 a = h0(id, c);
  ivec2 mid = ivec2((${N} - id.x) % ${N}, (${N} - id.y) % ${N});
  vec2 b = h0(mid, c); b.y = -b.y;                       // conj(h0(−k))
  o = vec4(a, b);
}`);
  // ── per frame: h(k, t) → spectra of (slope x + i slope z) and (∂Dx/∂x + i ∂Dz/∂z) ──
  const EVOLVE = program(FS_VS, `uniform sampler2D uH0; uniform vec3 uPatch; uniform float uTime; out vec4 o;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int c = px.x/${N}; ivec2 id = ivec2(px.x - c*${N}, px.y);
  float P = c == 0 ? uPatch.x : c == 1 ? uPatch.y : uPatch.z;
  vec2 n = vec2(id.x < ${N / 2} ? id.x : id.x - ${N}, id.y < ${N / 2} ? id.y : id.y - ${N});
  vec2 k = n*6.2831853/P;
  float kl = max(length(k), 1e-5);
  vec4 s = texelFetch(uH0, px, 0);
  float w = sqrt(9.81*kl)*uTime;
  vec2 e = vec2(cos(w), sin(w));
  vec2 h = cmul(s.xy, e) + cmul(s.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);                              // i·h
  // slopes: ∂h/∂x = i kx h, ∂h/∂z = i kz h; packed as sx + i sz (both real fields)
  vec2 sx = ih*k.x, sz = ih*k.y;
  vec2 A = vec2(sx.x - sz.y, sx.y + sz.x);
  // choppy displacement D = −i k̂ h: ∂Dx/∂x = kx²/k h, ∂Dz/∂z = kz²/k h; packed as Dxx + i Dzz
  vec2 dxx = h*(k.x*k.x/kl), dzz = h*(k.y*k.y/kl);
  vec2 B = vec2(dxx.x - dzz.y, dxx.y + dzz.x);
  o = vec4(A, B);
}`);
  // ── one inverse-FFT stage (Stockham autosort): along x within each cascade, or along y ──
  const FFT = program(FS_VS, `uniform sampler2D uSrc; uniform int uStage, uVert; out vec4 o;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int idx = uVert == 1 ? px.y : px.x % ${N};
  int base = uVert == 1 ? 0 : px.x - idx;
  int Ns = 1 << uStage;
  int within = idx % (2*Ns), k = within % Ns;
  int j = (idx/(2*Ns))*Ns + k;
  ivec2 p0 = uVert == 1 ? ivec2(px.x, j) : ivec2(base + j, px.y);
  ivec2 p1 = uVert == 1 ? ivec2(px.x, j + ${N / 2}) : ivec2(base + j + ${N / 2}, px.y);
  vec4 a = texelFetch(uSrc, p0, 0), b = texelFetch(uSrc, p1, 0);
  float ang = 3.14159265*float(k)/float(Ns);
  vec2 tw = vec2(cos(ang), sin(ang));
  vec2 b0 = cmul(tw, b.xy), b1 = cmul(tw, b.zw);
  o = within >= Ns ? vec4(a.xy - b0, a.zw - b1) : vec4(a.xy + b0, a.zw + b1);
}`);
  // ── assemble a cascade layer: (slope x, slope z, slope², Jacobian) → mipmapped RGBA16F array ──
  const ASSEMBLE = program(FS_VS, `uniform sampler2D uSrc; uniform int uLayer; uniform float uChop; out vec4 o;
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(uSrc, ivec2(px.x + uLayer*${N}, px.y), 0);
  float sx = v.x, sz = v.y;
  float J = (1.0 + uChop*v.z)*(1.0 + uChop*v.w);
  o = vec4(sx, sz, sx*sx + sz*sz, J);
}`);

  function tex2D(w, h, fmt, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t, f };
  }
  const h0 = tex2D(N * NC, N, gl.RGBA32F, gl.NEAREST);
  const ping = [tex2D(N * NC, N, gl.RGBA32F, gl.NEAREST), tex2D(N * NC, N, gl.RGBA32F, gl.NEAREST)];
  const LEVELS = LOGN + 1;
  const waves = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, waves);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, LEVELS, gl.RGBA16F, N, N, NC);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  const layerFbo = [];
  for (let c = 0; c < NC; c++) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, waves, 0, c);
    layerFbo.push(f);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const wind = [1, 0]; let windSpeed = 4, amp = 0.0009;
  let inited = false, lastT = -1;
  function run(p, fbo, w, h) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); gl.useProgram(p.p); gl.bindVertexArray(vao); }
  // evolve the spectrum and transform it: ~20 small passes; call before the scene pass
  function update(time) {
    if (!P) return;
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    if (!inited) {
      windSpeed = Math.hypot(WORLD.WIND[0], WORLD.WIND[2]); // WORLD loads after this file: read it on first use
      wind[0] = WORLD.WIND[0] / windSpeed; wind[1] = WORLD.WIND[2] / windSpeed;
      run(INIT, h0.f, N * NC, N);
      gl.uniform3f(INIT.u.uPatch, PATCH[0], PATCH[1], PATCH[2]);
      gl.uniform2f(INIT.u.uWind, wind[0], wind[1]);
      gl.uniform1f(INIT.u.uWindSpeed, windSpeed * 1.6); // a little more fetch than the mean wind alone gives
      gl.uniform1f(INIT.u.uAmp, amp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      inited = true;
    }
    if (time === lastT) { gl.enable(gl.DEPTH_TEST); gl.depthMask(true); return; }
    lastT = time;
    run(EVOLVE, ping[0].f, N * NC, N);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, h0.t); gl.uniform1i(EVOLVE.u.uH0, 0);
    gl.uniform3f(EVOLVE.u.uPatch, PATCH[0], PATCH[1], PATCH[2]);
    gl.uniform1f(EVOLVE.u.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    let src = 0;
    gl.useProgram(FFT.p);
    for (let vert = 0; vert < 2; vert++) for (let s = 0; s < LOGN; s++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, ping[1 - src].f);
      gl.bindTexture(gl.TEXTURE_2D, ping[src].t); gl.uniform1i(FFT.u.uSrc, 0);
      gl.uniform1i(FFT.u.uStage, s); gl.uniform1i(FFT.u.uVert, vert);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = 1 - src;
    }
    gl.useProgram(ASSEMBLE.p);
    gl.bindTexture(gl.TEXTURE_2D, ping[src].t); gl.uniform1i(ASSEMBLE.u.uSrc, 0);
    gl.uniform1f(ASSEMBLE.u.uChop, 1.2);
    gl.viewport(0, 0, N, N);
    for (let c = 0; c < NC; c++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layerFbo[c]);
      gl.uniform1i(ASSEMBLE.u.uLayer, c);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, waves); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }

  // ── the water surface ──
  // one flat quad per water body: the sea (level 0, a camera-centred 60 km square) or a lake (its level, its bounds)
  const WVS = GLSL_COMMON + `layout(location=0) in vec2 aP; uniform mat4 uVP; uniform vec4 uRect; uniform float uLevel; out vec3 vRel;
void main(){
  vec2 w = mix(uRect.xy, uRect.zw, aP*0.5 + 0.5);
  vRel = vec3(w.x - uCam.x, uLevel - uCam.y, w.y - uCam.z); gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const WFS = GLSL_COMMON + `
in vec3 vRel; out vec4 o;
uniform mat4 uVP;
uniform mediump sampler2DArray uWaves;
uniform sampler2D uScene, uDepth, uMirror;
uniform vec3 uPatch, uCamF, uG, uGV; uniform float uGAgl;
uniform vec4 uQ;       // (SSR steps, mirror clouds on, near, far)
uniform vec4 uAmpC;    // per-cascade slope scale, gust sensitivity
uniform sampler2D uLakeMask; uniform float uLake;   // lakes: this lake's id in the island's lake mask (0 = the sea)
const float PI = 3.14159265;
// sun visibility for the surface: one hardware-filtered tap is plenty under ripples (× cloud shadows)
float waterShadow(vec3 rel){
  float cs = cloudShadow(rel);
  if (uShadowP.z < 0.5) return cs;
  int nc = int(uShadowP.x);
  for (int i = 0; i < 5; i++){
    if (i >= nc) break;
    vec3 sc = (uCasM[i]*vec4(rel + uCasP[i].xyz + vec3(0.0, uCasP[i].w, 0.0), 1.0)).xyz*0.5 + 0.5;
    if (sc.x > 0.01 && sc.y > 0.01 && sc.x < 0.99 && sc.y < 0.99 && sc.z < 1.0) return cs*texture(uShadowMap, vec4(sc.xy, float(i), sc.z));
  }
  return cs;
}
float linZ(float z){ float n = uQ.z, f = uQ.w; return 2.0*n*f/(f + n - (z*2.0 - 1.0)*(f - n)); }
// screen-space reflection against the depth buffer: march the reflected ray, project, look for where it passes behind
// what the camera saw; returns rgb + confidence
vec4 ssr(vec3 P, vec3 R, float dist){
  int steps = int(uQ.x);
  float t = 0.6 + dist*0.004, prevT = 0.0;
  for (int i = 0; i < 64; i++){
    if (i >= steps || t > 6000.0) break;                 // beyond ~6 km a reflected shore is haze anyway
    vec3 q = P + R*t;
    vec4 c = uVP*vec4(q, 1.0);
    if (c.w <= 0.1) break;
    vec3 nd = c.xyz/c.w;
    vec2 uv = nd.xy*0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float zs = texture(uDepth, uv).r;
    float zq = linZ(nd.z*0.5 + 0.5), zb = linZ(zs);
    if (zs < 1.0 && zq > zb && zq - zb < max(4.0, t*0.25)) {
      // refine between the last miss and this hit
      float a = prevT, b = t;
      for (int k = 0; k < 5; k++){
        float m = 0.5*(a + b); vec4 cm = uVP*vec4(P + R*m, 1.0); vec3 nm = cm.xyz/cm.w; vec2 um = nm.xy*0.5 + 0.5;
        if (linZ(nm.z*0.5 + 0.5) > linZ(texture(uDepth, um).r)) b = m; else a = m;
      }
      vec4 cb = uVP*vec4(P + R*b, 1.0); vec2 ub = cb.xy/cb.w*0.5 + 0.5;
      vec2 e = min(ub, 1.0 - ub);
      float conf = smoothstep(0.0, 0.08, min(e.x, e.y))*(1.0 - smoothstep(0.6, 1.0, float(i)/float(steps)));
      return vec4(texture(uScene, ub).rgb, conf);
    }
    prevT = t;
    t *= 1.36;
  }
  return vec4(0.0);
}
void main(){
  vec3 wp = vRel + uCam; float dist = length(vRel); vec3 v = vRel/dist;
  vec2 p = wp.xz;
  if (uLake > 0.5 && abs(texture(uLakeMask, (p - uHeightP.x)*uHeightP.y/uHeightP.z).r*255.0 - uLake) > 0.5) discard;
  vec3 wg = windGust(p);
  // ── surface slopes from the three cascades (mipmapped: unresolved slope variance becomes roughness) ──
  vec2 s = vec2(0.0), sLow = vec2(0.0); float var = 0.0, J = 1.0;
  // a short cascade tiles every few metres: well before its pattern could read as a grid, hand its (known) slope
  // variance over to micro-roughness instead of sampling it
  const vec3 MS = vec3(0.0082, 0.0059, 0.0116);            // mean-square slope of each cascade (measured)
  // (the footprint grows at grazing angles, so the hand-over comes sooner there)
  float graze = max(0.12, abs(v.y));
  vec3 keep = vec3(1.0 - smoothstep(4000.0, 9000.0, dist*0.35/graze), 1.0 - smoothstep(150.0, 450.0, dist*0.35/graze),
                   1.0 - smoothstep(25.0, 80.0, dist*0.35/graze));
  for (int c = 0; c < 3; c++){
    float P = c == 0 ? uPatch.x : c == 1 ? uPatch.y : uPatch.z;
    float amp = c == 0 ? uAmpC.x : c == 1 ? uAmpC.y : uAmpC.z;
    amp *= 1.0 + uAmpC.w*(wg.z - 0.22)*float(c);          // gusts roughen the short waves: cat's-paws
    float kc = c == 0 ? keep.x : c == 1 ? keep.y : keep.z;
    var += (1.0 - kc)*MS[c]*amp*amp;
    if (kc <= 0.0) continue;
    vec4 m = texture(uWaves, vec3(p/P, float(c)));
    s += m.xy*amp*kc;
    if (c < 2) sLow += m.xy*amp*kc;
    var += max(m.z - dot(m.xy, m.xy), 0.0)*amp*amp*kc;
    J = min(J, mix(1.0, m.w, amp*kc));
  }
  vec3 n = normalize(vec3(-s.x, 1.0, -s.y));
  float nv = max(dot(-v, n), 1e-3);
  float fres = 0.02 + 0.98*pow(1.0 - nv, 5.0);
  float sh = waterShadow(vRel);
  vec2 suv = gl_FragCoord.xy*uAtm.xy;
  // ── water depth along the view ray, from the terrain in the depth buffer ──
  float bottomD = linZ(texture(uDepth, suv).r)*dist/max(dot(vRel, uCamF), 1e-3);
  float thick = max(bottomD - dist, 0.0), vdepth = thick*nv;
  // ── refraction: the bottom seen through the waves (kept underwater) ──
  vec2 ruv = suv + n.xz*vec2(0.9, 0.9)*min(thick, 4.0)/max(dist, 4.0);
  if (linZ(texture(uDepth, ruv).r) < linZ(gl_FragCoord.z)) ruv = suv;
  vec3 bottom = texture(uScene, ruv).rgb;
  vec3 Tw = exp(-thick*vec3(0.46, 0.085, 0.055));
  vec3 light = uSunCol*max(uSun.y, 0.0)*(0.3 + 0.7*sh) + uAmb;
  vec3 scatter = toLin(vec3(0.035, 0.19, 0.22))*light*0.55;  // light scattered back up out of the water body
  // ── reflection: land by SSR, else sky and the clouds seen from the mirrored camera ──
  vec3 rd = reflect(v, n); rd.y = max(rd.y, 0.02);
  vec3 sky = skyCol(rd);
  // reflections of things (clouds, land) follow the longer waves; the short ones only blur them
  vec3 nR = normalize(vec3(-sLow.x, 1.0, -sLow.y));
  vec3 R = reflect(v, nR); R.y = max(R.y, 0.01); R = normalize(R);
  float blur = clamp(sqrt(var)*1.4, 0.0, 0.1);
  if (uQ.y > 0.5) {
    // the mirror image holds what a flat mirror shows; find where it shows the reflected direction (off the full, wavy
    // normal: ripples break a reflection up and stretch it toward the viewer), blurred by the unresolved roughness
    vec3 Rw = reflect(v, n); Rw.y = max(Rw.y, 0.01);
    vec4 cm = uVP*vec4(Rw.x, -Rw.y, Rw.z, 0.0);
    if (cm.w > 1e-4) {
      vec2 mu = cm.xy/cm.w*0.5 + 0.5;
      vec4 mc = (texture(uMirror, mu)*2.0 + texture(uMirror, mu + vec2(blur*0.5, blur*1.2)) + texture(uMirror, mu - vec2(blur*0.5, blur*1.2))
               + texture(uMirror, mu + vec2(-blur*0.3, blur*2.6)) + texture(uMirror, mu - vec2(-blur*0.3, blur*2.6)))/6.0;
      vec2 e = min(mu, 1.0 - mu);
      mc = mix(vec4(0.0, 0.0, 0.0, 1.0), mc, smoothstep(-0.02, 0.03, min(e.x, e.y))); // off the mirror image: sky only
      sky = sky*mc.a + mc.rgb;
    }
  }
  // where the Fresnel weight is tiny (looking steeply down) a reflection can't be seen: don't trace it
  // …and a steeply rising reflected ray only finds sky (hills round a lake stand a few degrees above it)
  vec4 sr = uQ.x > 0.5 && fres > 0.035 && R.y < 0.4 ? ssr(vRel, R, dist) : vec4(0.0);
  vec3 refl = mix(sky, sr.rgb, sr.a);
  // ── GGX sun glitter on the filtered-out roughness ──
  float a2 = clamp(0.0008 + 2.0*var, 0.0008, 0.3);
  vec3 h = normalize(uSun - v);
  float nh = max(dot(n, h), 0.0), nl = max(dot(n, uSun), 0.0);
  float D = a2/(PI*pow(nh*nh*(a2 - 1.0) + 1.0, 2.0));
  float Fh = 0.02 + 0.98*pow(1.0 - max(dot(h, uSun), 0.0), 5.0);
  float G = 1.0/(1.0 + sqrt(1.0 + a2*(1.0 - nv*nv)/(nv*nv)));  // Smith-ish shadowing at grazing view
  vec3 glint = min(uSunCol*PI*D*Fh*G*nl/(4.0*nv)*4.0, vec3(150.0))*sh;
  // ── foam: whitecaps where crests compress (more in gusts), and the lapping shoreline ──
  float cap = smoothstep(0.35, -0.1, J)*smoothstep(0.25, 0.6, wg.z);
  float fn = vn(p*0.8 + wg.xy*uTime*0.7)*0.6 + vn(p*2.9 - uTime*0.35)*0.4;
  float swash = 0.26 + 0.18*sin(uTime*0.9 + dot(p, wg.xy)*0.25);
  float zerr = dist*dist/(uQ.z*16777216.0)*3.0;
  float shore = (1.0 - smoothstep(0.02, swash + zerr, vdepth))*smoothstep(0.3, 0.65, fn)*(1.0 - smoothstep(300.0, 700.0, dist));
  float foam = clamp(max(cap*smoothstep(0.4, 0.7, fn), shore*0.9), 0.0, 1.0);
  if (uGAgl < 12.0) { // wake where the glider skims the water
    vec2 d = p - uG.xz; vec2 vd = normalize(uGV.xz + vec2(1e-4));
    float along = -dot(d, vd), across = abs(dot(d, vec2(-vd.y, vd.x)));
    float wk = smoothstep(1.2 + along*0.18, 0.0, across)*smoothstep(-2.0, 1.0, along)*exp(-max(along, 0.0)/45.0)*(1.0 - uGAgl/12.0);
    foam = max(foam, wk*(0.75 + 0.25*sin(along*0.9 - uTime*3.0)));
  }
  vec3 foamC = vec3(0.82, 0.86, 0.88)*light;
  // ── compose: the bottom in the scene texture already carries its haze; the surface terms get it here ──
  vec4 ap = aerial(dist);
  vec3 surf = refl*fres + glint;
  vec3 bottomNoHaze = max(bottom - ap.rgb, vec3(0.0))/max(ap.a, 1e-3); // the bottom as it was before its haze
  vec3 col = (bottomNoHaze*Tw + scatter*(1.0 - Tw))*(1.0 - fres) + surf;
  col = mix(col, foamC, foam);
  o = vec4(col*ap.a + ap.rgb, 1.0);
}`;
  const WP = program(WVS, WFS);
  const wvao = gl.createVertexArray();
  gl.bindVertexArray(wvao);
  GLX.attribs(GLX.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);

  const PRESETS = { high: { ssr: 32, mirror: true }, medium: { ssr: 18, mirror: false }, low: null };
  let P = PRESETS.high;
  // sceneTex / depthTex: the resolved scene before water (samplable, not attached to the bound target)
  function draw(g, cam, sceneTex, depthTex, mirrorTex, near, far) {
    gl.disable(gl.BLEND);
    gl.useProgram(WP.p); GLX.setEnv(WP);
    // units 7–10 (11 gust map, 12 cloud map, 13 shadows, 14–15 atmosphere are bound for everyone)
    gl.activeTexture(gl.TEXTURE0 + 7); gl.bindTexture(gl.TEXTURE_2D_ARRAY, waves); gl.uniform1i(WP.u.uWaves, 7);
    gl.activeTexture(gl.TEXTURE0 + 8); gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.uniform1i(WP.u.uScene, 8);
    gl.activeTexture(gl.TEXTURE0 + 9); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.uniform1i(WP.u.uDepth, 9);
    gl.activeTexture(gl.TEXTURE0 + 10); gl.bindTexture(gl.TEXTURE_2D, mirrorTex || sceneTex); gl.uniform1i(WP.u.uMirror, 10);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(WP.u.uPatch, PATCH[0], PATCH[1], PATCH[2]);
    gl.uniform3fv(WP.u.uCamF, cam.f);
    gl.uniform3fv(WP.u.uG, g.pos); gl.uniform3fv(WP.u.uGV, g.vel); gl.uniform1f(WP.u.uGAgl, g.pos[1]);
    gl.uniform4f(WP.u.uQ, P.ssr, mirrorTex && P.mirror ? 1 : 0, near, far);
    gl.uniform4f(WP.u.uAmpC, 1.0, 1.0, 1.0, 2.2);
    gl.bindVertexArray(wvao);
    gl.uniform4f(WP.u.uRect, cam.pos[0] - 30000, cam.pos[2] - 30000, cam.pos[0] + 30000, cam.pos[2] + 30000);
    gl.uniform1f(WP.u.uLevel, 0); gl.uniform1f(WP.u.uLake, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // the island's lakes: calmer water at their own levels, masked to their basins; the cloud mirror is the sea's, so
    // lakes reflect by screen-space tracing and the sky
    const L = lakeData();
    if (L) {
      gl.activeTexture(gl.TEXTURE0 + 18); gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.uniform1i(WP.u.uLakeMask, 18); gl.activeTexture(gl.TEXTURE0);
      gl.uniform4f(WP.u.uQ, P.ssr, 0, near, far);
      gl.uniform4f(WP.u.uAmpC, 0.45, 0.45, 0.6, 1.6);
      for (const lk of L.lakes) {
        const r = lk.rect;
        if (cam.pos[1] < lk.level - 2) continue;
        const dxr = Math.max(r[0] - cam.pos[0], 0, cam.pos[0] - r[2]), dzr = Math.max(r[1] - cam.pos[2], 0, cam.pos[2] - r[3]);
        if (dxr * dxr + dzr * dzr > 30000 * 30000) continue;
        gl.uniform4f(WP.u.uRect, r[0], r[1], r[2], r[3]);
        gl.uniform1f(WP.u.uLevel, lk.level); gl.uniform1f(WP.u.uLake, lk.id);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.bindVertexArray(null);
  }
  // lake mask (R8 ids, nearest) and table, from the island's map file
  let lakeCache;
  function lakeData() {
    if (lakeCache !== undefined) return lakeCache;
    const M = typeof window !== 'undefined' && window.ISLAND_MAPS;
    if (!M || !M.lakeMask || !M.lakes.length) return (lakeCache = null);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + 18); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, M.nl, M.nl);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, M.nl, M.nl, gl.RED, gl.UNSIGNED_BYTE, M.lakeMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.activeTexture(gl.TEXTURE0);
    return (lakeCache = { tex, lakes: M.lakes });
  }
  // debugging / calibration: mean-square slope per cascade (read back from the maps)
  function stats() {
    const px = new Float32Array(N * N * 4), out = [];
    for (let c = 0; c < NC; c++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layerFbo[c]);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, px);
      let ms = 0, jmin = 9;
      for (let i = 0; i < px.length; i += 4) { ms += px[i + 2]; jmin = Math.min(jmin, px[i + 3]); }
      out.push({ msSlope: +(ms / (N * N)).toExponential(2), jmin: +jmin.toFixed(2) });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
  return { update, draw, stats, PRESETS, get amp() { return amp; }, set amp(v) { amp = v; inited = false; lastT = -1; }, get enabled() { return !!P; }, get mirror() { return !!(P && P.mirror); },
    get preset() { return P; }, set preset(p) { P = p in PRESETS ? PRESETS[p] : PRESETS.high; } };
})();
