'use strict';
// ───────────────────────── Volumetric clouds: weather map from the game's cloud puffs, raymarched at reduced resolution ─────────────────────────
// The world defines clouds as clusters of puffs (centre, radius, cloud base). Each frame those puffs are splatted into a
// 2D weather map around the camera: coverage, the cloud's upper surface (the union of the puff hemispheres — a
// cauliflower top) and its flat base. The raymarcher reads that map, carves it with tileable 3D Perlin–Worley noise and
// lights it with the sun (dual-lobe phase, multiple-scattering octaves, powder) and the sky. Clouds therefore sit exactly
// where gameplay puts them — thermal caps stay over their thermals — and the same map casts their shadows on the land.
const CLOUDS = (() => {
  const { gl, env, program } = GLX;
  const MAP = 512, MAPW = 14000;           // weather map texels, metres covered (≈27 m texels)
  const LAYER = [300, 4200];               // altitude slab the marcher searches (m)
  const UNIT_MAP = 12;
  const FS_VS = `out vec2 vUV; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const vao = gl.createVertexArray();

  // ── tileable 3D noise, generated once on the GPU ──
  const NOISE_GLSL = `
uniform float uSlice, uRes;
vec3 h33(vec3 p){ p = fract(p*vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx)*p.zyx); }
float worley(vec3 p, float per){
  vec3 id = floor(p), f = fract(p); float d = 1e9;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++){
    vec3 o = vec3(x, y, z), r = o + h33(mod(id + o, per)) - f; d = min(d, dot(r, r));
  }
  return 1.0 - sqrt(d);
}
float grad(vec3 id, vec3 f, float per){ vec3 g = h33(mod(id, per))*2.0 - 1.0; return dot(normalize(g + 1e-4), f); }
float perlin(vec3 p, float per){
  vec3 i = floor(p), f = fract(p), u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  return mix(mix(mix(grad(i, f, per), grad(i + vec3(1,0,0), f - vec3(1,0,0), per), u.x),
                 mix(grad(i + vec3(0,1,0), f - vec3(0,1,0), per), grad(i + vec3(1,1,0), f - vec3(1,1,0), per), u.x), u.y),
             mix(mix(grad(i + vec3(0,0,1), f - vec3(0,0,1), per), grad(i + vec3(1,0,1), f - vec3(1,0,1), per), u.x),
                 mix(grad(i + vec3(0,1,1), f - vec3(0,1,1), per), grad(i + vec3(1,1,1), f - vec3(1,1,1), per), u.x), u.y), u.z)*0.5 + 0.5;
}
float wfbm(vec3 p, float f){ return worley(p*f, f)*0.625 + worley(p*f*2.0, f*2.0)*0.25 + worley(p*f*4.0, f*4.0)*0.125; }
float remap(float v, float a, float b, float c, float d){ return c + (v - a)/(b - a)*(d - c); }
`;
  const SHAPE = program(FS_VS, NOISE_GLSL + `in vec2 vUV; out vec4 o;
void main(){
  vec3 p = vec3(gl_FragCoord.xy, uSlice + 0.5)/uRes;
  float pf = perlin(p*4.0, 4.0)*0.5 + perlin(p*8.0, 8.0)*0.3 + perlin(p*16.0, 16.0)*0.2;
  float w = wfbm(p, 4.0);
  float pw = clamp(remap(pf, w - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0); // Perlin–Worley: billowy Perlin, carved into cells
  o = vec4(pw, wfbm(p, 8.0), wfbm(p, 16.0), wfbm(p, 32.0));
}`);
  const DETAIL = program(FS_VS, NOISE_GLSL + `in vec2 vUV; out vec4 o;
void main(){
  vec3 p = vec3(gl_FragCoord.xy, uSlice + 0.5)/uRes;
  o = vec4(wfbm(p, 4.0), wfbm(p, 8.0), wfbm(p, 16.0), 1.0);
}`);
  function tex3D(size, render) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, size, size, size);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT], [gl.TEXTURE_WRAP_R, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.viewport(0, 0, size, size);
    gl.useProgram(render.p); gl.bindVertexArray(vao);
    gl.uniform1f(render.u.uRes, size);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    for (let s = 0; s < size; s++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, s);
      gl.uniform1f(render.u.uSlice, s);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f);
    gl.enable(gl.DEPTH_TEST);
    return t;
  }
  let shapeTex = null, detailTex = null;
  function ensureNoise() { if (!shapeTex) { shapeTex = tex3D(64, SHAPE); detailTex = tex3D(32, DETAIL); } }

  // ── weather map: one quad per puff, MAX-blended: r coverage, g top altitude/8000, b 1 − base/8000 (the lowest base),
  // a the highest base/8000 of the clouds touching the texel (see cloudField) ──
  const mapTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, mapTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, MAP, MAP);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const mapFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const PMAX = 2600, pData = new Float32Array(PMAX * 6);
  const puffVao = gl.createVertexArray();
  gl.bindVertexArray(puffVao);
  GLX.attribs(GLX.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  const puffBuf = GLX.buffer(pData, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  GLX.attribs(puffBuf, [[1, 4, 6, 0, 1], [2, 2, 6, 4, 1]]);
  gl.bindVertexArray(null);
  const SPLAT = program(`layout(location=0) in vec2 aC; layout(location=1) in vec4 aP; layout(location=2) in vec2 aB;
uniform vec3 uMapP; out vec2 vL; out vec4 vP; out float vBase;
void main(){
  float R = aP.w*1.25;
  vec2 w = aP.xz + aC*R;
  vL = aC*R; vP = aP; vBase = aB.x;
  gl_Position = vec4((w - uMapP.xy)*uMapP.z*2.0 - 1.0, 0.0, 1.0);
}`, `in vec2 vL; in vec4 vP; in float vBase; out vec4 o;
void main(){
  float r = vP.w, rho = length(vL);
  float cov = smoothstep(r*1.25, r*0.55, rho);
  if (cov < 0.02) discard; // a puff's faint fringe mustn't lend its top or base to a neighbouring cloud (pillars)
  float top = vP.y + sqrt(max(r*r - rho*rho, 0.0))*0.95;           // the puff's upper hemisphere
  float base = vBase; // one flat base per cloud: a small low puff mustn't make a stem under a big high one
  o = vec4(cov, top/8000.0, 1.0 - base/8000.0, base/8000.0);
}`);
  const mapP = new Float32Array(4); // origin x, z, 1/size, enabled
  let mapReady = false;
  function buildMap(cam, puffs, n) {
    const texel = MAPW / MAP;
    mapP[0] = Math.floor((cam.pos[0] - MAPW / 2) / texel) * texel;
    mapP[1] = Math.floor((cam.pos[2] - MAPW / 2) / texel) * texel;
    mapP[2] = 1 / MAPW; mapP[3] = 1;
    n = Math.min(n, PMAX);
    for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) pData[i * 6 + k] = puffs[i * 7 + k];
    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
    gl.viewport(0, 0, MAP, MAP);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearColor(0, 0, 0, 1);
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, puffBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pData, 0, n * 6);
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(SPLAT.p); gl.uniform3f(SPLAT.u.uMapP, mapP[0], mapP[1], mapP[2]);
      gl.bindVertexArray(puffVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0 + UNIT_MAP); gl.bindTexture(gl.TEXTURE_2D, mapTex); gl.activeTexture(gl.TEXTURE0);
    mapReady = true;
  }

  // ── density + lighting (shared by the marcher) ──
  const CLOUD_GLSL = `
uniform mediump sampler3D uShape, uDetail; // (uCloudMap, uMapP come from GLSL_COMMON)
uniform vec4 uWindOff;   // noise offset (m) xyz
uniform vec4 uCloudK;    // density scale, detail erosion, march steps, max distance
float remap(float v, float a, float b, float c, float d){ return c + (v - a)/(b - a)*(d - c); }
// density: weather-map shape whose surfaces are displaced by Perlin–Worley billows (and, for detail, by a finer Worley
// layer); without detail it is a conservative superset, used for empty-space skipping and the light march
float cloudField(vec3 p, bool detail, out float hf){
  hf = 0.0;
  vec2 uv = (p.xz - uMapP.xy)*uMapP.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  vec4 m = textureLod(uCloudMap, uv, 0.0);
  if (m.r < 0.02) return 0.0;
  float top = m.g*8000.0, base = (1.0 - m.b)*8000.0;
  // where clouds at different heights overlap, the map only knows the lowest base and the highest top: that column would
  // stand the high cloud on a pillar. (The world gives neighbouring clouds a common base; this catches what's left.)
  // Start the column at the high cloud's base; the low cloud is cut back where it passes under the high one
  base = mix(base, m.a*8000.0, smoothstep(120.0, 300.0, m.a*8000.0 - base));
  if (p.y < base - 10.0 || p.y > top + 10.0) return 0.0;
  hf = clamp((p.y - base)/max(top - base, 1.0), 0.0, 1.0);
  vec4 n = textureLod(uShape, (p + uWindOff.xyz)*(1.0/950.0), 0.0);
  float fb = n.g*0.625 + n.b*0.25 + n.a*0.125;
  float billow = 1.0 - clamp(remap(n.r, fb - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  // the noise displaces the surfaces: the top sinks between billows (cauliflower towers), sides pull in, the base stays flat
  float db = 0.0;
  if (detail) {
    vec3 dn = textureLod(uDetail, (p + uWindOff.xyz*1.3)*(1.0/170.0) + vec3(0.0, uWindOff.w*0.006, 0.0), 0.0).rgb;
    db = 1.0 - (dn.r*0.625 + dn.g*0.25 + dn.b*0.125);
  }
  float topE = top - billow*min(150.0, (top - base)*0.55) - db*uCloudK.y*90.0;
  float baseE = base + billow*10.0 + db*6.0;
  // taper the coverage toward the top into domes (no vertical walls); bases stay flat and wide, as cumulus bases are
  float taper = smoothstep(0.35, 1.0, hf)*0.45;
  float covE = m.r - billow*0.6 - db*uCloudK.y*0.3 - taper;
  return smoothstep(0.0, 22.0, topE - p.y)*smoothstep(0.0, 14.0, p.y - baseE)*smoothstep(0.0, 0.2, covE);
}
float cloudShape(vec3 p, out float hf){ return cloudField(p, false, hf); }
float cloudDensity(vec3 p, bool detail, out float hf){ return cloudField(p, detail, hf); }
`;
  const MARCH = program(FS_VS, GLSL_COMMON + CLOUD_GLSL + `
uniform sampler2D uDepth; uniform mat4 uInvVP; uniform vec2 uLayer; uniform vec2 uDepthScale; uniform float uFrame, uNoDepth, uHazeK;
in vec2 vUV; layout(location=0) out vec4 o; layout(location=1) out vec4 oD; // oD.r: distance to the cloud (km), 0 = none
float hg(float c, float g){ float g2 = g*g; return (1.0 - g2)/(12.566371*pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5)); }
void main(){
  // view ray (camera-relative) and the distance to whatever opaque surface is behind this pixel
  vec2 ndc = vUV*2.0 - 1.0;
  vec4 w = uInvVP*vec4(ndc, 1.0, 1.0); vec3 rd = normalize(w.xyz/w.w);
  float z = uNoDepth > 0.5 ? 1.0 : texelFetch(uDepth, ivec2(gl_FragCoord.xy*uDepthScale), 0).r;
  float sceneD = 1e9;
  if (z < 1.0) { vec4 q = uInvVP*vec4(ndc, z*2.0 - 1.0, 1.0); sceneD = length(q.xyz/q.w); }
  // clip to the cloud slab
  float t0 = 0.0, t1 = uCloudK.w;
  if (abs(rd.y) > 1e-4) {
    float a = (uLayer.x - uCam.y)/rd.y, b = (uLayer.y - uCam.y)/rd.y;
    t0 = max(min(a, b), 0.0); t1 = min(max(a, b), t1);
  } else if (uCam.y < uLayer.x || uCam.y > uLayer.y) { o = vec4(0.0, 0.0, 0.0, 1.0); oD = vec4(0.0); return; }
  t1 = min(t1, sceneD);
  if (t0 >= t1) { o = vec4(0.0, 0.0, 0.0, 1.0); oD = vec4(0.0); return; }
  // lighting constants
  float mu = dot(rd, uSun);
  float ph = mix(hg(mu, 0.75), hg(mu, -0.25), 0.3);           // forward silver lining + some back scatter
  vec3 sunE = uSunCol*3.14159265;                            // sun irradiance
  vec3 ambTop = uAmb*1.1 + uZen*0.3, ambBot = uHor*0.2 + (uSunCol*max(uSun.y, 0.0) + uAmb)*0.14; // sky above, lit land below
  // interleaved gradient noise, rotated by the golden ratio each frame so the temporal filter integrates it away
  float jitter = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame*0.618034);
  float T = 1.0, firstHit = -1.0;
  float t = t0 + (90.0 + t0*0.02)*jitter; // interleaved-gradient jitter hides the step banding
  vec3 L = vec3(0.0);
  int empty = 0; bool fine = false;
  int steps = int(uCloudK.z);
  for (int i = 0; i < 256; i++){
    if (i >= steps || t > t1 || T < 0.015) break;
    float ds = fine ? (6.0 + t*0.006) : (80.0 + t*0.02);
    float ts = t;
    vec3 p = uCam + rd*ts;
    float hf;
    if (!fine) {
      if (cloudShape(p, hf) > 0.0) { fine = true; empty = 0; t = max(t0, t - ds*0.5); continue; }
      t += ds; continue;
    }
    float d = cloudDensity(p, true, hf);
    if (d > 0.0) {
      empty = 0;
      if (firstHit < 0.0) firstHit = ts;
      float sigma = d*uCloudK.x;
      // light march toward the sun through the coarse density
      float tau = 0.0, lt = 0.0, h2;
      for (int k = 0; k < 6; k++){ float sl = 12.0*pow(1.8, float(k)); lt += sl; tau += cloudShape(p + uSun*(lt - sl*0.5), h2)*sl; }
      tau *= uCloudK.x;
      // multiple-scattering octaves (Wrenninge): each octave scatters less, is absorbed less and is less forward
      vec3 sun = vec3(0.0); float a = 1.0, b = 1.0, c = 1.0;
      for (int k = 0; k < 3; k++){ sun += sunE*a*mix(hg(mu, 0.75*c), hg(mu, -0.25*c), 0.3)*exp(-tau*b); a *= 0.5; b *= 0.45; c *= 0.5; }
      sun *= 3.5; // the octaves only reach a few scattering orders; a cloud's albedo is ~1, so boost toward that
      float powder = 1.0 - exp(-sigma*120.0);                  // dark edges facing the sun, bright creases
      sun *= mix(1.0, powder*2.0, 0.5*(1.0 - max(mu, 0.0)));
      vec3 amb = mix(ambBot, ambTop, smoothstep(0.0, 1.0, hf))*mix(0.35, 1.0, hf);
      vec3 S = (sun + amb)*sigma;
      float tr = exp(-sigma*ds);
      L += T*(S - S*tr)/max(sigma, 1e-6);
      T *= tr;
    } else if (++empty > 8) fine = false;
    t += ds;
  }
  // air between the camera and the cloud: aerial perspective at the first hit
  if (firstHit > 0.0) {
    if (uNoDepth > 0.5) { // mirrored view (no froxels for it): haze the cloud toward the sky behind it by distance
      float ta = exp(-firstHit*(1.0/26000.0)*uHazeK);
      L = L*ta + skyCol(rd)*(1.0 - T)*(1.0 - ta);
    } else {
      vec4 a = aerial(firstHit);
      L = L*a.a + a.rgb*(1.0 - T);
    }
  }
  o = vec4(L, T);
  oD = vec4(firstHit > 0.0 ? firstHit*0.001 : 0.0);
}`);
  // temporal accumulation: reproject last frame's result through the cloud's distance, clamp it to this frame's
  // neighbourhood (so disocclusions and fast changes don't ghost) and blend
  const TEMPORAL = program(FS_VS, `uniform sampler2D uCur, uDist, uHist; uniform mat4 uInvVP, uPrevVP; uniform vec3 uCamDelta; uniform float uReset;
in vec2 vUV; out vec4 o;
// Catmull–Rom history fetch (9 bilinear taps): bilinear alone softens the history a little every frame
vec4 histCR(vec2 uv){
  vec2 ts = vec2(textureSize(uHist, 0)), p = uv*ts - 0.5, f = fract(p), c = floor(p) + 0.5;
  vec2 w0 = f*(-0.5 + f*(1.0 - 0.5*f)), w1 = 1.0 + f*f*(-2.5 + 1.5*f), w2 = f*(0.5 + f*(2.0 - 1.5*f)), w3 = f*f*(-0.5 + 0.5*f);
  vec2 w12 = w1 + w2, o12 = w2/w12;
  vec2 t0 = (c - 1.0)/ts, t3 = (c + 2.0)/ts, t12 = (c + o12)/ts;
  vec4 r = texture(uHist, vec2(t12.x, t0.y))*w12.x*w0.y
    + texture(uHist, vec2(t0.x, t12.y))*w0.x*w12.y + texture(uHist, t12)*w12.x*w12.y + texture(uHist, vec2(t3.x, t12.y))*w3.x*w12.y
    + texture(uHist, vec2(t12.x, t3.y))*w12.x*w3.y;
  return r/(w12.x*w0.y + w0.x*w12.y + w12.x*w12.y + w3.x*w12.y + w12.x*w3.y);
}
void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy), sz = textureSize(uCur, 0) - 1;
  vec4 c = texelFetch(uCur, ip, 0), mn = c, mx = c;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texelFetch(uCur, clamp(ip + ivec2(x, y), ivec2(0), sz), 0); mn = min(mn, s); mx = max(mx, s);
  }
  if (uReset > 0.5) { o = c; return; }
  float d = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) d = max(d, texelFetch(uDist, clamp(ip + ivec2(x, y), ivec2(0), sz), 0).r);
  d = d > 0.0 ? d*1000.0 : 6000.0;
  vec4 w = uInvVP*vec4(vUV*2.0 - 1.0, 1.0, 1.0);
  vec3 rel = normalize(w.xyz/w.w)*d;
  vec4 pc = uPrevVP*vec4(rel + uCamDelta, 1.0);
  vec2 puv = pc.xy/pc.w*0.5 + 0.5;
  if (pc.w <= 0.0 || puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0) { o = c; return; }
  vec4 h = clamp(histCR(puv), mn, mx);
  o = mix(c, h, 0.88);
}`);
  // upsample with a small tent filter: hides the jittered-march dither at soft edges
  const COMP = program(FS_VS, `uniform sampler2D uCl; uniform vec2 uTx; in vec2 vUV; out vec4 o;
void main(){
  o = texture(uCl, vUV)*0.4 + (texture(uCl, vUV + vec2(uTx.x, 0.0)) + texture(uCl, vUV - vec2(uTx.x, 0.0))
    + texture(uCl, vUV + vec2(0.0, uTx.y)) + texture(uCl, vUV - vec2(0.0, uTx.y)))*0.15;
}`);

  // reduced-resolution targets: this frame's march (colour + distance) and two ping-pong history buffers
  let rt = null, hist = [], rw = 0, rh = 0, hi = 0, reset = true;
  function tex2D(w, h, fmt) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  function fboOf(...texs) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((t, i) => gl.COLOR_ATTACHMENT0 + i));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }
  function target(w, h) {
    if (rt && w === rw && h === rh) return;
    if (rt) { for (const t of [rt.t, rt.d, hist[0].t, hist[1].t]) gl.deleteTexture(t); for (const f of [rt.f, hist[0].f, hist[1].f]) gl.deleteFramebuffer(f); }
    rw = w; rh = h;
    const t = tex2D(w, h, gl.RGBA16F), d = tex2D(w, h, gl.R16F);
    rt = { t, d, f: fboOf(t, d) };
    hist = [0, 1].map(() => { const ht = tex2D(w, h, gl.RGBA16F); return { t: ht, f: fboOf(ht) }; });
    reset = true;
  }

  // presets: resolution divisor, fine steps, density, detail erosion, max distance
  const PRESETS = { high: { div: 2, steps: 200, maxD: 26000 }, medium: { div: 4, steps: 96, maxD: 18000 }, low: null };
  let P = PRESETS.high;
  const invVP = new Float32Array(16), prevVP = new Float32Array(16), prevCam = [0, 0, 0];
  let frame = 0;
  // march into the reduced target (needs the resolved scene depth), then blend over the bound scene target
  function render(cam, depthTex, sceneW, sceneH, drift) {
    if (!P || !mapReady) return false;
    ensureNoise();
    const w = Math.max(1, Math.round(sceneW / P.div)), h = Math.max(1, Math.round(sceneH / P.div));
    target(w, h);
    M4.inv(invVP, env.vp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.f);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    gl.useProgram(MARCH.p); GLX.setEnv(MARCH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.uniform1i(MARCH.u.uDepth, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, shapeTex); gl.uniform1i(MARCH.u.uShape, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, detailTex); gl.uniform1i(MARCH.u.uDetail, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix4fv(MARCH.u.uInvVP, false, invVP);
    gl.uniform2f(MARCH.u.uLayer, LAYER[0], LAYER[1]);
    gl.uniform2f(MARCH.u.uDepthScale, sceneW / w, sceneH / h);
    gl.uniform4f(MARCH.u.uWindOff, -drift[0], 0, -drift[2], env.time);
    gl.uniform4f(MARCH.u.uCloudK, 0.05, 0.42, P.steps, P.maxD);
    gl.uniform1f(MARCH.u.uFrame, frame++ % 64);
    gl.uniform1f(MARCH.u.uNoDepth, 0);
    // aerial() reads gl_FragCoord against the scene resolution: scale it to this target for the pass
    const ax = env.atm[0], ay = env.atm[1];
    env.atm[0] = 1 / w; env.atm[1] = 1 / h; gl.uniform4fv(MARCH.u.uAtm, env.atm); env.atm[0] = ax; env.atm[1] = ay;
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // temporal accumulation into the next history buffer
    const dx = cam.pos[0] - prevCam[0], dy = cam.pos[1] - prevCam[1], dz = cam.pos[2] - prevCam[2];
    if (dx * dx + dy * dy + dz * dz > 250 * 250) reset = true; // teleport / respawn
    const src = hist[hi], dst = hist[1 - hi];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
    gl.useProgram(TEMPORAL.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.t); gl.uniform1i(TEMPORAL.u.uCur, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rt.d); gl.uniform1i(TEMPORAL.u.uDist, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, src.t); gl.uniform1i(TEMPORAL.u.uHist, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix4fv(TEMPORAL.u.uInvVP, false, invVP);
    gl.uniformMatrix4fv(TEMPORAL.u.uPrevVP, false, prevVP);
    gl.uniform3f(TEMPORAL.u.uCamDelta, dx, dy, dz);
    gl.uniform1f(TEMPORAL.u.uReset, reset ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    hi = 1 - hi; reset = false;
    prevVP.set(env.vp); prevCam[0] = cam.pos[0]; prevCam[1] = cam.pos[1]; prevCam[2] = cam.pos[2];
    return true;
  }
  // the clouds as the water mirrors them: the same march from the camera mirrored below the water plane (y → −y);
  // no scene depth (the water's screen-space reflection covers the land) and no haze (the water adds its own)
  let mt = null, mw = 0, mh = 0;
  const invM = new Float32Array(16);
  function renderMirror(cam, sceneW, sceneH, drift) {
    if (!P || !mapReady) return null;
    ensureNoise();
    const w = Math.max(1, Math.round(sceneW / (P.div + 2))), h = Math.max(1, Math.round(sceneH / (P.div + 2)));
    if (!mt || w !== mw || h !== mh) {
      if (mt) { gl.deleteTexture(mt.t); gl.deleteFramebuffer(mt.f); }
      mw = w; mh = h;
      const t = tex2D(w, h, gl.RGBA16F); mt = { t, f: fboOf(t) };
    }
    M4.inv(invM, env.vp);
    invM[1] = -invM[1]; invM[5] = -invM[5]; invM[9] = -invM[9]; invM[13] = -invM[13]; // mirror the rays in y
    gl.bindFramebuffer(gl.FRAMEBUFFER, mt.f);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    gl.useProgram(MARCH.p); GLX.setEnv(MARCH);
    gl.uniform3f(MARCH.u.uCam, env.cam[0], -env.cam[1], env.cam[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null); gl.uniform1i(MARCH.u.uDepth, 0); // unused here (and never the target)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, shapeTex); gl.uniform1i(MARCH.u.uShape, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, detailTex); gl.uniform1i(MARCH.u.uDetail, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix4fv(MARCH.u.uInvVP, false, invM);
    gl.uniform2f(MARCH.u.uLayer, LAYER[0], LAYER[1]);
    gl.uniform2f(MARCH.u.uDepthScale, 1, 1);
    gl.uniform4f(MARCH.u.uWindOff, -drift[0], 0, -drift[2], env.time);
    gl.uniform4f(MARCH.u.uCloudK, 0.05, 0.42, Math.round(P.steps * 0.55), P.maxD);
    gl.uniform1f(MARCH.u.uFrame, 0);
    gl.uniform1f(MARCH.u.uNoDepth, 1);
    gl.uniform1f(MARCH.u.uHazeK, ATMOS.state.haze * env.atm[2]);
    gl.uniform4f(MARCH.u.uAtm, 1 / w, 1 / h, 0, env.atm[3]); // distance scale 0: no aerial perspective here
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    return mt.t;
  }
  function composite() {
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA); // scene·T + in-scattered light
    gl.useProgram(COMP.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hist[hi].t); gl.uniform1i(COMP.u.uCl, 0);
    const b = P && P.div > 2 ? 0.6 : 0.0; // soften quarter-res upsampling only
    gl.uniform2f(COMP.u.uTx, b / rw, b / rh);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  function setEnvClouds(u) {
    if (!u.uCloudMap) return;
    gl.uniform1i(u.uCloudMap, UNIT_MAP);
    gl.uniform4fv(u.uMapP, mapP);
  }
  return { buildMap, render, renderMirror, composite, setEnvClouds, PRESETS, get volumetric() { return !!P; },
    get texture() { return rt ? hist[hi].t : null; }, // accumulated clouds (rgb in-scatter, a transmittance)
    get preset() { return P; }, set preset(p) { P = p in PRESETS ? PRESETS[p] : PRESETS.high; reset = true; } };
})();
