'use strict';
// ───────────────────────── Renderer: low-res scene → palette-dithered upscale ─────────────────────────
const GL = (() => {
  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const HEAD = '#version 300 es\nprecision highp float;\n';
  const NOISE = `
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y); }
float bayer(ivec2 p){ p=p&7; int x=p.x, y=p.y, xy=x^y;
  int v=((xy&1)<<5)|((y&1)<<4)|((xy&2)<<2)|((y&2)<<1)|((xy&4)>>1)|((y&4)>>2);
  return (float(v)+.5)/64.; }
float bayer4(ivec2 p){ p=p&3; int x=p.x, y=p.y, xy=x^y;
  int v=((xy&1)<<3)|((y&1)<<2)|((xy&2))|((y&2)>>1);
  return (float(v)+.5)/16.; }
`;

  // ── fullscreen triangle (no attributes) ──
  const FS_VS = HEAD + `out vec2 v_uv;
void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.-1.,0.,1.); }`;

  // ── background: nebula + parallax pixel stars, written to R ──
  const BG_FS = HEAD + NOISE + `
in vec2 v_uv; out vec4 o;
uniform vec2 u_res; uniform vec2 u_neb; uniform vec2 u_star; uniform float u_pix; uniform float u_time;
uniform float u_seed; uniform float u_nebAmt;
float fbm(vec2 p){ float v=0.,a=.5; for(int i=0;i<5;i++){ v+=a*vn(p); p=p*2.03+vec2(17.1,9.2); a*=.5; } return v; }
void main(){
  vec2 sp = vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  vec2 c = sp - u_res*.5;
  vec2 np = (c*u_pix*.55)*.0015 + u_neb + u_seed;
  vec2 q = vec2(fbm(np + vec2(u_time*.006,0.)), fbm(np + vec2(5.2,1.3)));
  float n = fbm(np + 1.9*q);
  float neb = smoothstep(.42,.98,n)*u_nebAmt;
  float dust = smoothstep(.55,.35,fbm(np*2.3 + q*1.2 + 8.))*neb;
  float r = neb*.40 - dust*.18;
  for(int L=0; L<3; L++){
    float fl = float(L);
    float par = .08 + fl*.14;
    float cs = 20. + fl*14.;
    vec2 s2 = c + mod(u_star*par, cs*4096.);
    vec2 cell = floor(s2/cs);
    float pres = step(.52 - fl*.1, h21(cell*3.1 + 7.7 + fl));
    vec2 rnd = vec2(h21(cell + fl*31.7 + u_seed), h21(cell*1.7 + fl*11.3 + u_seed));
    vec2 spos = floor((cell + .15 + rnd*.7)*cs);
    vec2 d = abs(floor(s2) - spos);
    float tw = .55 + .45*sin(u_time*(1.2 + rnd.x*3.) + rnd.y*40.);
    float st = (d.x<.5 && d.y<.5) ? 1. : 0.;
    if (L==2 && rnd.x>.78) st = max(st, (d.x+d.y<1.5) ? .5 : 0.);
    r += st*pres*(.3 + .28*fl)*tw;
  }
  o = vec4(max(r,0.), 0., 0., 1.);
}`;

  // ── instanced sprites (SDF shapes, glyphs, planets) ──
  const SPR_VS = HEAD + `
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 i_ps; layout(location=2) in vec4 i_rs;
layout(location=3) in vec4 i_col; layout(location=4) in vec4 i_p;
uniform vec4 u_proj;
out vec2 v_l; flat out vec2 v_h; flat out vec4 v_rs; flat out vec4 v_col; flat out vec4 v_p;
void main(){
  vec2 c = a_c*i_ps.zw; float s=sin(i_rs.x), co=cos(i_rs.x);
  vec2 w = i_ps.xy + vec2(c.x*co - c.y*s, c.x*s + c.y*co);
  gl_Position = vec4(w*u_proj.xy + u_proj.zw, 0., 1.);
  v_l=c; v_h=i_ps.zw; v_rs=i_rs; v_col=i_col; v_p=i_p;
}`;
  const SPR_FS = HEAD + NOISE + `
in vec2 v_l; flat in vec2 v_h; flat in vec4 v_rs; flat in vec4 v_col; flat in vec4 v_p;
uniform float u_pix; uniform float u_time; uniform vec3 u_light; uniform sampler2D u_font;
out vec4 o;
float fbm(vec2 p){ float v=0.,a=.5; for(int i=0;i<4;i++){ v+=a*vn(p); p=p*2.07+vec2(3.1,7.7); a*=.5; } return v; }
float crater(vec2 p){ vec2 i=floor(p), f=fract(p); float m=1.;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec2 g=vec2(x,y);
    vec2 of=vec2(h21(i+g), h21(i+g+13.1)); float r=.22+.22*h21(i+g+7.7);
    float d=length(g+of-f)/r; if(d<1.) m=min(m,d); }
  return m; }
void main(){
  int sh = int(v_rs.y+.5);
  vec3 c = vec3(0.); float oc = 0.;
  if (sh==0) {                       // soft dot
    float d = length(v_l);
    float core = clamp((v_p.x-d)/u_pix+.5, 0., 1.);
    float glow = v_p.y*pow(max(0.,1.-d/v_h.x), 2.);
    float m = max(core, glow)*v_col.a;
    c = v_col.rgb*m; oc = v_rs.w*core*v_col.a;
  } else if (sh==1) {                // ring
    float t = max(v_p.y, u_pix);
    float d = abs(length(v_l)-v_p.x) - t*.5;
    float m = clamp(-d/u_pix+.5, 0., 1.)*v_col.a;
    c = v_col.rgb*m; oc = v_rs.w*m;
  } else if (sh==2) {                // planet
    float R = v_h.x/1.25;
    vec2 q = v_l/R; float rr = length(q);
    float cov = clamp((1.-rr)*R/u_pix+.5, 0., 1.);
    float val=0., g=0., b=0.;
    if (rr < 1.05) {
      vec2 qq = q*min(1., .999/max(rr,1e-4));
      float z = sqrt(max(0., 1.-dot(qq,qq)));
      vec3 n = vec3(qq, z);
      float dif = dot(n, u_light);
      float lit = smoothstep(-.1, .8, dif);
      float lon = atan(n.x, n.z) + v_p.y;
      float lat = asin(clamp(n.y,-1.,1.));
      vec2 uv = vec2(lon, lat);
      int ty = int(v_p.x+.5);
      float sd = v_rs.z*17.3;
      float alb = .6;
      if (ty==0) {
        float w = fbm(uv*vec2(1.2,3.)+sd)*1.4;
        float band = sin(lat*(6.+fract(sd)*7.) + w*2.3 + sd);
        alb = .52 + .26*band + .12*fbm(uv*vec2(3.,9.)+sd);
        vec2 sp = vec2(mod(lon-sd, 6.2832)-3.1416, lat-(fract(sd*3.)-.5)*.8);
        alb = mix(alb, .95, smoothstep(.24,.12,length(sp*vec2(.6,1.7)))*.8);
      } else if (ty==1) {
        alb = .4 + .3*fbm(uv*2.2+sd);
        float cr = crater(uv*vec2(2.3,2.7)+sd);
        alb += (smoothstep(.72,1.,cr)*.3 - (1.-cr)*.24)*step(cr,.999);
      } else if (ty==2) {
        alb = .76 + .14*fbm(uv*vec2(2.,5.)+sd) + smoothstep(.55,.8,abs(n.y))*.2;
        b = .3*smoothstep(.52,.25,fbm(uv*3.+sd+4.))*lit;
      } else if (ty==3) {
        alb = .2 + .2*fbm(uv*2.6+sd);
        float cr = smoothstep(.045, .0, abs(fbm(uv*3.4+sd+9.)-.5));
        g = cr*(.62 + .22*sin(u_time*2.+sd*3.));
      } else {
        float land = fbm(uv*vec2(1.8,2.2)+sd);
        float isL = smoothstep(.47,.53,land);
        alb = mix(.2, .5+.25*fbm(uv*6.+sd), isL);
        b = (1.-isL)*.5*lit;
        float cl = smoothstep(.56,.76,fbm(uv*vec2(2.5,5.)+sd+vec2(u_time*.03,0.)));
        alb = mix(alb, .95, cl*.85); b *= 1.-cl;
        alb += smoothstep(.78,.92,abs(n.y))*.5;
      }
      float rim = pow(1.-z, 2.2);
      val = alb*lit*.95 + rim*.32*smoothstep(-.35,.45,dif) + rim*.06;
    }
    float halo = rr>1. ? pow(max(0.,1.-(rr-1.)/.25),2.)*.26*smoothstep(-.7,.6,dot(q/max(rr,1e-4), u_light.xy)+.25) : 0.;
    c = vec3(val*cov + halo*(1.-cov), g*cov, b*cov); oc = cov;
  } else if (sh==3) {                // planet ring (half)
    float t = max(v_p.z,.06);
    float d = length(vec2(v_l.x, v_l.y/t));
    float u = u_pix*1.2;
    float m = smoothstep(v_p.x-u, v_p.x+u, d)*(1.-smoothstep(v_p.y-u, v_p.y+u, d));
    float sel = v_p.w>.5 ? step(0., v_l.y) : step(v_l.y, 0.);
    float k = (d-v_p.x)/max(v_p.y-v_p.x,1.);
    float val = .5 + .22*sin(k*19.+v_rs.z*9.) + .14*sin(k*57.+v_rs.z*3.);
    val *= 1. - smoothstep(.02,.0,abs(k-.62))*.9;
    m *= sel;
    c = vec3(val*.8*m, 0., 0.); oc = m*.92;
  } else if (sh==4) {                // void tide
    float wy = v_l.y + v_p.y;
    float ex = v_p.x + (vn(vec2(wy*.008, u_time*.5))-.5)*110. + (vn(vec2(wy*.03, u_time*1.4))-.5)*36.;
    float dx = v_l.x - ex;
    float inside = clamp(-dx/u_pix+.5, 0., 1.);
    float fog = clamp(1.-dx/260., 0., 1.);
    float edge = exp(-abs(dx)/(1.6*u_pix));
    float stat = step(.94, h21(floor(v_l/u_pix) + floor(u_time*18.)))*inside*.3;
    c = vec3(stat, edge*.95, 0.); oc = max(inside, fog*fog*.8);
  } else if (sh==5) {                // glyph (dither-dissolve by alpha)
    vec2 l01 = v_l/v_h*.5+.5;
    vec2 uv = mix(v_p.xy, v_p.zw, l01);
    float a = step(.5, texture(u_font, uv).r);
    a *= step(bayer(ivec2(gl_FragCoord.xy)), v_col.a);
    float grad = mix(1., mix(1.15, .45, l01.y), v_rs.z);
    c = v_col.rgb*a*grad; oc = v_rs.w*a;
  } else if (sh==6) {                // pixel sparkle
    vec2 a = abs(v_l); float px = u_pix*.75;
    float s = ((a.x<px && a.y<v_p.x) || (a.y<px && a.x<v_p.x)) ? 1.-max(a.x,a.y)/v_p.x*.6 : 0.;
    c = v_col.rgb*s*v_col.a;
  } else if (sh==7) {                // corner brackets
    vec2 a = abs(v_l); float s = v_h.x-u_pix; float t = u_pix*.75;
    float e = ((abs(a.x-s)<t && a.y>s-v_p.x) || (abs(a.y-s)<t && a.x>s-v_p.x)) ? 1. : 0.;
    e *= step(a.x, s+t)*step(a.y, s+t);
    c = v_col.rgb*e*v_col.a;
  } else if (sh==8) {                // solid rect (HUD bars), dither-dissolve by alpha
    float a = step(bayer(ivec2(gl_FragCoord.xy)), v_col.a);
    c = v_col.rgb*a; oc = v_rs.w*a;
  }
  o = vec4(c, oc);
}`;

  // ── instanced capsule lines ──
  const LINE_VS = HEAD + `
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 i_ab; layout(location=2) in vec4 i_w; layout(location=3) in vec4 i_col;
uniform vec4 u_proj; uniform float u_pix;
out vec2 v_l; flat out float v_len; flat out vec4 v_w; flat out vec4 v_col;
void main(){
  vec2 a=i_ab.xy, b=i_ab.zw, d=b-a; float len=length(d);
  vec2 dir = len>1e-4 ? d/len : vec2(1.,0.); vec2 nr = vec2(-dir.y, dir.x);
  float hw = max(i_w.x*.5, u_pix*.5) + u_pix;
  float al = mix(-hw, len+hw, a_c.x);
  vec2 p = a + dir*al + nr*a_c.y*hw;
  gl_Position = vec4(p*u_proj.xy + u_proj.zw, 0., 1.);
  v_l = vec2(al, a_c.y*hw); v_len=len; v_w=i_w; v_col=i_col;
}`;
  const LINE_FS = HEAD + `
in vec2 v_l; flat in float v_len; flat in vec4 v_w; flat in vec4 v_col;
uniform float u_pix; out vec4 o;
void main(){
  float cx = clamp(v_l.x, 0., v_len);
  float d = length(vec2(v_l.x-cx, v_l.y));
  float hw = max(v_w.x*.5, u_pix*.5);
  float m = clamp((hw-d)/u_pix+.5, 0., 1.);
  if (v_w.y > 0.) m *= step(fract(v_l.x/v_w.y), .5);
  float a = mix(v_w.z, v_w.w, clamp(v_l.x/max(v_len,1e-4), 0., 1.));
  o = vec4(v_col.rgb*m*a, v_col.a*m*a);
}`;

  // ── final: palette quantize with ordered dither, integer upscale ──
  const FINAL_FS = HEAD + NOISE + `
out vec4 o;
uniform sampler2D u_scene; uniform vec2 u_ires; uniform float u_k; uniform vec2 u_off; uniform vec2 u_dith;
uniform vec3 u_base[6]; uniform vec3 u_accA[3]; uniform vec3 u_accB[3];
uniform float u_invert; uniform float u_vign; uniform float u_bright; uniform int u_b4;
void main(){
  vec2 fc = gl_FragCoord.xy - u_off;
  ivec2 lp = ivec2(floor(fc/u_k));
  ivec2 cl = clamp(lp, ivec2(0), ivec2(u_ires)-1);
  vec4 s = texelFetch(u_scene, cl, 0);
  ivec2 dp = lp + ivec2(u_dith);
  float t = u_b4==1 ? bayer4(dp) : bayer(dp);
  vec2 uc = (vec2(lp)+.5)/u_ires - .5;
  float vig = 1. - u_vign*dot(uc,uc)*1.5;
  float v = clamp(s.r*vig*u_bright, 0., 1.)*5.;
  vec3 col = u_base[clamp(int(floor(v+t)),0,5)];
  int bl = clamp(int(floor(clamp(s.b,0.,1.)*3.+t)), 0, 3);
  if (bl>0) col = u_accB[bl-1];
  int al = clamp(int(floor(clamp(s.g,0.,1.)*3.+t)), 0, 3);
  if (al>0) col = u_accA[al-1];
  if (u_invert>.5) col = u_base[5] + u_base[0] - col;
  o = vec4(col, 1.);
}`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  const P = {
    bg: program(FS_VS, BG_FS),
    spr: program(SPR_VS, SPR_FS),
    line: program(LINE_VS, LINE_FS),
    fin: program(FS_VS, FINAL_FS),
  };
  const emptyVao = gl.createVertexArray();

  // ── instance batches ──
  function batch(stride, max, attribs, corners) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.bufferData(gl.ARRAY_BUFFER, stride * 4 * max, gl.DYNAMIC_DRAW);
    let off = 0;
    attribs.forEach((size, i) => {
      gl.enableVertexAttribArray(i + 1);
      gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, stride * 4, off * 4);
      gl.vertexAttribDivisor(i + 1, 1);
      off += size;
    });
    gl.bindVertexArray(null);
    return { vao, ib, data: new Float32Array(stride * max), n: 0, stride, max };
  }
  const SQ = [-1, -1, 1, -1, -1, 1, 1, 1];
  const LN = [0, -1, 1, -1, 0, 1, 1, 1];
  const B = {
    bodies: batch(16, 2048, [4, 4, 4, 4], SQ),
    lines: batch(12, 48000, [4, 4, 4], LN),
    fx: batch(16, 8192, [4, 4, 4, 4], SQ),
    tide: batch(16, 8, [4, 4, 4, 4], SQ),
    fxTop: batch(16, 1024, [4, 4, 4, 4], SQ),
    hud: batch(16, 4096, [4, 4, 4, 4], SQ),
  };

  function spr(b, x, y, hw, hh, rot, shape, seed, occl, r, g, bl, a, p0, p1, p2, p3) {
    if (b.n >= b.max) return;
    const d = b.data, i = b.n++ * 16;
    d[i] = x; d[i + 1] = y; d[i + 2] = hw; d[i + 3] = hh;
    d[i + 4] = rot; d[i + 5] = shape; d[i + 6] = seed; d[i + 7] = occl;
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = bl; d[i + 11] = a;
    d[i + 12] = p0; d[i + 13] = p1; d[i + 14] = p2; d[i + 15] = p3;
  }
  function line(ax, ay, bx, by, w, dash, aA, aB, r, g, bl, occl) {
    const b = B.lines;
    if (b.n >= b.max) return;
    const d = b.data, i = b.n++ * 12;
    d[i] = ax; d[i + 1] = ay; d[i + 2] = bx; d[i + 3] = by;
    d[i + 4] = w; d[i + 5] = dash; d[i + 6] = aA; d[i + 7] = aB;
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = bl; d[i + 11] = occl;
  }

  // ── 5×7 bitmap font → R8 atlas ──
  const GLYPHS = {
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
    '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
    '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
    '9': [14, 17, 17, 15, 1, 2, 12], A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
    C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31],
    F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
    I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17],
    L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17],
    O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13],
    R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
    U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10],
    X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
    ' ': [0, 0, 0, 0, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '-': [0, 0, 0, 31, 0, 0, 0],
    'x': [0, 0, 17, 10, 4, 10, 17], '.': [0, 0, 0, 0, 0, 12, 12], ':': [0, 12, 12, 0, 12, 12, 0],
    '!': [4, 4, 4, 4, 4, 0, 4], '/': [1, 1, 2, 4, 8, 16, 16], '%': [24, 25, 2, 4, 8, 19, 3],
    '?': [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0], '<': [2, 4, 8, 16, 8, 4, 2],
    '>': [8, 4, 2, 1, 2, 4, 8], '*': [0, 4, 21, 14, 21, 4, 0], ',': [0, 0, 0, 0, 12, 4, 8],
  };
  const FW = 96, FH = 48;
  const glyphIndex = new Int16Array(128).fill(-1);
  const fontData = new Uint8Array(FW * FH);
  Object.keys(GLYPHS).forEach((ch, gi) => {
    glyphIndex[ch.charCodeAt(0)] = gi;
    const col = gi % 16, row = (gi / 16) | 0;
    GLYPHS[ch].forEach((bits, y) => {
      for (let x = 0; x < 5; x++) if (bits & (16 >> x)) fontData[(row * 8 + y) * FW + col * 6 + x] = 255;
    });
  });
  const fontTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fontTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FW, FH, 0, gl.RED, gl.UNSIGNED_BYTE, fontData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function textWidth(str, s) { return str.length ? (str.length * 6 - 1) * s : 0; }
  // draw text in HUD pixel space; align: 0 left, .5 center, 1 right. grad>0 = vertical gradient
  function text(str, x, y, s, r, g, bl, a, align, grad) {
    const w = textWidth(str, s);
    let cx = Math.round(x - w * (align || 0));
    const cy = Math.round(y);
    const hw = 2.5 * s, hh = 3.5 * s;
    for (let i = 0; i < str.length; i++) {
      const gi = glyphIndex[str.charCodeAt(i)];
      if (gi >= 0 && str.charCodeAt(i) !== 32) {
        const col = gi % 16, row = (gi / 16) | 0;
        spr(B.hud, cx + hw, cy + hh, hw, hh, 0, 5, grad || 0, 0, r, g, bl, a,
          col * 6 / FW, row * 8 / FH, (col * 6 + 5) / FW, (row * 8 + 7) / FH);
      }
      cx += 6 * s;
    }
    return w;
  }

  // ── render targets ──
  let cw = 1, ch = 1, K = 3, IW = 1, IH = 1, offX = 0, offY = 0;
  let sceneTex = null, sceneFbo = null;
  function resize(targetH, pw, ph) {
    cw = Math.max(1, pw | 0); ch = Math.max(1, ph | 0);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    K = Math.max(1, Math.round(ch / targetH));
    IW = Math.ceil(cw / K); IH = Math.ceil(ch / K);
    offX = Math.floor((cw - IW * K) / 2); offY = Math.floor((ch - IH * K) / 2);
    if (sceneTex) gl.deleteTexture(sceneTex);
    if (sceneFbo) gl.deleteFramebuffer(sceneFbo);
    sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, IW, IH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { IW, IH, K };
  }

  function drawSprites(b, proj, pix, time, light) {
    if (!b.n) return;
    const p = P.spr;
    gl.useProgram(p.p);
    gl.uniform4fv(p.u.u_proj, proj);
    gl.uniform1f(p.u.u_pix, pix);
    gl.uniform1f(p.u.u_time, time);
    gl.uniform3fv(p.u.u_light, light);
    gl.uniform1i(p.u.u_font, 0);
    gl.bindVertexArray(b.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.ib);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * b.stride);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    b.n = 0;
  }
  function drawLines(proj, pix) {
    const b = B.lines;
    if (!b.n) return;
    const p = P.line;
    gl.useProgram(p.p);
    gl.uniform4fv(p.u.u_proj, proj);
    gl.uniform1f(p.u.u_pix, pix);
    gl.bindVertexArray(b.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.ib);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * b.stride);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    b.n = 0;
  }

  const worldProj = new Float32Array(4), hudProj = new Float32Array(4);
  // f: frame params { pix, time, light, neb:[x,y], star:[x,y], seed, nebAmt, dith:[x,y], pal, invert, vign, bright, b4 }
  function render(f) {
    worldProj[0] = 2 / (f.pix * IW); worldProj[1] = -2 / (f.pix * IH); worldProj[2] = 0; worldProj[3] = 0;
    hudProj[0] = 2 / IW; hudProj[1] = -2 / IH; hudProj[2] = -1; hudProj[3] = 1;

    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.viewport(0, 0, IW, IH);
    gl.disable(gl.BLEND);
    let p = P.bg;
    gl.useProgram(p.p);
    gl.uniform2f(p.u.u_res, IW, IH);
    gl.uniform2f(p.u.u_neb, f.neb[0], f.neb[1]);
    gl.uniform2f(p.u.u_star, f.star[0], f.star[1]);
    gl.uniform1f(p.u.u_pix, f.pix);
    gl.uniform1f(p.u.u_time, f.time);
    gl.uniform1f(p.u.u_seed, f.seed);
    gl.uniform1f(p.u.u_nebAmt, f.nebAmt);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fontTex);
    drawSprites(B.bodies, worldProj, f.pix, f.time, f.light);
    drawLines(worldProj, f.pix);
    drawSprites(B.fx, worldProj, f.pix, f.time, f.light);
    drawSprites(B.tide, worldProj, f.pix, f.time, f.light);
    drawSprites(B.fxTop, worldProj, f.pix, f.time, f.light);
    drawSprites(B.hud, hudProj, 1, f.time, f.light);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);
    p = P.fin;
    gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(p.u.u_scene, 0);
    gl.uniform2f(p.u.u_ires, IW, IH);
    gl.uniform1f(p.u.u_k, K);
    gl.uniform2f(p.u.u_off, offX, offY);
    gl.uniform2f(p.u.u_dith, f.dith[0], f.dith[1]);
    gl.uniform3fv(p.u.u_base, f.pal.base);
    gl.uniform3fv(p.u.u_accA, f.pal.accA);
    gl.uniform3fv(p.u.u_accB, f.pal.accB);
    gl.uniform1f(p.u.u_invert, f.invert);
    gl.uniform1f(p.u.u_vign, f.vign);
    gl.uniform1f(p.u.u_bright, f.bright);
    gl.uniform1i(p.u.u_b4, f.b4);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    gl, canvas, B, spr, line, text, textWidth, resize, render,
    get IW() { return IW; }, get IH() { return IH; }, get K() { return K; },
  };
})();
