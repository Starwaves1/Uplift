'use strict';
// ───────────────────────── Terrain (CDLOD, heights on GPU), water, sky ─────────────────────────
const TERRAIN = (() => {
  const { gl, program, buffer, attribs, env, setEnv } = GLX;
  const N = 32, LEAF = 64, LEVELS = 9, MINH = -120, MAXH = 1350;
  // LOD ranges: a node of level L is drawn out to RK·64·2^L m (scaled down by the quality preset's lod factor)
  const RK = 2.8;
  const RANGE = new Float64Array(LEVELS);
  for (let L = 0; L < LEVELS; L++) RANGE[L] = LEAF * Math.pow(2, L) * RK;

  // grid + quadrant-ordered indices
  const gv = new Float32Array((N + 1) * (N + 1) * 2);
  for (let j = 0, k = 0; j <= N; j++) for (let i = 0; i <= N; i++) { gv[k++] = i; gv[k++] = j; }
  const gi = new Uint16Array(N * N * 6);
  let ki = 0;
  const quad = (i0, j0) => {
    for (let j = j0; j < j0 + N / 2; j++) for (let i = i0; i < i0 + N / 2; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      if ((i + j) & 1) { gi[ki++] = a; gi[ki++] = c; gi[ki++] = b; gi[ki++] = b; gi[ki++] = c; gi[ki++] = d; }
      else { gi[ki++] = a; gi[ki++] = c; gi[ki++] = d; gi[ki++] = a; gi[ki++] = d; gi[ki++] = b; }
    }
  };
  quad(0, 0); quad(N / 2, 0); quad(0, N / 2); quad(N / 2, N / 2);
  const QIDX = N * N * 6 / 4;

  const MAXI = 4096;
  const inst = new Float32Array(MAXI * 8); // per node: x, z, size, lod, cache slot origin (x, y), unused ×2
  const lists = [[], [], [], [], []]; // full, q0..q3 (flat arrays of x,z,size,lod)
  const tvao = gl.createVertexArray();
  gl.bindVertexArray(tvao);
  attribs(buffer(gv), [[0, 2, 2, 0, 0]]);
  // node lists are uploaded several times a frame (camera + shadow cascades): each upload gets its own region of a
  // ring so the GPU never has to wait for an earlier draw to finish reading before the buffer is rewritten
  const RING = 8;
  const ibuf = buffer(new Float32Array(MAXI * 8 * RING), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  let ring = 0;
  attribs(ibuf, [[1, 4, 8, 0, 1], [2, 2, 8, 4, 1]]);
  buffer(gi, gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);

  // Heights come from the tile cache (see below): each node's grid was evaluated once, with the terrain filtered for
  // its own LOD (.r) and for its parent's (.g). Toward the outer edge of its range a node morphs both its vertex
  // positions and its heights onto the parent's grid and filter, so neighbouring LODs meet exactly. A second cache
  // holds what the materials need to know about the landform: how enclosed the spot is (hollow vs ridge; at the
  // node's scale and its parent's, morphed the same way) and whether it's in the dry canyon country.
  const TVS = GLSL_COMMON + `
layout(location=0) in vec2 aGrid;
layout(location=1) in vec4 aNode;
layout(location=2) in vec2 aSlot;
uniform mat4 uVP; uniform highp sampler2D uHC; uniform sampler2D uHM; uniform float uRangeK;
out vec3 vRel; out vec3 vN; out float vH; out float vForest; out float vVar; out float vVar2; out float vCurv; out float vDry;
void main(){
  float cell = aNode.z / 32.0;
  vec2 wp = aNode.xy + aGrid*cell;
  float range = 64.0*exp2(aNode.w)*uRangeK;
  float dy = max(uCam.y - 1350.0, 0.0);
  vec2 dd = wp - uCam.xz;
  float d = sqrt(dot(dd,dd) + dy*dy);
  float k = clamp((d - range*0.62)/(range*0.36), 0.0, 1.0);
  wp -= fract(aGrid*0.5)*2.0*cell*k;
  ivec2 g = ivec2(aGrid + 0.5), base = ivec2(aSlot + 0.5) + 1, gm = g - (g & ivec2(1));
  vec2 hA = texelFetch(uHC, base + g, 0).rg, hB = texelFetch(uHC, base + gm, 0).rg;
  float h = mix(hA.x, mix(hA.y, hB.y, k), k);
  vec2 hl = texelFetch(uHC, base + g - ivec2(1, 0), 0).rg, hr = texelFetch(uHC, base + g + ivec2(1, 0), 0).rg;
  vec2 hd = texelFetch(uHC, base + g - ivec2(0, 1), 0).rg, hu = texelFetch(uHC, base + g + ivec2(0, 1), 0).rg;
  vec2 nx = hl - hr, nz = hd - hu;
  vN = vec3(mix(nx.x, nx.y, k), 2.0*cell, mix(nz.x, nz.y, k));
  vH = h;
  vec4 mA = texelFetch(uHM, base + g, 0), mB = texelFetch(uHM, base + gm, 0);
  vCurv = mix(mA.r, mix(mA.g, mB.g, k), k)*2.0 - 1.0;
  vDry = mA.b;
  vForest = forestMask(wp);
  vVar = vn(wp*0.004 + vec2(5.5, 2.5));
  vVar2 = vn(wp*0.021 + vec2(1.5, 8.5));
  vRel = vec3(wp.x - uCam.x, h - uCam.y, wp.y - uCam.z);
  gl_Position = uVP*vec4(vRel, 1.0);
}`;
  const TFS = GLSL_COMMON + `
in vec3 vRel; in vec3 vN; in float vH; in float vForest; in float vVar; in float vVar2; in float vCurv; in float vDry;
uniform vec3 uG, uGR, uGF, uGV; uniform float uGAgl, uDetail;
const float SNOWLINE = 1350.0; // m
out vec4 o;
// the nearest point of a fully jittered lattice (irregular polygonal cells): (distance, the cell's random id)
vec2 vorF1(vec2 p){
  vec2 ip = floor(p), f = p - ip;
  float d1 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = ivec2(ip) + ivec2(i, j);
    vec2 r = vec2(i, j) + vec2(hash2(c), hash2(c + ivec2(57, 113)))*0.9 + 0.05 - f;
    float d = dot(r, r);
    if (d < d1) { d1 = d; id = hash2(c + ivec2(19, 7)); }
  }
  return vec2(sqrt(d1), id);
}
// fractured rock on one projection (p in metres; on walls v is the height): a broad bulge, a runoff grain down the
// walls, fracture planes at two scales (the cells of a warped Voronoi lattice, each tilted a little its own way) and a
// rough grain on the faces. Returns (height m, d/du, d/dv); accumulates the fragments' tone.
vec3 rockRelief(vec2 p, float fr, int oct, inout float tone){
  vec3 m = vnd(p/40.0 + vec2(3.3, 7.7));
  vec3 acc = vec3(m.x*3.0, m.yz*(3.0/40.0))*(1.0 - smoothstep(4.0, 12.0, fr));
  vec3 g = vnd(vec2(p.x/6.0, p.y/38.0) + vec2(5.5, 1.3));
  acc += vec3(g.x*1.2, g.y*(1.2/6.0), g.z*(1.2/38.0))*(1.0 - smoothstep(0.8, 2.5, fr));
  if (fr > 2.8) return acc;
  bool hi = oct > 2; // High: warped fragments at two scales and the grain; Medium: one scale
  vec2 q = hi ? p + (vec2(vn(p/23.0 + vec2(1.7, 9.2)), vn(p/23.0 + vec2(8.3, 2.8))) - 0.5)*9.0 : p;
  float S = 14.0, A = 0.14;
  for (int i = 0; i < 2; i++) {
    float w = 1.0 - smoothstep(S*0.06, S*0.2, fr);
    if (w <= 0.0 || (i > 0 && !hi)) break;
    float id = vorF1(q/S + vec2(float(i)*17.3, float(i)*5.9)).y;
    acc += w*vec3(S*0.08*(id - 0.5), (vec2(id, fract(id*37.1)) - 0.5)*2.0*A);
    tone += w*(id - 0.5);
    S *= 0.36; A *= 0.75;
  }
  float wl = 2.4, am = 0.35;
  for (int i = 0; i < 2; i++) {
    float w = 1.0 - smoothstep(wl*0.12, wl*0.4, fr);
    if (i >= oct - 1 || w <= 0.0) break;
    vec3 r = vnd(q/wl + vec2(4.4 + float(i)*3.3, 0.7));
    acc += w*vec3(am*r.x, am*r.yz/wl);
    wl *= 0.4; am *= 0.45;
  }
  return acc;
}
// ── photoscanned ground (High): layers of two texture arrays, in the order of MAT_IDS in the JS below — sRGB albedo, and
// the tangent normal (xy, OpenGL: +x east, +y image-up) with the scan's height (z) ──
uniform mediump sampler2DArray uMatC, uMatN; uniform float uMat;
// metres of ground per tile (aerial scans 15–90 m, close-ups 1.3–3 m) and each layer's mean luminance
const float TILE[18] = float[18](50.0, 80.0, 90.0, 15.0, 20.0, 15.0, 30.0, 80.0, 2.7, 1.5, 2.0, 2.0, 2.5, 2.0, 3.0, 1.3, 2.0, 2.0);
const float MLUM[18] = float[18](0.17, 0.15, 0.12, 0.14, 0.24, 0.11, 0.42, 0.55, 0.24, 0.24, 0.36, 0.2, 0.24, 0.14, 0.12, 0.19, 0.14, 0.82);
const int L_GRANITE = 0, L_BROKEN = 1, L_ALPINE = 2, L_FELL = 3, L_DRY = 4, L_SHORE = 5, L_BEACH = 6, L_SNOWFIELD = 7,
  L_FACE = 8, L_PALE = 9, L_KARST = 10, L_SCREE = 11, L_GRAVEL = 12, L_GRASS = 13, L_LEAVES = 14, L_SOIL = 15, L_REDSOIL = 16,
  L_SNOW = 17;
const mat2 MROT = mat2(0.8, 0.6, -0.6, 0.8);
float lumi(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// the scan's slope along its own axes from the tangent normal: (dh/du, dh/dv) with v running down the image
vec2 tslope(vec2 rg){ vec2 t = rg*2.0 - 1.0; return vec2(-t.x, t.y)/sqrt(max(1.0 - dot(t, t), 0.09)); }
float matFar; // per pixel, 0 near … ~0.65 far: how much the scans' own contrast has faded toward their average colour
// a layer seen from above at p (m), tiles k× their true size: linear albedo, world slope (dh/dx, dh/dz), height 0…1.
// Two lookups — the tile, and a copy rotated ~37° and 1.37× larger — swapped every half tile or so by a noise and by
// their own heights, so even a 15 m scan doesn't repeat as a grid; far off, the scan's contrast fades toward its average
// (its last mip), and the broad variation laid on top carries the land instead
void matTop(int L, vec2 p, float k, out vec3 a, out vec2 g, out float h){
  float t = TILE[L]*k, l = float(L);
  vec3 u1 = vec3(p/t, l), u2 = vec3(MROT*(p/(t*1.37)) + vec2(0.31, 0.77), l);
  vec3 n1 = texture(uMatN, u1).rgb, n2 = texture(uMatN, u2).rgb;
  float b = smoothstep(0.25, 0.75, vn(p/(t*0.61) + vec2(l*7.1, 3.3))*0.7 + vn(p/(t*2.3) + vec2(1.7, l))*0.3 + (n2.b - n1.b)*0.6);
  a = mix(texture(uMatC, u1).rgb, texture(uMatC, u2).rgb, b);
  if (matFar > 0.0) a = mix(a, textureLod(uMatC, u1, 10.0).rgb, matFar);
  h = mix(n1.b, n2.b, b);
  g = mix(tslope(n1.rg), transpose(MROT)*tslope(n2.rg), b)*(1.0 - matFar);
}
// a layer on steep ground: projected along the three world axes (the faces upright: image-up is world-up) and blended
// by the normal, so nothing stretches down a wall. Returns the albedo, the normal with the layer's relief, the height
void matTri(int L, vec3 p, vec3 n0, float k, out vec3 a, out vec3 n, out float h){
  vec3 bw = pow(abs(n0), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
  float t = TILE[L]*k, l = float(L);
  vec3 d = vec3(0.0); a = vec3(0.0); h = 0.0;
  if (bw.x > 0.02) { vec3 u = vec3(vec2(p.z, -p.y)/t, l), q = texture(uMatN, u).rgb; vec2 s = tslope(q.rg);
    a += texture(uMatC, u).rgb*bw.x; h += q.b*bw.x; d += vec3(0.0, -s.y, s.x)*bw.x; }
  if (bw.z > 0.02) { vec3 u = vec3(vec2(p.x, -p.y)/t + 0.37, l), q = texture(uMatN, u).rgb; vec2 s = tslope(q.rg);
    a += texture(uMatC, u).rgb*bw.z; h += q.b*bw.z; d += vec3(s.x, -s.y, 0.0)*bw.z; }
  if (bw.y > 0.02) { vec3 u = vec3(p.xz/t + 0.71, l), q = texture(uMatN, u).rgb; vec2 s = tslope(q.rg);
    a += texture(uMatC, u).rgb*bw.y; h += q.b*bw.y; d += vec3(s.x, 0.0, s.y)*bw.y; }
  n = normalize(n0 - d);
}
// shrub cover seen from above: round bushes on a jittered lattice of spacing s (m), each present with probability dens and
// its own size; where a bush gets smaller than a pixel (fp m) it fades to the average cover instead of shimmering
float shrubs(vec2 p, float s, float dens, float fp){
  vec2 v = vorF1(p/s);
  float r = 0.32 + 0.24*fract(v.y*13.7), e = max(fp/s, 0.05);
  float m = step(v.y, dens)*smoothstep(r + e, r - e, v.x);
  return mix(m, dens*0.62, smoothstep(0.12, 0.45, fp/s));
}
float gliderShadow(vec3 wp){
  if (uSun.y < 0.05) return 0.0;
  float t = (uG.y - wp.y)/uSun.y;
  if (t < 0.0 || t > 420.0) return 0.0;
  vec3 sp = wp + uSun*t - uG;
  float lx = dot(sp, uGR), lz = -dot(sp, uGF);
  float ax = abs(lx);
  float le = -1.0 + ax*0.33, te = le + max(1.9 - ax*0.36, 0.0);
  float s = 0.2 + t*0.018;
  float m = smoothstep(3.8+s, 3.8-s, ax)*smoothstep(le-s, le+s, lz)*smoothstep(te+s, te-s, lz);
  if (ax < 0.35) m = max(m, smoothstep(0.35+s, 0.2, ax)*smoothstep(-1.7-s, -1.5, lz)*smoothstep(1.5+s, 1.3, lz));
  return m*(1.0 - smoothstep(40.0, 420.0, t));
}
void main(){
  vec3 n = normalize(vN);
  vec3 wp = vRel + uCam;
  float dist = length(vRel);
  float slope = 1.0 - n.y;
  // procedural texture filtering: each octave fades out as its features approach the size of a pixel
  float fp = max(length(fwidth(wp.xz)), 1e-3);
  // ── materials: the landform decides what grows and what settles where ──
  float alt = vH + (vVar - 0.5)*70.0;                          // altitude, noised so zones don't follow contour lines
  // enclosure (vCurv) runs about ±0.03 in the lowlands, ±0.1 in the mountains (±0.3–0.5 at the extremes): soft
  // thresholds for moisture, firm ones for gullies (snow, scree) and crests (bare, wind-scoured rock)
  float hollow = smoothstep(0.005, 0.1, vCurv), ridgeC = smoothstep(0.005, 0.12, -vCurv);
  float gully = smoothstep(0.1, 0.32, vCurv), crest = smoothstep(0.12, 0.45, -vCurv);
  float moist = clamp(0.55 + hollow*0.6 - ridgeC*0.45 - vDry*0.75 + (vVar2 - 0.5)*0.4 - smoothstep(300.0, 700.0, alt)*0.15, 0.0, 1.0);
  // meadows: lush in valleys and hollows, sun-dried gold on ridges and in the dry country, olive turf up high
  vec3 lush = mix(vec3(0.30,0.56,0.20), vec3(0.22,0.46,0.18), smoothstep(0.5, 0.85, vVar2));
  vec3 dryG = mix(vec3(0.60,0.64,0.29), vec3(0.76,0.65,0.36), vVar);
  vec3 col = mix(dryG, lush, smoothstep(0.25, 0.75, moist));
  col = mix(col, mix(vec3(0.46,0.52,0.28), vec3(0.58,0.55,0.34), vVar2), smoothstep(560.0, 860.0, alt)*(1.0 - vDry));
  col = mix(col, vec3(0.11,0.28,0.13), vForest*0.88);
  // shore: dark wet sand at the waterline, dry sand above (reddish in the dry country)
  vec3 sand = mix(vec3(0.50,0.46,0.36), mix(vec3(0.86,0.80,0.62), vec3(0.86,0.66,0.48), vDry), smoothstep(0.3, 1.6, vH));
  col = mix(sand, col, smoothstep(0.9, 2.8, vH + vVar*0.8));
  // rock where it's steep (and high up, where the soil is thin, where it's less so) and on exposed crests: grey granite;
  // banded red sandstone in the dry country
  float thin = smoothstep(1050.0, 1600.0, alt);
  float rk = smoothstep(0.3, 0.5, slope + (vVar - 0.5)*0.16 + crest*0.18*smoothstep(750.0, 1150.0, alt) + thin*0.12);
  vec3 granite = mix(vec3(0.52,0.51,0.49), vec3(0.64,0.61,0.56), vVar2);
  vec3 sandstone = mix(vec3(0.70,0.42,0.28), vec3(0.84,0.64,0.45), smoothstep(0.2, 0.8, vn(vec2(vH/16.0 + vVar*2.0, 1.5))));
  vec3 rock = mix(granite, sandstone, vDry);
  // scree: rubble fans under the faces (moderate slopes in the high country, gathered in hollows where the rock sheds)
  float scree = clamp(smoothstep(0.14, 0.28, slope)*(1.0 - rk)*smoothstep(420.0, 700.0, alt)*(0.3 + hollow*0.4 + gully + thin*0.5)*(1.0 - vForest)*1.5, 0.0, 1.0);
  col = mix(col, rock*vec3(1.04, 1.03, 1.0), scree*0.85);
  col = mix(col, rock, rk);
  // snow: above a snow line that drops in gullies and on slopes turned from the (midday) sun and rises on wind-scoured
  // crests. It lies on ground up to about 50° and collects in gullies a little below the line; a per-pixel noise rags
  // its edges
  float shaded = 1.0 - clamp(dot(normalize(vN), vec3(0.31, 0.55, -0.78))*1.4, 0.0, 1.0);
  float rag = vn(wp.xz/23.0 + vec2(3.3, 8.8)) - 0.5 + (vn(wp.xz/7.0 + vec2(1.2, 5.4)) - 0.5)*0.5*(1.0 - smoothstep(1.0, 4.0, fp));
  float line = SNOWLINE - 170.0*gully + 130.0*crest - 170.0*shaded + (vVar - 0.5)*220.0 + vDry*300.0 + rag*70.0;
  float lies = smoothstep(0.42, 0.26, slope + rag*0.08);
  float sn = smoothstep(line - 40.0, line + 50.0, vH)*lies;
  sn = max(sn, smoothstep(0.3, 0.7, gully + rag*0.3)*smoothstep(line - 240.0, line - 90.0, vH)*lies);
  col = mix(col, vec3(0.95,0.96,0.98), sn);
  if (vH < 0.0) col = mix(vec3(0.62,0.6,0.48), vec3(0.3,0.33,0.28), smoothstep(0.0, 14.0, -vH)); // sand to silt: the water's absorption tints it
  float grass = (1.0-rk)*(1.0-sn)*(1.0-scree)*(1.0-vForest*0.8)*smoothstep(2.0, 6.0, vH);
  float cav = 0.0;
  // ── photoscanned ground (High, once the layers have loaded): the same landform classes plus the island's own maps
  // (cliffs, scree, rivers), each drawn with the scans of its region and height-blended — stones and rock poke through
  // the turf instead of cross-fading into it. Close-up scans add the fine detail over the last ~150 m ──
  bool mats = uMat > 0.5 && uDetail > 1.5 && vH > -0.5;
  vec3 albL = vec3(0.0);
  if (mats) {
    vec4 im = islandMaps(wp.xz), rg = islandRegions(wp.xz);   // flow, sediment, scree, cliff; Nordic, Med, plateau, volcano
    float nord = rg.x, med = rg.y, plat = rg.z, volc = rg.w, alp = clamp(1.0 - nord - med - plat - volc, 0.0, 1.0);
    matFar = smoothstep(400.0, 2500.0, dist)*0.65;
    float wSnow = sn;
    // bare rock: the landform's, the island's cliffs, and the thin-soiled Nordic granite on moderate slopes and knolls
    float wRock = max(max(rk, smoothstep(0.35, 0.8, im.a)), nord*smoothstep(0.36, 0.56, slope + ridgeC*0.25))*(1.0 - wSnow);
    float wScree = max(scree, smoothstep(0.3, 0.7, im.b)*smoothstep(0.08, 0.22, slope))*(1.0 - wRock)*(1.0 - wSnow);
    float wShore = (1.0 - smoothstep(0.9, 2.8, vH + vVar*0.8))*(1.0 - wRock);
    float wGravel = smoothstep(0.62, 0.82, im.r)*(1.0 - smoothstep(0.05, 0.16, slope))*(1.0 - wShore)*(1.0 - wSnow);
    float rest = (1.0 - wSnow)*(1.0 - wRock)*(1.0 - wScree)*(1.0 - wShore)*(1.0 - wGravel);
    float wForest = vForest*0.9*rest, wMeadow = rest - wForest;
    float wall = smoothstep(0.38, 0.62, slope)*wRock;                 // the share drawn as upright rock faces
    vec3 a, sumA = vec3(0.0); vec2 g, sumG = vec2(0.0); float h, e, sumW = 1e-5, sumH = 0.0;
    // each layer adds in by its class weight, favoured where its own surface stands high
    #define ADDL(w) e = (w)*exp2(5.0*h - 2.5); sumA += a*e; sumG += g*e; sumH += h*e; sumW += e;
    if (wMeadow > 0.01) {
      vec2 p = wp.xz;
      // patches at three scales: what breaks up a hillside seen from the air
      float pch = vn(p/9.0 + vec2(3.1, 0.4))*0.4 + vn(p/33.0 + vec2(7.7, 2.6))*0.35 + vn(p/140.0 + vec2(1.9, 5.3))*0.25;
      float hiG = smoothstep(850.0, 1350.0, alt);                    // the maquis gives way to alpine turf higher up
      float wf = nord, wa = alp + (med*moist*0.35 + (med*(1.0 - moist*0.35) + plat)*hiG), wd = (med*(1.0 - moist*0.35) + plat)*(1.0 - hiG), wv = volc;
      float s = wf + wa + wd + wv + 1e-4; wf /= s; wa /= s; wd /= s; wv /= s;
      if (wf > 0.02) {           // Nordic fell: heath and moss, broken by ice-scoured granite slabs on every knoll
        float slab = smoothstep(0.55, 0.78, pch + ridgeC*0.35 + slope*0.5 - hollow*0.35);
        if (slab < 0.98) {       // heath: the scan's yellow moss turned toward olive and brown, bog-green in the hollows
          matTop(L_FELL, p, 1.0, a, g, h);
          a = mix(a, lumi(a)*mix(vec3(0.95, 0.95, 0.68), vec3(0.78, 1.05, 0.62), hollow), 0.6);
          ADDL(wMeadow*wf*(1.0 - slab))
        }
        if (slab > 0.02) { matTop(L_GRANITE, p, 1.0, a, g, h); ADDL(wMeadow*wf*slab) }
      }
      if (wa > 0.02) {           // alpine grass, stonier on knolls and higher up
        float stony = smoothstep(0.55, 0.8, pch + ridgeC*0.3 + slope*0.9 + smoothstep(900.0, 1700.0, alt)*0.4);
        if (stony < 0.98) { matTop(L_ALPINE, p, 1.0, a, g, h); ADDL(wMeadow*wa*(1.0 - stony)) }
        if (stony > 0.02) { matTop(L_BROKEN, p, 1.0, a, g, h); ADDL(wMeadow*wa*stony) }
      }
      if (wd > 0.02) {           // Mediterranean garrigue: pale stony ground dotted with maquis; karst pavement on the plateau
        matTop(L_DRY, p, 1.0, a, g, h); a = mix(a, lumi(a)*vec3(1.1, 1.0, 0.8), 0.55);                // pale buff limestone ground
        float pave = plat*smoothstep(0.55, 0.75, pch + ridgeC*0.3);    // on the causse: bare pavement on the swells
        if (pave > 0.02) { vec3 a2; vec2 g2; float h2; matTop(L_KARST, p, 6.0, a2, g2, h2); a = mix(a, lumi(a2)*vec3(1.02, 1.0, 0.92)*0.62, pave); h = mix(h, h2, pave); g = mix(g, g2, pave); }
        // the maquis: single shrubs (~4 m apart) and bigger bushes (~9 m), thick in gullies and on shaded slopes, sparse
        // on sunny ridges, each with its short shadow thrown away from the sun
        float dens = smoothstep(0.05, 0.62,vn(p/33.0 + vec2(7.7, 2.6))*0.55 + vn(p/140.0 + vec2(1.9, 5.3))*0.45 + moist*0.35 + shaded*0.22 - 0.2 - plat*0.25);
        vec2 sd = uSun.xz/max(uSun.y, 0.35)*1.3;
        float sc = max(shrubs(p, 4.0, dens, fp), shrubs(p + 17.3, 9.5, dens*0.75, fp));
        float ss = max(shrubs(p + sd, 4.0, dens, fp), shrubs(p + sd + 17.3, 9.5, dens*0.75, fp))*(1.0 - sc);
        vec3 bush = vec3(0.045, 0.062, 0.03)*(0.8 + 0.4*vn(p/2.1 + vec2(3.3, 9.9)));
        a = mix(a*(1.0 - 0.45*ss), bush, sc);
        h = mix(h, 0.85, sc);
        ADDL(wMeadow*wd)
      }
      if (wv > 0.02) {           // the volcano: grass low on its skirts, dark scoria and ash above
        float ash = smoothstep(650.0, 1250.0, alt + (pch - 0.5)*300.0);
        if (ash < 0.98) { matTop(L_ALPINE, p, 1.0, a, g, h); ADDL(wMeadow*wv*(1.0 - ash)) }
        if (ash > 0.02) { matTop(L_BROKEN, p, 1.0, a, g, h); a = lumi(a)*vec3(0.55, 0.5, 0.47); ADDL(wMeadow*wv*ash) }
      }
    }
    if (wForest > 0.01) {        // the floor under the trees: dark and green from the air, leaf litter up close
      matTop(L_LEAVES, wp.xz, 4.0, a, g, h); a = vec3(0.04, 0.075, 0.032)*(lumi(a)/MLUM[L_LEAVES]); ADDL(wForest)
    }
    if (wScree > 0.01) { matTop(L_SCREE, wp.xz, 5.0, a, g, h); ADDL(wScree) }
    if (wShore > 0.01) {         // pale warm sand in the south, shingle and rock on the Nordic shore
      if (nord < 0.6) { matTop(L_BEACH, wp.xz, 1.0, a, g, h); a = mix(a, lumi(a)*vec3(1.12, 1.03, 0.86), med + plat); ADDL(wShore*(1.0 - nord)) }
      if (nord > 0.02) { matTop(L_SHORE, wp.xz, 1.0, a, g, h); ADDL(wShore*nord) }
    }
    if (wGravel > 0.01) { matTop(L_GRAVEL, wp.xz, 4.0, a, g, h); a = mix(a, lumi(a)*vec3(0.95, 0.98, 1.02)*1.1, 0.6); ADDL(wGravel) }
    if (wSnow > 0.01) { matTop(L_SNOWFIELD, wp.xz, 1.0, a, g, h); a = mix(a, vec3(0.82), 0.45*smoothstep(0.6, 1.0, wSnow)); ADDL(wSnow) }
    // rock: granite slabs (the volcano's broken basalt) where it lies back, upright faces where it's steep; recoloured
    // by region — grey granite, pale streaked limestone in the south and on the plateau, dark basalt on the volcano
    vec3 triN = n;
    if (wRock > 0.01) {
      vec3 ra = vec3(0.0); vec2 rgr = vec2(0.0); float rh = 0.0;
      if (wall < 0.99) { matTop(volc > 0.5 ? L_BROKEN : L_GRANITE, wp.xz, 1.0, a, g, h); ra = a*(1.0 - wall); rgr = g*(1.0 - wall); rh = h*(1.0 - wall); }
      if (wall > 0.01) {         // faces: two scans at different scales, swapped by a slow noise, so no tile repeats up a wall
        bool lime = med + plat > 0.5;
        vec3 a2, n2; float h2;
        matTri(lime ? L_PALE : L_FACE, wp, n, lime ? 14.0 : 7.0, a, triN, h);
        matTri(L_FACE, wp + 41.3, n, lime ? 11.0 : 17.0, a2, n2, h2);
        float sw = smoothstep(0.35, 0.65, vn(wp.xz/70.0 + wp.y/45.0 + vec2(2.9, 6.1)) + (h2 - h)*0.4);
        a = mix(a, a2, sw); triN = normalize(mix(triN, n2, sw)); h = mix(h, h2, sw);
        ra += a*wall; rh += h*wall;
      }
      float lg = lumi(ra);
      // recoloured by region, keeping some of each scan's own streaks and stains
      a = mix(ra, lg*vec3(0.95, 0.98, 1.02), 0.6)*(nord + alp) + mix(ra, lg*vec3(1.08, 1.02, 0.92)*1.1, 0.5)*(med + plat) + lg*vec3(0.6, 0.58, 0.57)*volc;
      g = rgr; h = rh;                                                  // the faces' relief is in triN
      ADDL(wRock)
    }
    albL = sumA/sumW; vec2 gs = sumG/sumW; float hb = sumH/sumW;
    // close-ups of the dominant ground over the last ~150 m: its fine light and shade and its relief
    float near = 1.0 - smoothstep(40.0, 160.0, dist);
    if (near > 0.01) {
      int Lc = wRock > 0.5 ? (med + plat > 0.5 ? L_PALE : L_FACE) : wSnow > 0.5 ? L_SNOW : wScree > 0.5 ? L_SCREE :
        (wShore > 0.5 || wGravel > 0.5) ? L_GRAVEL : wForest > 0.5 ? L_LEAVES : (med + plat > 0.5 ? (moist > 0.5 ? L_REDSOIL : L_SOIL) : L_GRASS);
      if (wRock > 0.5) { vec3 cn; matTri(Lc, wp, triN, 1.0, a, cn, h); triN = normalize(mix(triN, cn, near*0.8)); }
      else { matTop(Lc, wp.xz, 1.0, a, g, h); gs += g*near*0.6; }
      albL *= mix(1.0, lumi(a)/MLUM[Lc], near*0.7);
    }
    // broad variation, 50 m to a kilometre: lighter and darker ground, and sun-dried patches
    float mv = vn(wp.xz/47.0 + vec2(2.2, 7.1))*0.3 + vn(wp.xz/180.0 + vec2(5.1, 0.6))*0.45 + vn(wp.xz/650.0 + vec2(8.3, 3.9))*0.25;
    albL *= 0.78 + 0.44*mv;
    albL = mix(albL, albL*vec3(1.08, 1.0, 0.84), smoothstep(0.45, 0.8, vn(wp.xz/320.0 + vec2(4.4, 1.2)))*0.6*(1.0 - wSnow)*(1.0 - wRock));
    vec3 nTop = normalize(vec3(n.x/max(n.y, 0.2) - gs.x, 1.0, n.z/max(n.y, 0.2) - gs.y));
    n = normalize(mix(nTop, triN, clamp(wall*1.2, 0.0, 1.0)));
    cav = (hb - 0.5)*0.8;
    grass = wMeadow*smoothstep(2.0, 6.0, vH);
    #undef ADDL
  }
  // per-pixel relief (heightfield slopes added to the vertex normal): hummocks, clods, pebbles; rock is much rougher
  if (uDetail > 0.0 && !mats) {
    float rough = mix(mix(1.0, 2.2, scree), 3.2, rk)*mix(1.0, 0.45, sn)*mix(1.0, 0.6, vForest);
    vec2 gsum = vec2(0.0);
    vec3 d1 = vnd(wp.xz/90.0 + vec2(3.7, 1.1));
    float w1 = 1.0 - smoothstep(9.0, 30.0, fp);
    gsum += d1.yz*(5.0/90.0)*w1;
    cav += (d1.x - 0.5)*w1*0.5;
    vec3 d2 = vnd(wp.xz/21.0 + vec2(8.3, 5.9));
    float w2 = 1.0 - smoothstep(2.0, 7.0, fp);
    gsum += d2.yz*(1.1/21.0)*w2;
    cav += (d2.x - 0.5)*w2*0.7;
    if (uDetail > 1.5) {
      vec3 d3 = vnd(wp.xz/4.5 + vec2(1.9, 7.3));
      float w3 = 1.0 - smoothstep(0.45, 1.5, fp);
      gsum += d3.yz*(0.22/4.5)*w3;
      cav += (d3.x - 0.5)*w3*0.6;
    }
    gsum *= rough;
    vec3 n0 = n;
    n = normalize(vec3(n.x/max(n.y, 0.2) - gsum.x, 1.0, n.z/max(n.y, 0.2) - gsum.y));
    // rock faces: jointed stone — blocks at three scales split by joints — projected along the three world axes and
    // blended by the normal (triplanar: nothing depends on the local slope direction, so nothing smears or folds where
    // the terrain curves). Walls get blocks a little taller than wide. The pixel footprint is measured in 3D, so steep
    // faces filter as cleanly as flat ground.
    if (rk > 0.02) {
      vec3 bw = pow(abs(n0), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
      vec3 sgn = sign(n0 + vec3(1e-4));
      float fr = max(length(fwidth(wp)), 1e-3);
      int oct = uDetail > 1.5 ? 3 : 2;
      vec3 hX = vec3(0.0), hZ = vec3(0.0), hY = vec3(0.0); // per projection: height, d/du, d/dv
      float tX = 0.0, tZ = 0.0, tY = 0.0;
      if (bw.x > 0.02) { hX = rockRelief(vec2(wp.z, wp.y*0.75), fr, oct, tX); hX.z *= 0.75; }
      if (bw.z > 0.02) { hZ = rockRelief(vec2(wp.x, wp.y*0.75) + 31.7, fr, oct, tZ); hZ.z *= 0.75; }
      if (bw.y > 0.02) hY = rockRelief(wp.xz + 63.1, fr, oct, tY);
      vec3 dX = vec3(0.0, hX.z, hX.y)*sgn.x, dZ = vec3(hZ.y, hZ.z, 0.0)*sgn.z, dY = vec3(hY.y, 0.0, hY.z)*sgn.y;
      n = normalize(n - (dX*bw.x + dZ*bw.z + dY*bw.y)*rk*(1.0 - sn*0.85)); // snow buries the relief
      float relief = clamp((hX.x*bw.x + hZ.x*bw.z + hY.x*bw.y)/5.0, 0.0, 1.0); // joints and hollows 0 … proud blocks 1
      float tone = tX*bw.x + tZ*bw.z + tY*bw.y;
      // colour: weathered patches, cooler outcrops, each fragment its own shade, lichen on the upper sides; bedding in
      // sandstone
      rock *= mix(0.84, 1.08, vn(wp.xz/60.0 + wp.y/90.0 + vec2(6.1, 2.8)));
      rock = mix(rock, rock*vec3(0.86, 0.9, 0.95), smoothstep(0.5, 0.8, vn(wp.xz/140.0 + vec2(6.1, 2.8))));
      rock *= 0.94 + 0.1*relief + tone*0.1;
      float lich = smoothstep(0.62, 0.8, vn(vec2(wp.x + wp.y*0.7, wp.z - wp.y*0.6)/2.3 + vec2(9.1, 1.7)))*(1.0 - smoothstep(0.4, 1.2, fr))*(0.35 + 0.65*max(n0.y, 0.0));
      rock = mix(rock, mix(vec3(0.62,0.62,0.45), vec3(0.78,0.56,0.32), vVar), lich*0.45*(1.0 - vDry));
      // sandstone bedding: beds of uneven thickness (noise along the height, gently warped), in thicker packages
      float by = wp.y + (vn(wp.xz/180.0 + vec2(2.3, 9.1)) - 0.5)*14.0;
      float bed = vn(vec2(by/3.2, 0.5)) - 0.5 + (vn(vec2(by/1.1, 7.5)) - 0.5)*0.5*(1.0 - smoothstep(0.3, 1.0, fr));
      float big = vn(vec2(by/19.0, 3.5)) - 0.5;
      rock *= 1.0 + vDry*(bed*0.22*(1.0 - smoothstep(0.8, 2.5, fr)) + big*0.35*(1.0 - smoothstep(6.0, 20.0, fr)));
      col = mix(col, rock, rk*(1.0 - sn)*step(0.0, vH));
      cav += (relief - 0.5)*rk*0.6;
    }
    // colour: grass clumps and sun-dried patches in meadows, darker mossy hollows in forests, lichen and cracks on rock
    // clumps and stones: two value noises on rotated lattices (one alone shows its square grid, stretched on slopes)
    vec2 cq = wp.xz/2.6;
    float clump = ((vn(cq) + vn(mat2(0.8, -0.6, 0.6, 0.8)*cq*1.37 + vec2(5.2, 1.3)))*0.5 - 0.5)*(1.0 - smoothstep(0.25, 0.9, fp));
    float dry = smoothstep(0.55, 0.8, vn(wp.xz/38.0 + vec2(4.1, 2.2)))*grass*(1.0 - vForest);
    col = mix(col, col*vec3(1.25, 1.08, 0.72), dry*0.45);
    col *= 1.0 + clump*(0.3*grass + 0.6*scree*(1.0 - sn)); // grass clumps; stones in the scree
    col *= 1.0 + cav*mix(0.18, 0.5, rk);
  }
  if (mats) col = albL;                    // linear already; the multiplicative touches below work the same on it
  // wind over the meadows: gust patches (cat's-paws) travelling downwind. Grass leaning in a gust shows its paler,
  // glossier flanks (most with the wind at your back) and lulls sit a shade darker; close up, quick streaky ripples run
  // through the gusts. The same field, with the same inertia, sways the plants (gustMap() in core.js).
  float lawn = grass + vForest*(1.0 - rk)*(1.0 - sn)*0.35;
  if (lawn > 0.01) {
    vec4 gm = gustMap(wp.xz);
    float away = dot(normalize(gm.zw + vec2(1e-5, 0.0)), vRel.xz)/max(length(vRel.xz), 1.0);
    float rw = (1.0 - smoothstep(0.5, 2.0, fp))*(1.0 - smoothstep(80.0, 260.0, dist))*grass*gm.y;
    float sheen = (gm.x - 0.1)*lawn;
    if (rw > 0.004) {
      vec2 q = vec2(dot(wp.xz, GUST_DIR), dot(wp.xz, vec2(-GUST_DIR.y, GUST_DIR.x)));
      sheen += (vn(vec2((q.x - 10.5*uTime)*(1.0/3.2), q.y*(1.0/8.5)) + vec2(2.7, 6.1)) - 0.5)*rw*0.9;
    }
    float graze = 1.0 - abs(vRel.y)/max(dist, 1.0); // blades are seen side-on at grazing angles
    col *= 1.0 + sheen*vec3(0.46, 0.42, 0.2)*(1.0 + 0.35*away)*(0.6 + 0.4*graze);
  }
  // fine mottling of the turf (smooth, and gone before it's smaller than a pixel or stretched down a slope)
  if (!mats) col *= 1.0 + (vn(wp.xz*1.3 + vec2(2.9, 6.3)) - 0.5)*0.16*grass*(1.0 - smoothstep(0.25, 0.8, fp))*(1.0 - smoothstep(0.12, 0.3, slope));
  // grass pressed by the glider's passage
  if (uGAgl < 30.0) {
    vec2 d = wp.xz - uG.xz;
    vec2 vd = normalize(uGV.xz + vec2(1e-4));
    float along = -dot(d, vd), across = abs(dot(d, vec2(-vd.y, vd.x)));
    float w = (1.0 - uGAgl/30.0);
    float trail = smoothstep(2.5 + along*0.3, 0.0, across)*smoothstep(-4.0, 2.0, along)*exp(-max(along,0.0)/35.0);
    float ring = exp(-dot(d,d)/(30.0 + uGAgl*6.0));
    col *= 1.0 + w*grass*(trail*(0.2 + 0.12*sin(along*0.7 - uTime*9.0)) + ring*0.22);
  }
  // scene-linear lighting: sun (grass blades scatter a little light past the terminator), sky dome, sunlit-ground bounce
  if (!mats) col = toLin(col);
  float gw = grass*0.15;
  float diff = clamp((dot(n, uSun) + gw)/(1.0 + gw), 0.0, 1.0);
  float casc;
  float sh = sunShadowC(vRel, n, casc); // cascades × cloud shadows
  float sunVis = sh*(1.0 - gliderShadow(wp)*0.85*step(1.5, casc));
  vec3 ground = (uSunCol*max(uSun.y, 0.0) + uAmb)*col*0.5;
  vec3 amb = mix(ground, uAmb, n.y*0.5 + 0.5);
  float F = 0.02 + 0.98*pow(1.0 - max(dot(-normalize(vRel), n), 0.0), 5.0);
  float occ = clamp(1.0 + cav*0.6, 0.55, 1.0); // hollows see less sky
  vec3 lit = col*(uSunCol*diff*sunVis + amb*occ) + skyCol(reflect(normalize(vRel), n))*F*(0.12 + 0.5*sn)*occ;
  o = vec4(fogIt(lit, vRel), 1.0);
}`;
  const TP = program(TVS, TFS);
  const TPS = program(TVS, GLSL_COMMON + `out vec4 o; void main(){ o = vec4(0.0); }`); // depth only (shadow maps)

  // ── photoscanned ground (assets/materials, built by assets/materials.py): two texture arrays fetched after start —
  // until they're in, the procedural shading stands in. Only on the island (the blend needs its maps) ──
  const MAT_IDS = ['aerial_rocks_02', 'aerial_rocks_04', 'rocky_terrain_02', 'aerial_grass_rock', 'aerial_ground_rock',
    'coast_sand_rocks_02', 'aerial_beach_01', 'snow_field_aerial', 'rock_face_03', 'rock_06', 'sandstone_cracks',
    'rocks_ground_02', 'gravelly_sand', 'leafy_grass', 'forest_leaves_02', 'brown_mud_dry', 'red_laterite_soil_stones',
    'snow_02']; // the order of the L_* layer constants in TFS
  const UNIT_MC = 2, UNIT_MN = 3, mat = { c: null, n: null, ready: false, on: true };
  (async () => {
    if (typeof window === 'undefined' || !window.ISLAND_DATA) return;
    try {
      const meta = await (await fetch('assets/materials/materials.json')).json();
      if (meta.layers.map(l => l.id).join() !== MAT_IDS.join()) throw new Error('the layer list changed');
      const S = meta.size, levels = Math.log2(S) + 1;
      const load = f => fetch('assets/materials/' + f).then(r => { if (!r.ok) throw new Error(f + ': ' + r.status); return r.blob(); })
        .then(b => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
      const imgs = await Promise.all(MAT_IDS.flatMap(id => [load(id + '_c.webp'), load(id + '_n.webp')]));
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      const make = (fmt, k) => {
        const t = gl.createTexture(), T = gl.TEXTURE_2D_ARRAY;
        gl.bindTexture(T, t);
        gl.texStorage3D(T, levels, fmt, S, S, MAT_IDS.length);
        for (let i = 0; i < MAT_IDS.length; i++) gl.texSubImage3D(T, 0, 0, 0, i, S, S, 1, gl.RGBA, gl.UNSIGNED_BYTE, imgs[i * 2 + k]);
        gl.generateMipmap(T);
        for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(T, p, v);
        if (aniso) gl.texParameterf(T, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
        return t;
      };
      gl.activeTexture(gl.TEXTURE0 + UNIT_MC); mat.c = make(gl.SRGB8_ALPHA8, 0);
      gl.activeTexture(gl.TEXTURE0 + UNIT_MN); mat.n = make(gl.RGBA8, 1);
      gl.activeTexture(gl.TEXTURE0);
      imgs.forEach(b => b.close());
      mat.ready = true;
      console.log('ground materials:', MAT_IDS.length, 'layers');
    } catch (e) { console.warn('ground materials unavailable, the procedural shading stays:', e); }
  })();

  // ── tile cache: each CDLOD node's 33×33 heights (plus a 1-texel border for normals) evaluated once into an atlas ──
  const SLOT = 35, ATLAS = 2048, PER = Math.floor(ATLAS / SLOT), NSLOT = PER * PER, UNIT_HC = 6;
  const hcTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, hcTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, ATLAS, ATLAS);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const hmTex = gl.createTexture(), UNIT_HM = 5; // landform: enclosure (own, parent scale), dry country
  gl.bindTexture(gl.TEXTURE_2D, hmTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const hcFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, hcFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hcTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, hmTex, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const GEN = program(`layout(location=0) in vec2 aC; layout(location=1) in vec4 aNode; layout(location=2) in vec2 aSlot;
uniform float uAtlas; flat out vec4 vNode; flat out vec2 vSlot;
void main(){ vNode = aNode; vSlot = aSlot; gl_Position = vec4((aSlot + aC*${SLOT}.0)/uAtlas*2.0 - 1.0, 0.0, 1.0); }`,
  GLSL_COMMON + `flat in vec4 vNode; flat in vec2 vSlot;
uniform int uGenN; // 12; a uniform, so the compiler keeps the loop below instead of inlining terrainH() twelve times
layout(location=0) out vec4 o; layout(location=1) out vec4 o2;
// the dry country: the canyon and mesa regions of terrainH() and a margin around them, fading out in the high mountains
float dryCountry(vec2 q){
  if (uHeightP.w > 0.5) { vec4 r = islandRegions(q); return clamp(r.b + 0.35*r.g, 0.0, 1.0); }   // the island: its plateau and Mediterranean south
  vec2 p = q + vec2(vn(q*0.00035 + vec2(3.1,1.7)) - 0.5, vn(q*0.00035 + vec2(8.3,4.9)) - 0.5)*1100.0;
  float c = (0.5*vn(p*0.00015+vec2(0.5)) + 0.25*vn(p*0.0003+vec2(2.1,7.3)) + 0.125*vn(p*0.0006+vec2(4.4,1.9))) / 0.875;
  float rA = vn(p*0.00009 + vec2(13.1, 4.2)), rB = vn(p*0.00011 + vec2(2.9, 17.7));
  return max(smoothstep(0.57, 0.67, rA), smoothstep(0.59, 0.71, rB))*(1.0 - 0.8*smoothstep(0.46, 0.74, c));
}
void main(){
  vec2 t = floor(gl_FragCoord.xy - vSlot) - 1.0;          // grid index, -1…33 including the border
  float cell = vNode.z/32.0;
  vec2 wp = vNode.xy + t*cell;
  // heights filtered for this LOD's grid and for the parent's (octaves too fine for the spacing would only alias), and
  // the enclosure at both scales: how far the ground d metres around rises above this spot, per metre (> 0 hollows and
  // gullies, < 0 ridges and knolls), with the terrain smoothed to that scale
  float dA = max(30.0, cell*2.0), dB = max(30.0, cell*4.0);
  float h0 = 0.0, h1 = 0.0, cA = 0.0, sA = 0.0, cB = 0.0, sB = 0.0;
  for (int k = 0; k < uGenN; k++) {
    int j = k < 2 ? -1 : (k < 7 ? k - 2 : k - 7);    // -1 the grid height; 0 the centre, 1–4 the neighbours
    float d = k < 7 ? dA : dB;
    vec2 off = j == 1 ? vec2(d, 0.0) : j == 2 ? vec2(-d, 0.0) : j == 3 ? vec2(0.0, d) : j == 4 ? vec2(0.0, -d) : vec2(0.0);
    float h = terrainH(wp + off, k == 0 ? cell*2.0 : k == 1 ? cell*4.0 : d*1.5);
    if (k == 0) h0 = h; else if (k == 1) h1 = h; else if (k == 2) cA = h; else if (k < 7) sA += h; else if (k == 7) cB = h; else sB += h;
  }
  o = vec4(h0, h1, 0.0, 1.0);
  float eA = clamp((sA*0.25 - cA)/dA, -1.0, 1.0), eB = clamp((sB*0.25 - cB)/dB, -1.0, 1.0);
  o2 = vec4(eA*0.5 + 0.5, eB*0.5 + 0.5, dryCountry(wp), 1.0);
}`);
  const genBuf = new Float32Array(MAXI * 6);
  const genVao = gl.createVertexArray();
  gl.bindVertexArray(genVao);
  attribs(buffer(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  const genIbuf = buffer(genBuf, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
  attribs(genIbuf, [[1, 4, 6, 0, 1], [2, 2, 6, 4, 1]]);
  gl.bindVertexArray(null);
  const slotOf = new Map(), slotKey = new Float64Array(NSLOT).fill(-1), slotFrame = new Int32Array(NSLOT).fill(-1), freeSlots = [];
  for (let i = NSLOT - 1; i >= 0; i--) freeSlots.push(i);
  let frameNo = 0, genN = 0;
  function evictSlot() { // least recently used, never one already claimed this frame
    let best = -1, bf = 0x7fffffff;
    for (let i = 0; i < NSLOT; i++) if (slotFrame[i] < bf && slotFrame[i] !== frameNo) { bf = slotFrame[i]; best = i; }
    slotOf.delete(slotKey[best]);
    return best;
  }
  function slotFor(x, z, s, L) {
    const key = (L * 65536 + (Math.round(x / s) + 32768)) * 65536 + (Math.round(z / s) + 32768);
    let sl = slotOf.get(key);
    if (sl === undefined) {
      sl = freeSlots.length ? freeSlots.pop() : evictSlot();
      slotOf.set(key, sl); slotKey[sl] = key;
      const o = genN++ * 6;
      genBuf[o] = x; genBuf[o + 1] = z; genBuf[o + 2] = s; genBuf[o + 3] = L;
      genBuf[o + 4] = (sl % PER) * SLOT; genBuf[o + 5] = Math.floor(sl / PER) * SLOT;
    }
    slotFrame[sl] = frameNo;
    return sl;
  }
  const GEN_CAPS = [gl.DEPTH_TEST, gl.CULL_FACE, gl.BLEND, gl.POLYGON_OFFSET_FILL];
  // evaluate the queued tiles (one instanced draw), leaving every piece of GL state as it was
  function generate() {
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT), cm = gl.getParameter(gl.COLOR_WRITEMASK);
    const prog = gl.getParameter(gl.CURRENT_PROGRAM);
    const st = GEN_CAPS.map(c => gl.isEnabled(c));
    gl.bindFramebuffer(gl.FRAMEBUFFER, hcFbo); gl.viewport(0, 0, ATLAS, ATLAS);
    gl.colorMask(true, true, true, true);
    for (const c of GEN_CAPS) gl.disable(c);
    gl.useProgram(GEN.p); setEnv(GEN); gl.uniform1f(GEN.u.uAtlas, ATLAS); gl.uniform1i(GEN.u.uGenN, 12);
    gl.bindVertexArray(genVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, genIbuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, genBuf, 0, genN * 6);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, genN);
    stats.generated += genN; genN = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.colorMask(cm[0], cm[1], cm[2], cm[3]);
    GEN_CAPS.forEach((c, i) => (st[i] ? gl.enable(c) : gl.disable(c)));
    gl.useProgram(prog);
  }

  // ── water: one huge camera-centred quad at y=0 ──
  const WVS = GLSL_COMMON + `
layout(location=0) in vec2 aP;
uniform mat4 uVP;
out vec3 vRel;
void main(){ vRel = vec3(aP.x*30000.0, -uCam.y, aP.y*30000.0); gl_Position = uVP*vec4(vRel, 1.0); }`;
  const WFS = GLSL_COMMON + `
in vec3 vRel; uniform vec3 uG, uGV; uniform float uGAgl;
uniform sampler2D uDepth; uniform vec4 uDepthP; // (has depth, near, far, -)
uniform vec3 uCamF; uniform float uWaterQ;      // camera forward; wave detail 0 low, 1 medium, 2 high
out vec4 o;
const float PI = 3.14159265;
// eight wind-driven waves (deep-water dispersion: ω = √(g k)) + two ripple octaves; returns the surface slope (∂h/∂x, ∂h/∂z)
// and, in rough, the slope variance of the detail too fine for this pixel (it turns into micro-roughness instead of aliasing)
vec2 waves(vec2 p, float fp, float gust, vec2 wdir, out float rough){
  vec2 s = vec2(0.0); rough = 0.0;
  float amp = 0.35 + 1.5*gust;               // choppier in gusts: the cat's-paws
  for (int i = 0; i < 8; i++){
    float fi = float(i);
    float lam = 9.0*pow(0.62, fi);                              // 9 m … 0.32 m
    float ang = (fract(fi*0.618 + 0.13) - 0.5)*1.4;             // spread around the wind
    vec2 d = vec2(wdir.x*cos(ang) - wdir.y*sin(ang), wdir.x*sin(ang) + wdir.y*cos(ang));
    float k = 2.0*PI/lam, w = sqrt(9.81*k);
    float st = 0.045*amp*(1.0 - 0.35*fi/8.0);                   // steepness A·k
    float filt = 1.0 - smoothstep(lam*0.12, lam*0.45, fp);
    s += d*st*cos(dot(d, p)*k - w*uTime + fi*1.7)*filt;
    rough += st*st*0.5*(1.0 - filt);
  }
  if (uWaterQ > 1.5) { // fine ripples riding on the waves
    for (int i = 0; i < 2; i++){
      float sc = i == 0 ? 0.9 : 0.35;
      vec2 q = p/sc + wdir*uTime*(1.2 - 0.4*float(i));
      vec2 g = vec2(vn(q + vec2(3.1, 7.7)) - vn(q + vec2(3.1 + 0.3, 7.7)), vn(q + vec2(5.3, 1.9)) - vn(q + vec2(5.3, 1.9 + 0.3)))*1.4;
      float filt = 1.0 - smoothstep(sc*0.15, sc*0.6, fp);
      s += g*0.06*amp*filt;
      rough += 0.0018*amp*amp*(1.0 - filt);
    }
  }
  return s;
}
void main(){
  vec3 wp = vRel + uCam; float dist = length(vRel); vec3 v = vRel/dist;
  vec2 p = wp.xz;
  float fp = max(length(fwidth(p)), 1e-3);
  vec3 wg = windGust(p);
  float rough;
  vec2 sl = waves(p, fp, wg.z, wg.xy, rough);
  vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
  float nv = max(dot(-v, n), 1e-3);
  float fres = 0.02 + 0.98*pow(1.0 - nv, 5.0);
  vec3 rd = reflect(v, n); rd.y = abs(rd.y);
  float sh = sunShadow(vRel, vec3(0.0, 1.0, 0.0));
  // water depth along the view ray (from the terrain already in the depth buffer) → absorption and shore foam
  float thick = 60.0;
  if (uDepthP.x > 0.5) {
    float z = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r*2.0 - 1.0;
    float n_ = uDepthP.y, f_ = uDepthP.z;
    float vz = 2.0*n_*f_/(f_ + n_ - z*(f_ - n_));              // view-space depth of the bottom
    float bottom = vz*dist/max(dot(vRel, uCamF), 1e-3);         // … as a distance along this ray
    thick = max(bottom - dist, 0.0);
  }
  float vdepth = thick*nv;                                       // ≈ vertical depth
  vec3 Tw = exp(-thick*vec3(0.45, 0.09, 0.06));                  // red goes first: shallows turquoise, deep blue-green
  // light scattered up out of the water body (sun + sky, dimmed in shadow)
  vec3 light = uSunCol*max(uSun.y, 0.0)*(0.25 + 0.75*sh) + uAmb;
  vec3 body = toLin(vec3(0.04, 0.2, 0.24))*light*0.6;
  // GGX sun glint on a surface roughened by the filtered-out waves (a glitter path that widens with distance)
  float a2 = clamp(0.0025 + rough*2.0, 0.0025, 0.25);
  vec3 h = normalize(uSun - v);
  float nh = max(dot(n, h), 0.0), nl = max(dot(n, uSun), 0.0);
  float D = a2/(PI*pow(nh*nh*(a2 - 1.0) + 1.0, 2.0));
  float Fh = 0.02 + 0.98*pow(1.0 - max(dot(h, uSun), 0.0), 5.0);
  vec3 glint = min(uSunCol*PI*D*Fh*0.25*nl/nv, vec3(120.0))*sh;
  vec3 refl = skyCol(rd)*mix(1.0, 0.8, clamp(rough*40.0, 0.0, 1.0));
  // shore foam: a lapping band where the water thins out, broken up and pulsing with the waves
  float foamN = vn(p*0.7 + wg.xy*uTime*0.6)*0.6 + vn(p*2.3 - uTime*0.3)*0.4;
  float swash = 0.28 + 0.2*sin(uTime*0.9 + dot(p, wg.xy)*0.25);   // the waterline laps in and out
  // the depth buffer's precision (and the terrain's distance LOD) blur the waterline with range: widen the band by that
  // error and fade the foam out before it becomes a per-frame coin toss
  float zerr = dist*dist/(uDepthP.y*16777216.0)*3.0;
  float shore = uDepthP.x > 0.5 ? (1.0 - smoothstep(0.02, swash + zerr, vdepth))*smoothstep(0.3, 0.65, foamN)*(1.0 - smoothstep(300.0, 700.0, dist)) : 0.0;
  float foam = shore*0.85;
  if (uGAgl < 12.0) { // wake where the glider skims the water
    vec2 d = p - uG.xz; vec2 vd = normalize(uGV.xz + vec2(1e-4));
    float along = -dot(d, vd), across = abs(dot(d, vec2(-vd.y, vd.x)));
    float wk = smoothstep(1.2 + along*0.18, 0.0, across)*smoothstep(-2.0, 1.0, along)*exp(-max(along, 0.0)/45.0)*(1.0 - uGAgl/12.0);
    foam = max(foam, wk*(0.75 + 0.25*sin(along*0.9 - uTime*3.0)));
  }
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamC = vec3(0.8, 0.84, 0.86)*light*1.1;
  // blend over the bottom already drawn: dst·T + src  (T = light that comes back up through the water, unreflected)
  float Tm = dot(Tw, vec3(0.2126, 0.7152, 0.0722));
  vec3 src = body*(1.0 - Tw)*(1.0 - fres) + refl*fres + glint;
  float T = Tm*(1.0 - fres);
  if (uDepthP.x < 0.5) { T *= 0.35; src += body*0.65*(1.0 - fres); } // no depth (Low): mostly opaque
  src = mix(src, foamC, foam); T *= 1.0 - foam;
  // aerial perspective: fogIt on the surface colour; the bottom seen through it was already fogged at its own depth
  vec4 ap = aerial(dist);
  o = vec4(src*ap.a + ap.rgb*(1.0 - T), T);
}`;
  const WP = program(WVS, WFS);
  const wvao = gl.createVertexArray();
  gl.bindVertexArray(wvao);
  attribs(buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])), [[0, 2, 2, 0, 0]]);
  gl.bindVertexArray(null);

  // ── sky ──
  const SVS = `out vec2 vP; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vP = p*2.0-1.0; gl_Position = vec4(vP, 1.0, 1.0); }`;
  const SFS = GLSL_COMMON + `
in vec2 vP; uniform vec3 uCR, uCU, uCF; uniform vec2 uTan; out vec4 o;
void main(){
  vec3 d = normalize(uCF + uCR*vP.x*uTan.x + uCU*vP.y*uTan.y);
  vec3 col = skyCol(d);
  float s = dot(d, uSun);
  // sun disc (a little larger than life), limb-darkened; bright enough to bloom
  float th2 = max(1.0 - s, 0.0)*2.0/(0.0078*0.0078);
  if (th2 < 1.2) {
    float limb = sqrt(max(1.0 - min(th2, 1.0), 0.0));
    col += uSunCol*60.0*(0.4 + 0.6*limb)*(1.0 - smoothstep(0.85, 1.15, th2))*smoothstep(-0.01, 0.01, d.y);
  }
  if (d.y > 0.0) {
    // high cirrus: sunlit ice, strongly forward scattering
    vec2 p = d.xz/(d.y + 0.08)*0.9 + uTime*vec2(0.0015, 0.0006);
    float c = vn(p*vec2(1.2, 5.0)) *0.65 + vn(p*vec2(3.1, 11.0))*0.35;
    float a = smoothstep(0.55, 0.95, c)*0.45*smoothstep(0.02, 0.3, d.y)*(1.0 - smoothstep(0.5, 0.9, d.y));
    vec3 ci = uSunCol*(0.55 + 2.5*pow(max(s, 0.0), 12.0)) + uZen*0.6;
    col = mix(col, ci, a);
  }
  o = vec4(col, 1.0);
}`;
  const SP = program(SVS, SFS);
  const svao = gl.createVertexArray();

  // ── selection ──
  const planes = new Float64Array(24);
  function setFrustum(m) {
    for (let p = 0; p < 6; p++) {
      const row = p >> 1, sgn = (p & 1) ? -1 : 1;
      planes[p * 4] = m[3] + sgn * m[row];
      planes[p * 4 + 1] = m[7] + sgn * m[4 + row];
      planes[p * 4 + 2] = m[11] + sgn * m[8 + row];
      planes[p * 4 + 3] = m[15] + sgn * m[12 + row];
    }
  }
  let cx = 0, cy = 0, cz = 0;
  function visible(x, z, s) {
    const x0 = x - cx, x1 = x0 + s, z0 = z - cz, z1 = z0 + s, y0 = MINH - cy, y1 = MAXH - cy;
    for (let p = 0; p < 6; p++) {
      const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
      if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
    }
    return true;
  }
  let lodScale = 1;
  function boxDist(x, z, s) {
    const dx = Math.max(x - cx, 0, cx - x - s), dz = Math.max(z - cz, 0, cz - z - s);
    const dy = cy > MAXH ? cy - MAXH : 0;
    return Math.sqrt(dx * dx + dz * dz + dy * dy) * lodScale;
  }
  let count = 0;
  function add(list, x, z, s, L) { if (count < MAXI) { list.push(x, z, s, L); count++; } }
  function select(x, z, s, L) {
    const d = boxDist(x, z, s);
    if (d > RANGE[L]) return false;
    if (!visible(x, z, s)) return true;
    if (L === 0 || d > RANGE[L - 1]) { add(lists[0], x, z, s, L); return true; }
    const h = s / 2;
    for (let q = 0; q < 4; q++) {
      const qx = x + (q & 1) * h, qz = z + (q >> 1) * h;
      if (!select(qx, qz, h, L - 1)) add(lists[q + 1], x, z, s, L);
    }
    return true;
  }

  const stats = { nodes: 0, shadowNodes: 0, generated: 0 };
  let viewLod = 1; // quality preset: > 1 coarsens the terrain everywhere (view and shadows alike)
  let detail = 2;  // per-pixel surface detail octaves: 0 none, 1 two, 2 three
  // CDLOD selection against env.vp's frustum (the camera's, or a shadow cascade's); lod > 1 coarsens
  function selectAll(cam, lod) {
    cx = cam.pos[0]; cy = cam.pos[1]; cz = cam.pos[2]; lodScale = lod * viewLod;
    setFrustum(env.vp);
    for (const l of lists) l.length = 0;
    count = 0;
    const RS = LEAF * Math.pow(2, LEVELS - 1);
    const rx = Math.floor(cx / RS), rz = Math.floor(cz / RS);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const x = (rx + i) * RS, z = (rz + j) * RS;
      if (!select(x, z, RS, LEVELS - 1) && visible(x, z, RS)) add(lists[0], x, z, RS, LEVELS - 1);
    }
    lodScale = 1;
    return count;
  }
  // draw the selected nodes with the current program (TP or TPS); rangeK must match the selection's lod scale
  function drawNodes(p, rangeK) {
    let n8 = 0;
    for (let s = 0; s < 5; s++) {
      const l = lists[s];
      for (let i = 0; i < l.length; i += 4) {
        const sl = slotFor(l[i], l[i + 1], l[i + 2], l[i + 3]);
        inst[n8] = l[i]; inst[n8 + 1] = l[i + 1]; inst[n8 + 2] = l[i + 2]; inst[n8 + 3] = l[i + 3];
        inst[n8 + 4] = (sl % PER) * SLOT; inst[n8 + 5] = Math.floor(sl / PER) * SLOT;
        n8 += 8;
      }
    }
    if (genN) generate();
    gl.activeTexture(gl.TEXTURE0 + UNIT_HC); gl.bindTexture(gl.TEXTURE_2D, hcTex);
    gl.activeTexture(gl.TEXTURE0 + UNIT_HM); gl.bindTexture(gl.TEXTURE_2D, hmTex); gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.uHC, UNIT_HC); gl.uniform1i(p.u.uHM, UNIT_HM); gl.uniform1f(p.u.uRangeK, rangeK);
    gl.bindVertexArray(tvao);
    const base = ring * MAXI; ring = (ring + 1) % RING;
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 32, inst, 0, n8);
    let off = base;
    for (let s = 0; s < 5; s++) {
      const n = lists[s].length / 4;
      if (n) {
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, off * 32);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, off * 32 + 16);
        if (s === 0) gl.drawElementsInstanced(gl.TRIANGLES, gi.length, gl.UNSIGNED_SHORT, 0, n);
        else gl.drawElementsInstanced(gl.TRIANGLES, QIDX, gl.UNSIGNED_SHORT, (s - 1) * QIDX * 2, n);
      }
      off += n;
    }
  }
  // depth into the bound shadow cascade (env.vp = the cascade's matrix)
  function drawShadow(cam, lod) {
    stats.shadowNodes += selectAll(cam, lod);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(TPS.p); setEnv(TPS);
    drawNodes(TPS, RK / (lod * viewLod));
    gl.disable(gl.CULL_FACE);
  }
  function beginFrame() { frameNo++; stats.generated = 0; stats.shadowNodes = 0; }
  function draw(g, cam) {
    stats.nodes = selectAll(cam, 1);

    // sky
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(SP.p); setEnv(SP);
    gl.uniform3fv(SP.u.uCR, cam.r); gl.uniform3fv(SP.u.uCU, cam.u); gl.uniform3fv(SP.u.uCF, cam.f);
    gl.uniform2f(SP.u.uTan, cam.tanX, cam.tanY);
    gl.bindVertexArray(svao); gl.drawArrays(gl.TRIANGLES, 0, 3);

    // terrain
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(TP.p); setEnv(TP);
    gl.uniform1f(TP.u.uDetail, detail);
    if (mat.ready) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_MC); gl.bindTexture(gl.TEXTURE_2D_ARRAY, mat.c);
      gl.activeTexture(gl.TEXTURE0 + UNIT_MN); gl.bindTexture(gl.TEXTURE_2D_ARRAY, mat.n); gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1i(TP.u.uMatC, UNIT_MC); gl.uniform1i(TP.u.uMatN, UNIT_MN); gl.uniform1f(TP.u.uMat, mat.ready && mat.on ? 1 : 0);
    gl.uniform3fv(TP.u.uG, g.pos); gl.uniform3fv(TP.u.uGR, g.r); gl.uniform3fv(TP.u.uGF, g.f);
    gl.uniform3fv(TP.u.uGV, g.vel); gl.uniform1f(TP.u.uGAgl, g.agl);
    drawNodes(TP, RK / viewLod);
    gl.disable(gl.CULL_FACE);
  }
  // depthTex: the resolved scene depth (terrain under the water) or null; nearFar: the camera projection's planes
  function drawWater(g, cam, depthTex, near, far) {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA); // bottom·T + surface
    gl.useProgram(WP.p); setEnv(WP);
    gl.uniform3fv(WP.u.uG, g.pos); gl.uniform3fv(WP.u.uGV, g.vel); gl.uniform1f(WP.u.uGAgl, g.pos[1]);
    gl.uniform3fv(WP.u.uCamF, cam.f); gl.uniform1f(WP.u.uWaterQ, detail);
    if (depthTex) { gl.activeTexture(gl.TEXTURE0 + 9); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(WP.u.uDepth, 9); }
    gl.uniform4f(WP.u.uDepthP, depthTex ? 1 : 0, near || 1, far || 26000, 0);
    gl.bindVertexArray(wvao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }
  return { draw, drawShadow, drawWater, beginFrame, stats, get cacheUsed() { return slotOf.size; }, get lod() { return viewLod; }, set lod(v) { viewLod = v || 1; },
    get detail() { return detail; }, set detail(v) { detail = v; },
    get materials() { return mat.ready && mat.on; }, set materials(v) { mat.on = !!v; } };
})();
