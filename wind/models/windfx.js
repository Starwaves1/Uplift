'use strict';
// ───────────────────────── Wind FX: drifting seeds, pollen and leaves; flight streaks ─────────────────────────
// Both read the shared gust field (core.js: gustMap/windGustField in GLSL, GUST.field in JS), so they agree with the
// grass sheen and the plants' sway.
//  · Airborne matter: thistle/dandelion down and pollen over the meadows, leaves near woods. Fully GPU-driven: each
//    particle lives a few seconds, is (re)born at a hashed spot in a box that wraps around the camera, drifts downwind,
//    tumbles harder in gusts, hugs the terrain, and fades in and out. Lit with the sun (strong forward scattering, so
//    backlit down glows), shadowed, fogged. Only drawn low over the ground, where you can see something this small.
//  · Flight streaks: a few thin ribbons of moving air, spawned by the CPU where the flow is strong (airspeed, gusts,
//    ridge and thermal air), each with its own length, width, opacity and lifetime. The GPU bends each along the air's
//    path relative to the glider: gusty meanders, parting over and under the wing, downwash behind it and a twist
//    around the wingtip vortices. They draw themselves on, taper and fade along their length, then dissolve.
// Quality: WINDFX.level 0 low / 1 medium / 2 high (null → follows TERRAIN.detail, which applyQuality sets per preset).
const WINDFX = (() => {
  const { gl, program, buffer, env, setEnv } = GLX;
  const TAU = Math.PI * 2;
  const LEVELS = [{ motes: 160, streaks: 24 }, { motes: 380, streaks: 36 }, { motes: 640, streaks: 48 }];
  let level = null;
  const lvl = () => LEVELS[level != null ? level : clamp(TERRAIN.detail | 0, 0, 2)];

  // ───── airborne matter ─────
  const MMAX = LEVELS[2].motes, BOX = 64; // particles, wrap-box width (m)
  const seeds = new Float32Array(MMAX * 4);
  for (let i = 0; i < MMAX * 4; i++) seeds[i] = hash2(i * 7 + 3, 911 + (i >> 2));
  const moteVao = gl.createVertexArray();
  gl.bindVertexArray(moteVao);
  GLX.attribs(buffer(seeds), [[0, 4, 4, 0, 1]]);
  GLX.attribs(buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[1, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);
  const MoteP = program(GLSL_COMMON + `
layout(location=0) in vec4 aS; layout(location=1) in vec2 aC;
uniform mat4 uVP; uniform vec3 uCR, uCU; uniform vec4 uBox; // (box width m, amount, pixel size at 1 m, -)
out vec2 vUV; out vec3 vRel; out vec4 vP; out vec3 vAlb;
void main(){
  float B = uBox.x;
  // each particle lives 7–15 s, then is reborn somewhere else in the (world-anchored, camera-wrapped) box
  float life = mix(7.0, 15.0, aS.x);
  float tt = uTime/life + aS.y*17.0, cyc = floor(tt), age = tt - cyc, T = age*life;
  ivec2 hid = ivec2(gl_InstanceID, int(mod(cyc, 65536.0)));
  vec3 h = vec3(hash2(hid), hash2(hid + ivec2(7919, 31)), hash2(hid + ivec2(104729, 17)));
  vec2 xz0 = h.xy*B, adv = GUST_DIR*GUST_SPEED*0.9*T;           // carried downwind by the mean wind
  vec2 xz = uCam.xz + mod(xz0 + adv - uCam.xz, B) - 0.5*B;
  vec2 src = xz - adv;                                          // where it was born: decides what it is
  vec4 gm = gustMap(xz);
  float gust = gm.y;
  xz += normalize(gm.zw + vec2(1e-5, 0.0))*(gm.x - GUST_MEAN)*1.4; // a passing gust shoves it along
  // what drifts here: leaves near and in woods, down and pollen over open ground (pollen mostly over flower patches)
  float leafP = smoothstep(0.22, 0.6, forestMask(src));
  float kind = aS.w < leafP ? 2.0 : aS.w < leafP + (1.0 - leafP)*0.58 ? 0.0 : 1.0;
  float ground = terrainH(xz, 1.0);
  float wet = 1.0 - smoothstep(0.0, 1.5, ground);
  float hgt, size, a;
  vec3 wob = vec3(sin(T*0.9 + aS.x*40.0), sin(T*1.3 + aS.y*40.0)*0.5, sin(T*0.7 + aS.z*40.0))*(0.2 + 1.1*gust);
  if (kind < 0.5) {        // thistle / dandelion down: lofted slowly, higher in gusts
    hgt = 0.4 + 22.0*h.z*h.z + T*mix(0.04, 0.3, aS.z) + gust*1.6*h.z;
    size = 0.075*(0.7 + 0.6*aS.z); a = 1.0 - 0.6*wet;
  } else if (kind < 1.5) { // pollen motes: low, over the flowers
    hgt = mix(0.3, 6.0, h.z*h.z) + sin(T*0.7 + aS.x*20.0)*0.3;
    size = 0.024*(0.7 + 0.6*aS.z);
    a = (0.25 + 0.75*smoothstep(0.45, 0.78, vn(src*0.045 + vec2(3.3, 7.7))))*(1.0 - wet);
  } else {                 // leaves: shed from the canopy, falling and pendulum-swinging as they go
    hgt = mix(3.0, 15.0, h.z) - T*mix(0.45, 0.85, aS.z);
    wob.xz += vec2(-GUST_DIR.y, GUST_DIR.x)*sin(T*2.3 + aS.x*30.0)*0.45;
    size = 0.08*(0.75 + 0.5*aS.z); a = smoothstep(0.0, 0.4, hgt)*(1.0 - wet);
    hgt = max(hgt, 0.03);
  }
  a *= 1.0 - smoothstep(560.0, 640.0, ground);               // nothing up among the rocks and snow
  vec3 rel = vec3(xz.x, max(ground, 0.0) + hgt, xz.y) + wob - uCam;
  float dist = length(rel);
  float s = max(size, dist*uBox.z*1.6);                       // never thinner than ~1.6 px: fade instead of shimmer
  a *= (size/s)*(size/s);
  a *= smoothstep(0.0, 0.12, age)*(1.0 - smoothstep(0.82, 1.0, age));
  a *= 1.0 - smoothstep(0.36*B, 0.47*B, max(abs(rel.x), abs(rel.z)));
  a *= smoothstep(1.2, 3.5, dist)*uBox.y;
  // screen-aligned quad; leaves spin in the screen plane and flip (narrowing edge-on, showing the paler underside)
  float spin = kind > 1.5 ? T*(1.2 + 2.5*gust)*(aS.z - 0.5)*2.0 + aS.y*TAU_ : aS.y*TAU_;
  float flip = kind > 1.5 ? cos(T*(2.0 + 3.0*gust + aS.x*2.0) + aS.z*9.0) : 1.0;
  vec3 e1 = (uCR*cos(spin) + uCU*sin(spin))*max(abs(flip), 0.18), e2 = -uCR*sin(spin) + uCU*cos(spin);
  vRel = rel + (e1*aC.x + e2*aC.y*(kind > 1.5 ? 0.55 : 1.0))*s;
  vUV = aC; vP = vec4(kind, a, flip, aS.x);
  vec3 lc = mix(vec3(0.34, 0.52, 0.18), vec3(0.78, 0.64, 0.22), step(0.72, aS.z)); // green, some turning gold
  vAlb = kind > 1.5 ? mix(lc, vec3(0.52, 0.36, 0.2), step(0.9, aS.z)) : kind > 0.5 ? vec3(1.0, 0.86, 0.42) : vec3(0.96, 0.95, 0.9);
  gl_Position = a > 0.002 ? uVP*vec4(vRel, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}`.replace(/TAU_/g, '6.2831853'), GLSL_COMMON + `
in vec2 vUV; in vec3 vRel; in vec4 vP; in vec3 vAlb; out vec4 o;
void main(){
  float kind = vP.x, r2 = dot(vUV, vUV), m;
  if (kind > 1.5) { // leaf outline: pointed at both ends
    float w = 1.0 - vUV.x*vUV.x;
    m = smoothstep(0.0, 0.12, w*w*0.9 - vUV.y*vUV.y*0.85);
  } else if (kind > 0.5) m = exp(-r2*5.0)*(1.0 - smoothstep(0.7, 1.0, r2));
  else {            // down: a bright seed with a halo of fine pappus filaments (averages to a soft dot when tiny)
    float fil = pow(abs(cos(atan(vUV.y, vUV.x)*5.0 + vP.w*40.0)), 6.0);
    m = (exp(-r2*14.0) + fil*exp(-r2*2.6)*0.55 + exp(-r2*4.0)*0.2)*(1.0 - smoothstep(0.7, 1.0, r2));
  }
  float a = vP.y*m;
  if (a < 0.003) discard;
  vec3 v = normalize(vRel);
  float mu = dot(v, uSun), g = kind > 1.5 ? 0.45 : 0.62;
  float hg = (1.0 - g*g)/pow(1.0 + g*g - 2.0*g*mu, 1.5)*0.0796; // Henyey–Greenstein, forward scattering
  float sh = sunShadow(vRel, vec3(0.0, 1.0, 0.0));
  vec3 alb = toLin(vAlb);
  vec3 col;
  if (kind > 1.5) {       // leaf: lit face or paler underside, sunlight glowing through it from behind
    alb *= vP.z < 0.0 ? 1.3 : 1.0;
    col = alb*(uSunCol*sh*(0.3 + 0.5*abs(vP.z) + 2.2*hg) + uAmb*0.85);
  } else {                // down and pollen: tiny translucent tufts that light up against the sun
    col = alb*(uSunCol*sh*(0.45 + 5.0*hg) + uAmb*0.9);
  }
  o = vec4(fogIt(col, vRel)*a, a*(kind > 1.5 ? 1.0 : 0.55));
}`);

  // ───── flight streaks ─────
  const SMAX = LEVELS[2].streaks, SEG = 22;
  const sData = new Float32Array(SMAX * 16), sDeath = new Float64Array(SMAX);
  const streakBuf = buffer(sData, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  const streakVao = gl.createVertexArray();
  gl.bindVertexArray(streakVao);
  GLX.attribs(streakBuf, [[0, 4, 16, 0, 1], [1, 4, 16, 4, 1], [2, 4, 16, 8, 1], [3, 4, 16, 12, 1]]);
  gl.bindVertexArray(null);
  const StreakP = program(GLSL_COMMON + `
layout(location=0) in vec4 aH; // head at birth (world), birth time
layout(location=1) in vec4 aL; // life (s), length (m), width (m), opacity
layout(location=2) in vec4 aV; // air velocity there (world m/s), seed
layout(location=3) in vec4 aM; // meander amplitude (m), meander cycles, phase, curvature
uniform mat4 uVP; uniform vec3 uGV, uGp, uGR, uGU, uGF; uniform vec2 uPix; // (pixel size at 1 m, amount)
out float vA; out float vX; out vec3 vRel;
const float SEG = ${SEG}.0;
// the glider parts the air: over and under the wing, downwash behind it, upwash ahead, wingtip vortices trailing
vec3 deflect(vec3 p){
  vec3 q = p - uGp;
  float x = dot(q, uGR), y = dot(q, uGU), z = dot(q, uGF);
  float span = 1.0 - smoothstep(3.3, 4.8, abs(x));
  float over = sign(y + 0.05)*max(1.3 - abs(y), 0.0)*0.55*exp(-z*z*0.35)*span;
  float wash = (-0.065*max(-z, 0.0)*exp(-abs(y)*0.3) + 0.3*exp(-(z - 2.0)*(z - 2.0)*0.2)*exp(-abs(y)*0.5))*span;
  vec3 d = uGU*(over + wash);
  for (int k = 0; k < 2; k++) {
    float sd = k == 0 ? 1.0 : -1.0;
    vec2 c = vec2(x - sd*3.9, y);
    float r = length(c);
    if (z < 0.0 && r < 2.2) {
      float ang = sd*min(-z, 12.0)*0.55/(r + 0.4)*(1.0 - smoothstep(1.0, 2.2, r));
      vec2 cr = vec2(c.x*cos(ang) - c.y*sin(ang), c.x*sin(ang) + c.y*cos(ang)) - c;
      d += uGR*cr.x + uGU*cr.y;
    }
  }
  return p + d;
}
vec3 spine(float s, vec3 head, vec3 dir, vec3 m1, vec3 m2){
  float L = aL.y, w = aM.y*6.2832*s + aM.z;
  vec3 p = head - dir*L*s;
  p += m1*((sin(w) - sin(aM.z))*aM.x + aM.w*s*s*L) + m2*(sin(w*2.3 + 1.3) - sin(aM.z*2.3 + 1.3))*aM.x*0.4;
  return deflect(p);
}
void main(){
  float age = (uTime - aH.w)/aL.x;
  vA = 0.0; vX = 0.0; vRel = vec3(0.0);
  if (age < 0.0 || age > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  int k = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1)*2.0 - 1.0;
  vec3 ur = aV.xyz - uGV;                          // the air's motion relative to the glider
  vec3 dir = ur/max(length(ur), 0.5);
  vec3 head = aH.xyz + aV.xyz*(uTime - aH.w);
  vec3 m1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 m2 = cross(dir, m1);
  float ca = cos(aV.w*6.2832), sa = sin(aV.w*6.2832);
  vec3 n1 = m1*ca + m2*sa, n2 = m2*ca - m1*sa;
  // draw on from the head, dissolve from the head end late in life
  float sv = float(k)/SEG;
  float s = mix(clamp((age - 0.55)/0.45, 0.0, 1.0)*0.85, clamp(age/0.28, 0.02, 1.0), sv);
  vec3 p = spine(s, head, dir, n1, n2), p2 = spine(s + 0.015, head, dir, n1, n2);
  vec3 rel = p - uCam;
  vec3 t = normalize(p2 - p + vec3(1e-6));
  vec3 sdir = normalize(cross(t, rel) + vec3(1e-6));
  float dist = length(rel);
  float w = aL.z*(0.3 + 0.7*sin(3.1416*clamp(0.08 + sv*0.95, 0.0, 1.0)));
  float we = max(w, dist*uPix.x*1.15);
  vA = aL.w*uPix.y*(w/we)*smoothstep(0.0, 0.12, sv)*pow(1.0 - sv, 0.9)*(1.0 - smoothstep(0.7, 1.0, age))
     *smoothstep(1.2, 3.5, dist)*(1.0 - smoothstep(45.0, 70.0, dist));
  vA = min(vA, 0.8);
  vX = side; vRel = rel;
  gl_Position = uVP*vec4(rel + sdir*we*0.5*side, 1.0);
}`, GLSL_COMMON + `
in float vA; in float vX; in vec3 vRel; out vec4 o;
void main(){
  float a = vA*(1.0 - vX*vX);
  if (a < 0.002) discard;
  vec3 c = uSunCol*0.32 + uAmb*1.05;
  o = vec4(fogIt(c, vRel)*a, a*0.25);
}`);

  // ───── per frame ─────
  const gf = [0, 0, 0, 0], gf2 = [0, 0, 0, 0];
  let flow = 0, spawnAcc = 0, camAgl = 0, sDirty = false, live = 0;
  const stats = { flow: 0, streaks: 0, motes: 0 };
  const DBG = { motes: 1, streaks: 1 }; // opacity multipliers (tuning / debug)
  function spawnStreak(ctx, turb) {
    const t = env.time, cam = ctx.cam, g = ctx.g, n = lvl().streaks;
    let i = -1;
    for (let k = 0; k < n; k++) if (sDeath[k] <= t) { i = k; break; }
    if (i < 0) return;
    for (let tries = 0; tries < 3; tries++) {
      // somewhere in view, 3–35 m out, mostly near (a few just off screen, to sweep in)
      const d = 3 + Math.pow(Math.random(), 1.2) * 32, sx = (Math.random() * 2 - 1) * 1.15, sy = (Math.random() * 2 - 1) * 1.15;
      const x = cam.pos[0] + (cam.f[0] + cam.r[0] * sx * cam.tanX + cam.u[0] * sy * cam.tanY) * d;
      const y = cam.pos[1] + (cam.f[1] + cam.r[1] * sx * cam.tanX + cam.u[1] * sy * cam.tanY) * d;
      const z = cam.pos[2] + (cam.f[2] + cam.r[2] * sx * cam.tanX + cam.u[2] * sy * cam.tanY) * d;
      if (y < groundH(x, z) + 0.8) continue;
      GUST.field(x, z, t, gf2);
      if (Math.random() > 0.3 + 0.7 * gf2[0] + turb * 0.3) continue; // streaks gather in the gusts
      // the air there: the glider's air plus how the gust field differs between there and here, plus a little churn
      const j = 0.4 + turb * 1.2;
      const vx = g.wind[0] + gf2[2] * gf2[1] - gf[2] * gf[1] + (Math.random() - 0.5) * j;
      const vy = g.wind[1] + (Math.random() - 0.5) * j * 0.7;
      const vz = g.wind[2] + gf2[3] * gf2[1] - gf[3] * gf[1] + (Math.random() - 0.5) * j;
      const r1 = Math.random(), r2 = Math.random(), life = 0.7 + Math.random() * 1.3;
      const o = i * 16;
      sData[o] = x; sData[o + 1] = y; sData[o + 2] = z; sData[o + 3] = t;
      const L = Math.min(4 + r1 * r1 * 20, 1.5 + d * 0.8); // close ones shorter, so none sprawls across the screen
      sData[o + 4] = life; sData[o + 5] = L; sData[o + 6] = 0.02 + r2 * 0.055; sData[o + 7] = 0.8 + Math.random() * 1.4;
      sData[o + 8] = vx; sData[o + 9] = vy; sData[o + 10] = vz; sData[o + 11] = Math.random();
      sData[o + 12] = L * (0.015 + 0.045 * turb + 0.03 * Math.random()); sData[o + 13] = 0.3 + Math.random() * 1.2;
      sData[o + 14] = Math.random() * TAU; sData[o + 15] = (Math.random() - 0.5) * 0.16 * (0.5 + turb);
      sDeath[i] = t + life; sDirty = true;
      return;
    }
  }
  function update(dt, ctx) {
    const g = ctx.g, cam = ctx.cam, t = env.time;
    camAgl = cam.pos[1] - Math.max(terrainH(cam.pos[0], cam.pos[2], 0), 0);
    // how strong and rough the flow is here: airspeed, the gust we're in, ridge and thermal air
    GUST.field(g.pos[0], g.pos[2], t, gf);
    const speed = ss(12, 38, g.V || 0), vert = Math.abs(g.wind[1]);
    const turb = clamp(gf[0] * 0.7 + ss(1, 4, vert) * 0.5, 0, 1);
    let want = speed * (0.35 + 0.9 * gf[0]) + ss(0.8, 3.5, vert) * 0.45 * (0.3 + speed);
    if (ctx.mode !== 'play' || g.live === false || g.onGround || g.crashT > 0) want = 0;
    flow += (want - flow) * (1 - Math.exp(-dt * 2.5));
    if (!(dt > 0)) return;
    spawnAcc += dt * flow * 13;
    while (spawnAcc >= 1) { spawnAcc -= 1; spawnStreak(ctx, turb); }
    live = 0;
    for (let k = 0; k < SMAX; k++) if (sDeath[k] > t) live++;
    stats.flow = flow; stats.streaks = live;
  }
  function drawTransparent(ctx) {
    if (ctx.shadow >= 0) return;
    const L = lvl(), cam = ctx.cam, g = ctx.g;
    const pix = 2 * cam.tanY * env.atm[1];
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    GLX.prof.mark('windfx');
    if (camAgl < 140) {
      gl.useProgram(MoteP.p); setEnv(MoteP);
      gl.uniform3fv(MoteP.u.uCR, cam.r); gl.uniform3fv(MoteP.u.uCU, cam.u);
      gl.uniform4f(MoteP.u.uBox, BOX, (1 - ss(70, 140, camAgl)) * DBG.motes, pix, 0);
      gl.bindVertexArray(moteVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.motes);
      stats.motes = L.motes;
    } else stats.motes = 0;
    if (live) {
      if (sDirty) { gl.bindBuffer(gl.ARRAY_BUFFER, streakBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sData); sDirty = false; }
      gl.useProgram(StreakP.p); setEnv(StreakP);
      gl.uniform3fv(StreakP.u.uGV, g.vel); gl.uniform3fv(StreakP.u.uGp, g.pos);
      gl.uniform3fv(StreakP.u.uGR, g.r); gl.uniform3fv(StreakP.u.uGU, g.u); gl.uniform3fv(StreakP.u.uGF, g.f);
      gl.uniform2f(StreakP.u.uPix, pix, DBG.streaks);
      gl.bindVertexArray(streakVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEG + 1) * 2, L.streaks);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true); gl.disable(gl.BLEND);
  }
  return { name: 'windfx', update, drawTransparent, stats, DBG, get level() { return level; }, set level(v) { level = v == null ? null : clamp(v | 0, 0, 2); } };
})();
MODELS.push(WINDFX);
