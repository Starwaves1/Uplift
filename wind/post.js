'use strict';
// ───────────────────────── Post: HDR targets, MSAA resolve, bloom, AgX tonemap + grade, sharpened upscale ─────────────────────────
// Frame flow:  POST.begin(w, h) → draw the scene (linear HDR) → POST.end(opts) → canvas
//   scene is rendered at internal resolution (w, h) into an MSAA RGBA16F target, resolved to textures
//   (colour + depth, the depth stays sampleable for later passes), bloomed, tonemapped and upscaled to the canvas.
const POST = (() => {
  const { gl, canvas, program } = GLX;
  const cbf = gl.getExtension('EXT_color_buffer_float');
  const HDR = !!cbf;
  const maxSamples = HDR ? gl.getParameter(gl.MAX_SAMPLES) : 0;
  const CF = HDR ? gl.RGBA16F : gl.RGBA8;

  const FS_VS = `out vec2 vUV; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
  const vao = gl.createVertexArray();

  // bloom: dual-filter down/up chain (Kawase-style), energy conserving
  // HDR input is sanitised before anything spreads it: a single NaN, infinite or negative pixel would otherwise bloom
  // into a large black shape (the Karis weight divides by 1 + brightness)
  const SAFE = `vec3 safe(vec3 c){ return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : clamp(c, vec3(0.0), vec3(4096.0)); }`;
  const DOWN = program(FS_VS, `in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uFirst; out vec4 o;
${SAFE}
vec3 karis(vec3 c){ return c/(1.0 + max(c.r, max(c.g, c.b))); }
vec3 tap(vec2 uv){ vec3 c = texture(uSrc, uv).rgb; return uFirst > 0.5 ? safe(c) : c; }
void main(){
  vec2 t = uTexel;
  vec3 a = tap(vUV)*4.0;
  vec3 b = tap(vUV + vec2(-t.x, -t.y)), c = tap(vUV + vec2(t.x, -t.y));
  vec3 d = tap(vUV + vec2(-t.x, t.y)), e = tap(vUV + vec2(t.x, t.y));
  vec3 s = uFirst > 0.5 ? (karis(a*0.25)*4.0 + karis(b) + karis(c) + karis(d) + karis(e)) : (a + b + c + d + e);
  o = vec4(s/8.0, 1.0);
}`);
  const UP = program(FS_VS, `in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uTexel; out vec4 o;
void main(){
  vec2 t = uTexel;
  vec3 s = texture(uSrc, vUV + vec2(-t.x*2.0, 0.0)).rgb + texture(uSrc, vUV + vec2(t.x*2.0, 0.0)).rgb
         + texture(uSrc, vUV + vec2(0.0, -t.y*2.0)).rgb + texture(uSrc, vUV + vec2(0.0, t.y*2.0)).rgb
         + (texture(uSrc, vUV + vec2(-t.x, t.y)).rgb + texture(uSrc, vUV + vec2(t.x, t.y)).rgb
          + texture(uSrc, vUV + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUV + vec2(t.x, -t.y)).rgb)*2.0;
  o = vec4(s/12.0, 1.0);
}`);
  // composite: exposure → bloom → AgX → look → grade → vignette → grain, with contrast-adaptive sharpening on upscale
  const COMP = program(FS_VS, `in vec2 vUV; uniform sampler2D uScene, uBloom; uniform vec2 uTexel;
uniform float uExposure, uBloomAmt, uSharp, uVignette, uGrain, uTime, uSat, uWarm, uFxaa;
uniform vec3 uLift, uGain;
out vec4 o;
vec3 agxContrast(vec3 x){ vec3 x2 = x*x, x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
vec3 agx(vec3 v){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  v = m*v;
  v = clamp(log2(max(v, vec3(1e-10))), -12.47393, 4.026069);
  v = (v + 12.47393)/16.500999;
  return agxContrast(v);
}
vec3 agxOut(vec3 v){
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return mi*v;
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)))*43758.5453); }
${SAFE}
vec3 fetch(vec2 uv){ return safe(texture(uScene, uv).rgb); }
// FXAA (console variant) for the preset without MSAA: luma from exposed HDR, compressed to 0..1
float lumaOf(vec3 c){ float l = dot(c*uExposure, vec3(0.299, 0.587, 0.114)); return l/(1.0 + l); }
vec3 fxaa(vec2 uv){
  vec2 t = uTexel;
  vec3 nw = fetch(uv - t), ne = fetch(uv + vec2(t.x, -t.y)), sw = fetch(uv + vec2(-t.x, t.y)), se = fetch(uv + t), m = fetch(uv);
  float lNW = lumaOf(nw), lNE = lumaOf(ne), lSW = lumaOf(sw), lSE = lumaOf(se), lM = lumaOf(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE)*0.03125, 1.0/128.0);
  dir = clamp(dir/(min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0)*t;
  vec3 a = 0.5*(fetch(uv + dir*(1.0/3.0 - 0.5)) + fetch(uv + dir*(2.0/3.0 - 0.5)));
  vec3 b = a*0.5 + 0.25*(fetch(uv - dir*0.5) + fetch(uv + dir*0.5));
  float lb = lumaOf(b);
  return (lb < lMin || lb > lMax) ? a : b;
}
void main(){
  // contrast-adaptive sharpening (restores detail lost to bilinear upscale / MSAA resolve)
  vec3 c = uFxaa > 0.5 ? fxaa(vUV) : fetch(vUV);
  if (uSharp > 0.0 && uFxaa < 0.5) {
    vec3 n = fetch(vUV + vec2(0.0, uTexel.y)), s = fetch(vUV - vec2(0.0, uTexel.y));
    vec3 e = fetch(vUV + vec2(uTexel.x, 0.0)), w = fetch(vUV - vec2(uTexel.x, 0.0));
    vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 2.0 - mx)/max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 wgt = -amp*uSharp*0.2;
    c = max((c + (n + s + e + w)*wgt)/(1.0 + 4.0*wgt), vec3(0.0));
  }
  vec3 col = c*uExposure;
  col = mix(col, texture(uBloom, vUV).rgb*uExposure, uBloomAmt);
  // grade in scene-linear: warm/cool balance and lift/gain
  col *= mix(vec3(1.0), vec3(1.04, 1.0, 0.95), uWarm);
  col = col*uGain + uLift*(1.0 - clamp(col, 0.0, 1.0));
  vec3 t = agx(col);
  // look: gentle punch and saturation
  float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
  t = pow(max(t, vec3(0.0)), vec3(1.08));
  t = l + uSat*(t - l);
  t = agxOut(t);
  vec2 q = vUV - 0.5;
  t *= 1.0 - uVignette*dot(q, q)*1.4;
  t += (hash(gl_FragCoord.xy + fract(uTime)*97.0) - 0.5)*uGrain;
  o = vec4(clamp(t, 0.0, 1.0), 1.0);
}`);

  // ── render targets ──
  function texture2D(w, h, internal, fmt, type, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fbo(color, depth) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    if (color) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    return f;
  }
  const T = { w: 0, h: 0, samples: 0, msFbo: null, msColor: null, msDepth: null, color: null, depth: null, resolveFbo: null, mips: [] };
  function destroy() {
    for (const k of ['msColor', 'msDepth']) if (T[k]) gl.deleteRenderbuffer(T[k]);
    for (const k of ['color', 'depth']) if (T[k]) gl.deleteTexture(T[k]);
    for (const k of ['msFbo', 'resolveFbo']) if (T[k]) gl.deleteFramebuffer(T[k]);
    for (const m of T.mips) { gl.deleteTexture(m.tex); gl.deleteFramebuffer(m.fbo); }
    T.mips = []; T.msFbo = T.msColor = T.msDepth = null;
  }
  function allocate(w, h, samples) {
    destroy();
    T.w = w; T.h = h; T.samples = samples;
    T.color = texture2D(w, h, CF, gl.RGBA, HDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, gl.LINEAR);
    // depth only, no stencil: ANGLE's D3D11 backend resolves multisampled depth-stencil through a CPU copy (~8 ms at 1080p)
    T.depth = texture2D(w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    T.resolveFbo = fbo(T.color, T.depth);
    if (samples > 1) {
      T.msFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.msFbo);
      T.msColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, T.msColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, CF, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, T.msColor);
      T.msDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, T.msDepth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.msDepth);
    }
    let mw = w, mh = h;
    for (let i = 0; i < 6; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      const tex = texture2D(mw, mh, HDR ? gl.R11F_G11F_B10F : gl.RGBA8, gl.RGB, gl.FLOAT, gl.LINEAR);
      T.mips.push({ tex, fbo: fbo(tex, null), w: mw, h: mh });
      if (mw < 8 || mh < 8) break;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // settings per frame
  const opts = { fxaa: false, exposure: 1.0, bloom: 0.045, sharp: 0.5, vignette: 0.22, grain: 0.012, sat: 1.12, warm: 0.3, lift: [0.004, 0.006, 0.012], gain: [1, 1, 1] };
  let enabled = true;

  // bind the scene target for rendering at internal size (w, h); samples = MSAA count (1 = off)
  function begin(w, h, samples) {
    samples = Math.min(samples || 1, maxSamples || 1);
    if (w !== T.w || h !== T.h || samples !== T.samples) allocate(w, h, samples);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.samples > 1 ? T.msFbo : T.resolveFbo);
    gl.viewport(0, 0, w, h);
  }
  // resolve MSAA → textures so later passes can sample them; depth only when a pass asked for it (withDepth)
  function resolve(withDepth) {
    if (T.samples > 1) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.resolveFbo);
      gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      if (withDepth) gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
  }
  // depth only (for passes that need scene depth mid-frame, e.g. clouds); without MSAA the texture is the attachment already
  function resolveDepth() {
    if (T.samples > 1) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.resolveFbo);
      gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
  }
  // re-bind the (multisampled) scene target, e.g. to draw overlays after a resolve
  function rebind() { gl.bindFramebuffer(gl.FRAMEBUFFER, T.samples > 1 ? T.msFbo : T.resolveFbo); gl.viewport(0, 0, T.w, T.h); }

  function pass(p, fboOut, w, h) { gl.bindFramebuffer(gl.FRAMEBUFFER, fboOut); gl.viewport(0, 0, w, h); gl.useProgram(p.p); gl.bindVertexArray(vao); }
  function end(time) {
    GLX.prof.mark('resolve');
    resolve(window.WB_DEPTHTEST);
    GLX.prof.mark('bloom');
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    // bloom
    let src = T.color, sw = T.w, sh = T.h;
    const doBloom = opts.bloom > 0 && T.mips.length > 2;
    if (doBloom) {
      for (let i = 0; i < T.mips.length; i++) {
        const m = T.mips[i];
        pass(DOWN, m.fbo, m.w, m.h);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(DOWN.u.uSrc, 0); gl.uniform2f(DOWN.u.uTexel, 0.5 / sw, 0.5 / sh); gl.uniform1f(DOWN.u.uFirst, i === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = m.tex; sw = m.w; sh = m.h;
      }
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = T.mips.length - 1; i > 0; i--) {
        const s = T.mips[i], d = T.mips[i - 1];
        pass(UP, d.fbo, d.w, d.h);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform1i(UP.u.uSrc, 0); gl.uniform2f(UP.u.uTexel, 0.5 / s.w, 0.5 / s.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }
    // composite to the canvas
    GLX.prof.mark('composite');
    pass(COMP, null, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.color); gl.uniform1i(COMP.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, doBloom ? T.mips[0].tex : T.color); gl.uniform1i(COMP.u.uBloom, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(COMP.u.uTexel, 1 / T.w, 1 / T.h);
    gl.uniform1f(COMP.u.uExposure, opts.exposure);
    gl.uniform1f(COMP.u.uBloomAmt, doBloom ? opts.bloom : 0);
    gl.uniform1f(COMP.u.uSharp, opts.sharp);
    gl.uniform1f(COMP.u.uFxaa, opts.fxaa ? 1 : 0);
    gl.uniform1f(COMP.u.uVignette, opts.vignette);
    gl.uniform1f(COMP.u.uGrain, opts.grain);
    gl.uniform1f(COMP.u.uTime, time || 0);
    gl.uniform1f(COMP.u.uSat, opts.sat);
    gl.uniform1f(COMP.u.uWarm, opts.warm);
    gl.uniform3fv(COMP.u.uLift, opts.lift);
    gl.uniform3fv(COMP.u.uGain, opts.gain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }

  return { HDR, maxSamples, begin, resolve, resolveDepth, rebind, end, opts, targets: T,
    get enabled() { return enabled; }, set enabled(v) { enabled = !!v; } };
})();
