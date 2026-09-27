'use strict';
// ───────────────────────── Game: comet physics, tethers, scoring, tide, attract AI ─────────────────────────
const GAME = (() => {
  const W = WORLD;
  const CR = 5, GK = 380, VMIN = 250, VMAX = 880, WIND = 78;
  const reach = b => b.r * 2.1 + 92;
  const hyp = Math.hypot;

  const S = {
    mode: 'title', run: 'attract', t: 0, ts: 1, real: 0,
    c: { x: 0, y: 0, vx: 0, vy: 0, lat: null, docked: false, ang: 0, or: 0, orT: 0, dir: 1, vt: 0, holdT: 0, rescue: null },
    hold: false, mx: 0, my: 0, mwx: 0, mwy: 0, cssW: 1, cssH: 1, pulseReq: false,
    cam: { x: 0, y: 0, vh: 1150, shake: 0 },
    score: 0, chain: 0, mult: 1, hull: 3, charges: 3, chargeT: 0, dustBank: 0,
    dustStreak: 0, dustStreakT: 0, caught: 0, perfects: 0, maxChain: 0, maxX: 0, dustTotal: 0, hullProg: 0,
    tideX: -1e9, tideP: 0, lostT: 0, lostBeep: 0, invuln: 0, invert: 0,
    sector: 0, bannerT: 0, bannerA: '', bannerB: '',
    target: null, predTarget: null, pred: new Float32Array(256), predN: 0, predCrash: false, predCX: 0, predCY: 0,
    trail: new Float32Array(80), trailN: 0,
    path: new Float32Array(1 << 17), pathN: 0,
    visited: [], releasedFrom: null, relT: 9, skimId: -1,
    hint: '', hintStage: 0, overT: 0, pulseT: 9, pulseX: 0, pulseY: 0, aiAim: null, aiPulseT: 0,
    box: [0, 0, 0, 0], startT: 0, newBest: false,
  };
  const on = { over: null, sector: null, mult: null };

  // particles (ring buffer, SoA)
  const PN = 2048;
  const P = {
    x: new Float32Array(PN), y: new Float32Array(PN), vx: new Float32Array(PN), vy: new Float32Array(PN),
    l: new Float32Array(PN), m: new Float32Array(PN), s: new Float32Array(PN),
    r: new Float32Array(PN), g: new Float32Array(PN), b: new Float32Array(PN), d: new Float32Array(PN), head: 0,
  };
  function emit(x, y, vx, vy, life, size, r, g, b, drag) {
    const i = P.head; P.head = (P.head + 1) % PN;
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy; P.l[i] = life; P.m[i] = life; P.s[i] = size;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.d[i] = drag;
  }
  function burst(x, y, n, sp, life, r, g, b) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.2832, v = sp * (0.3 + Math.random() * 0.7);
      emit(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.5 + Math.random() * 0.5), 1 + (Math.random() < 0.3 ? 1 : 0), r, g, b, 2.2);
    }
  }
  // flying stardust
  const FN = 512;
  const F = { x: new Float32Array(FN), y: new Float32Array(FN), v: new Float32Array(FN), n: 0 };
  // popups
  const QN = 24;
  const Q = { str: new Array(QN).fill(''), x: new Float32Array(QN), y: new Float32Array(QN), l: new Float32Array(QN),
    m: new Float32Array(QN), ch: new Uint8Array(QN), s: new Uint8Array(QN), head: 0 };
  function popup(str, x, y, ch, s, life) {
    const i = Q.head; Q.head = (Q.head + 1) % QN;
    Q.str[i] = str; Q.x[i] = x; Q.y[i] = y; Q.l[i] = life || 1.3; Q.m[i] = life || 1.3; Q.ch[i] = ch; Q.s[i] = s || 1;
  }

  // ── setup ──
  function reset(run) {
    S.run = run; S.mode = run === 'attract' ? 'title' : 'play';
    W.reset((Math.random() * 2147483647) | 0);
    Object.assign(S, {
      t: 0, ts: 1, score: 0, chain: 0, mult: 1, hull: 3, charges: 3, chargeT: 0, dustBank: 0, dustStreak: 0,
      caught: 0, perfects: 0, maxChain: 0, maxX: 0, dustTotal: 0, hullProg: 0, lostT: 0, invuln: 0, invert: 0,
      sector: 0, bannerT: 0, target: null, predTarget: null, predN: 0, trailN: 0, pathN: 0, releasedFrom: null,
      relT: 9, skimId: -1, overT: 0, pulseT: 9, hold: false, pulseReq: false, aiAim: null, newBest: false,
      hint: run === 'attract' ? '' : 'HOLD LEFT CLICK TO WIND UP', hintStage: run === 'attract' ? 9 : 0,
    });
    S.visited.length = 0; F.n = 0;
    for (let i = 0; i < PN; i++) P.l[i] = 0;
    for (let i = 0; i < QN; i++) Q.l[i] = 0;
    const home = W.cell(0, 0).planet;
    const c = S.c;
    c.vx = c.vy = 0; c.rescue = null; c.vt = 280; c.dir = 1;
    dock(home, home.r + 58, -1.9);
    home.visited = true; S.visited.push(home);
    S.cam.x = home.x + 120; S.cam.y = home.y; S.cam.vh = 1150; S.cam.shake = 0;
    S.tideX = home.x - 1800;
    W.setPalette(W.SECTORS[0], true);
    SND.setKey(W.SECTORS[0].key, W.SECTORS[0].mode, true);
    pushPath(true);
    S.startT = S.real;
  }

  function dock(b, r, ang) {
    const c = S.c;
    c.lat = b; c.docked = true; c.or = r; c.orT = r; c.ang = ang; c.holdT = 0; c.rescue = null;
    c.vt = Math.max(VMIN, Math.min(c.vt, 320));
    placeOrbit(0);
  }
  function placeOrbit(h) {
    const c = S.c, b = c.lat;
    c.or += (c.orT - c.or) * (1 - Math.exp(-h * 2.2));
    c.ang += c.dir * c.vt / c.or * h;
    const ca = Math.cos(c.ang), sa = Math.sin(c.ang);
    c.x = b.x + ca * c.or; c.y = b.y + sa * c.or;
    c.vx = -sa * c.vt * c.dir + b.vx; c.vy = ca * c.vt * c.dir + b.vy;
  }

  // ── gravity ──
  let AX = 0, AY = 0;
  function accel(x, y, bodies) {
    AX = 0; AY = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - x, dy = b.y - y, d2 = dx * dx + dy * dy, well = b.r * 5;
      if (d2 < well * well) {
        const d = Math.sqrt(d2), f = 1 - d / well;
        const a = GK * b.r * b.r / Math.max(d2, b.r * b.r) * f * f;
        AX += dx / d * a; AY += dy / d * a;
      }
    }
  }

  // ── actions ──
  function latch(b) {
    const c = S.c;
    const dx = c.x - b.x, dy = c.y - b.y, d = hyp(dx, dy);
    const rvx = c.vx - b.vx, rvy = c.vy - b.vy;
    c.dir = (dx * rvy - dy * rvx) >= 0 ? 1 : -1;
    c.vt = Math.max(VMIN, hyp(rvx, rvy));
    c.lat = b; c.docked = false; c.holdT = 0;
    c.or = Math.max(d, b.r + 14);
    c.orT = Math.max(b.r + 22, Math.min(c.or, b.r * 1.45 + 42));
    c.ang = Math.atan2(dy, dx);
    S.skimId = -1; S.lostT = 0;
    const ratio = (d - b.r) / (reach(b) - b.r);
    const q = ratio < 0.24 ? 3 : ratio < 0.52 ? 2 : 1;
    const deg = SND.degreeFromSeed(b.degSeed);
    SND.humStart(deg, b.r > 95);
    const lx = c.x, ly = c.y;
    burst(lx, ly, 10, 140, 0.5, 0, 0, 0.9);
    if (!b.visited) {
      b.visited = true; S.visited.push(b);
      S.caught++; S.chain++; S.maxChain = Math.max(S.maxChain, S.chain);
      const oldMult = S.mult;
      S.mult = Math.min(8, 1 + Math.floor(S.chain / 3));
      const pts = [0, 100, 200, 400][q] * S.mult * (b.isMoon ? 1.5 : 1);
      if (S.run !== 'attract') S.score += pts;
      if (q === 3) S.perfects++;
      SND.S.catch(q);
      popup((q === 3 ? 'PERFECT ' : q === 2 ? 'GREAT ' : '') + '+' + pts, b.x, b.y - b.r - 18, q === 3 ? 1 : 0, 1, 1.4);
      if (S.mult > oldMult) { SND.S.mult(); popup('x' + S.mult, lx, ly - 30, 1, 2, 1.2); }
      if (S.run === 'run' && ++S.hullProg >= 15) {
        S.hullProg = 0;
        if (S.hull < 3) { S.hull++; popup('HULL +1', lx, ly + 30, 2, 1, 1.6); }
      }
      if (S.hintStage === 2) { S.hintStage = 3; S.hint = 'RIGHT CLICK TO PULSE AND GATHER STARDUST'; S.hintT = 5; }
    } else {
      SND.S.catch(1);
    }
  }
  function release() {
    const c = S.c;
    S.releasedFrom = c.lat; S.relT = 0;
    c.lat = null; c.docked = false;
    SND.humStop(1.6);
    SND.S.release(Math.min(1, c.vt / VMAX));
    for (let k = 0; k < 8; k++) emit(c.x, c.y, -c.vx * 0.15 + (Math.random() - 0.5) * 80, -c.vy * 0.15 + (Math.random() - 0.5) * 80, 0.5, 1, 0, 0.7, 0, 3);
    S.skimId = -1;
    if (S.hintStage === 1) { S.hintStage = 2; S.hint = 'HOLD LEFT CLICK NEAR A PLANET TO CATCH IT'; }
  }
  function breakChain() {
    if (S.chain > 0 && S.run !== 'attract') popup('CHAIN LOST', S.c.x, S.c.y - 34, 0, 1, 1.2);
    S.chain = 0; S.mult = 1;
  }
  function hurt() {
    if (S.run !== 'run' || S.invuln > 0) return;
    S.hull--; S.invuln = 1.8;
    if (S.hull <= 0) gameOver();
  }
  function crash(b) {
    const c = S.c;
    burst(c.x, c.y, 40, 320, 0.9, 0, 1, 0);
    burst(c.x, c.y, 24, 200, 1.1, 0.9, 0, 0);
    SND.S.crash(); S.cam.shake = 9; S.invert = 0.1; S.ts = 0.2;
    popup('IMPACT', c.x, c.y - 30, 1, 1, 1.2);
    breakChain(); hurt();
    const ang = Math.atan2(c.y - b.y, c.x - b.x);
    c.vt = 260; SND.humStop(0.3);
    dock(b, b.r + 30, ang);
  }
  function skim(b) {
    S.skimId = b.id;
    const pts = 50 * S.mult;
    if (S.run !== 'attract') S.score += pts;
    popup('SKIM +' + pts, S.c.x, S.c.y - 22, 2, 1, 1.1);
    SND.S.skim();
    for (let k = 0; k < 10; k++) emit(S.c.x, S.c.y, (Math.random() - 0.5) * 160, (Math.random() - 0.5) * 160, 0.6, 1, 0, 0, 1, 2);
  }
  function doPulse() {
    const c = S.c;
    if (S.charges <= 0) { SND.S.beep(); return; }
    S.charges--; S.pulseT = 0; S.pulseX = c.x; S.pulseY = c.y;
    SND.S.pulse();
    gatherDust(c.x, c.y, 420);
    if (c.lat) { c.vt = Math.min(VMAX + 200, c.vt + 170); if (c.docked) c.docked = false; }
    else {
      const dx = S.mwx - c.x, dy = S.mwy - c.y, d = hyp(dx, dy) || 1;
      c.vx += dx / d * 270; c.vy += dy / d * 270;
    }
    S.cam.shake = Math.max(S.cam.shake, 2.5);
    if (S.hintStage === 3) { S.hintStage = 4; S.hint = ''; }
  }
  function gatherDust(x, y, rad) {
    const r2 = rad * rad, near = W.near;
    for (let n = 0; n < near.length; n++) {
      const cell = near[n];
      if (!cell.dustN) continue;
      const d = cell.dust, al = cell.alive;
      for (let k = 0; k < cell.dustN; k++) {
        if (!al[k]) continue;
        const dx = d[k * 2] - x, dy = d[k * 2 + 1] - y;
        if (dx * dx + dy * dy < r2 && F.n < FN) {
          al[k] = 0; F.x[F.n] = d[k * 2]; F.y[F.n] = d[k * 2 + 1]; F.v[F.n] = 120; F.n++;
        }
      }
    }
  }
  function collectDust() {
    S.dustTotal++;
    if (S.run !== 'attract') S.score += 10 * S.mult;
    S.dustStreak = S.dustStreakT > 0 ? S.dustStreak + 1 : 0; S.dustStreakT = 1.2;
    SND.S.dust(S.dustStreak);
    if (++S.dustBank >= 10) {
      S.dustBank = 0;
      if (S.charges < 3) { S.charges++; popup('PULSE +1', S.c.x, S.c.y + 26, 2, 1, 1); }
    }
  }
  function rescue() {
    const c = S.c;
    let best = null, bd = 1e12;
    const ci = Math.floor(c.x / W.CELL), cj = Math.floor(c.y / W.CELL);
    for (let rr = 0; rr < 9 && !best; rr++) {
      for (let i = ci - rr; i <= ci + rr; i++) for (let j = cj - rr; j <= cj + rr; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== rr) continue;
        const p = W.cell(i, j).planet;
        if (!p) continue;
        const d = hyp(p.x - c.x, p.y - c.y) - (p.x > c.x ? 200 : 0);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best) return;
    SND.S.beep(); breakChain(); hurt();
    popup('RESCUE TETHER', c.x, c.y - 30, 2, 1, 1.4);
    c.rescue = { b: best, t: 0, x0: c.x, y0: c.y };
    S.lostT = 0;
  }
  function tideHit() {
    const c = S.c;
    burst(c.x, c.y, 36, 300, 1, 0, 1, 0);
    SND.S.crash(); S.cam.shake = 10; S.invert = 0.12; S.ts = 0.25;
    popup('THE TIDE BITES', c.x, c.y - 30, 1, 1, 1.5);
    breakChain(); hurt();
    S.tideX -= 1300;
    if (c.lat) release();
    c.vx = Math.max(c.vx, 520);
  }
  function gameOver() {
    S.mode = 'over'; S.overT = 0; S.hold = false;
    SND.humStop(1.2); SND.S.over(); SND.setIntensity(0); SND.tide(0);
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (let i = 0; i < S.pathN; i++) {
      const x = S.path[i * 2], y = S.path[i * 2 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    S.box[0] = x0; S.box[1] = y0; S.box[2] = x1; S.box[3] = y1;
    if (on.over) on.over();
  }

  // ── path / trail ──
  function pushPath(force) {
    const c = S.c, n = S.pathN;
    if (!force && n) {
      const dx = c.x - S.path[n * 2 - 2], dy = c.y - S.path[n * 2 - 1];
      if (dx * dx + dy * dy < 18 * 18) return;
    }
    if ((n + 1) * 2 > S.path.length) { const np = new Float32Array(S.path.length * 2); np.set(S.path); S.path = np; }
    S.path[n * 2] = c.x; S.path[n * 2 + 1] = c.y; S.pathN = n + 1;
  }
  function pushTrail() {
    const c = S.c, t = S.trail;
    if (S.trailN) { const dx = c.x - t[0], dy = c.y - t[1]; if (dx * dx + dy * dy < 9) { t[0] = c.x; t[1] = c.y; return; } }
    t.copyWithin(2, 0, t.length - 2);
    t[0] = c.x; t[1] = c.y;
    S.trailN = Math.min(S.trailN + 1, t.length / 2);
  }

  // ── prediction ──
  function predict(bodies) {
    const c = S.c;
    let x = c.x, y = c.y, vx = c.vx, vy = c.vy, n = 0;
    const h = 1 / 60;
    S.predTarget = null; S.predCrash = false;
    outer:
    for (let i = 0; i < 120; i++) {
      accel(x, y, bodies); vx += AX * h; vy += AY * h; x += vx * h; y += vy * h;
      if (i % 2 === 0 && n < 120) { S.pred[n * 2] = x; S.pred[n * 2 + 1] = y; n++; }
      for (let k = 0; k < bodies.length; k++) {
        const b = bodies[k], d = hyp(x - b.x, y - b.y);
        if (d < b.r + CR) { S.predCrash = true; S.predCX = x; S.predCY = y; break outer; }
        if (!S.predTarget && b !== c.lat && d < reach(b) * 0.85) S.predTarget = b;
      }
      if (S.predTarget && i > 20 && n > 0 && !c.lat) break;
    }
    S.predN = n;
  }

  // ── attract-mode pilot ──
  function ai(dt) {
    const c = S.c;
    S.aiPulseT -= dt;
    if (c.lat) {
      if (c.docked) c.docked = false;
      S.hold = true;
      const pt = S.predTarget;
      const good = pt && !S.predCrash && pt.x > c.lat.x - 60 && c.holdT > 0.45;
      const bail = c.holdT > 4.5 && !S.predCrash && c.vx > Math.abs(c.vy) * 0.8;
      if (good || bail) { S.hold = false; S.aiAim = pt; }
      if (pt) { S.mwx = pt.x; S.mwy = pt.y; }
    } else {
      const a = S.aiAim || S.predTarget;
      if (a) { S.mwx = a.x; S.mwy = a.y; }
      S.hold = !!(S.target && S.target !== S.releasedFrom);
      if (S.aiPulseT < 0 && S.charges > 0 && Math.random() < 0.004) { S.pulseReq = true; S.aiPulseT = 6; }
    }
  }

  // ── main update ──
  function update(dt) {
    S.real += dt;
    const c = S.c;
    if (S.mode === 'pause') return;
    S.ts += (1 - S.ts) * (1 - Math.exp(-dt * 2.5));
    const gdt = dt * S.ts;
    W.updatePal(dt);
    S.invert = Math.max(0, S.invert - dt);
    S.cam.shake *= Math.exp(-dt * 7);
    S.bannerT = Math.max(0, S.bannerT - dt);
    S.pulseT += gdt;
    stepParticles(gdt);

    if (S.mode === 'over') { S.overT += dt; camUpdate(dt); return; }
    S.t += gdt;
    S.relT += gdt;
    S.invuln = Math.max(0, S.invuln - gdt);
    S.dustStreakT = Math.max(0, S.dustStreakT - gdt);

    // gather world around camera + comet
    const vw = S.cam.vh * (S.cssW / S.cssH);
    const m = 1500;
    const bodies = W.gather(Math.min(S.cam.x - vw / 2, c.x - m), Math.min(S.cam.y - S.cam.vh / 2, c.y - m),
      Math.max(S.cam.x + vw / 2, c.x + m), Math.max(S.cam.y + S.cam.vh / 2, c.y + m), S.t);

    // mouse → world
    if (S.run !== 'attract') {
      const k = S.cam.vh / S.cssH;
      S.mwx = S.cam.x + (S.mx - S.cssW / 2) * k; S.mwy = S.cam.y + (S.my - S.cssH / 2) * k;
    }

    // target: in-reach body nearest the cursor
    S.target = null;
    if (!c.lat && !c.rescue) {
      let best = 1e12;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b === S.releasedFrom && S.relT < 0.25) continue;
        if (hyp(c.x - b.x, c.y - b.y) <= reach(b)) {
          const md = hyp(S.mwx - b.x, S.mwy - b.y) - b.r;
          if (md < best) { best = md; S.target = b; }
        }
      }
    }
    if (S.run === 'attract') ai(dt);

    if (c.lat && !c.docked && !S.hold) release();
    if (!c.lat && !c.rescue && S.hold && S.target) latch(S.target);
    if (S.pulseReq) { S.pulseReq = false; doPulse(); }

    // physics substeps
    const n = Math.max(1, Math.ceil(gdt * 240)), h = gdt / n;
    for (let s = 0; s < n; s++) {
      if (c.rescue) {
        const r = c.rescue; r.t += h / 0.9;
        const e = r.t >= 1 ? 1 : 1 - Math.pow(1 - r.t, 3);
        const tx = r.b.x - (r.b.r + 44), ty = r.b.y;
        c.x = r.x0 + (tx - r.x0) * e; c.y = r.y0 + (ty - r.y0) * e;
        c.vx = c.vy = 0;
        if (r.t >= 1) { c.vt = 280; dock(r.b, r.b.r + 44, Math.PI); break; }
      } else if (c.lat) {
        if (!c.docked) { c.vt = Math.min(VMAX, c.vt + WIND * h); c.holdT += h; }
        else c.vt += (280 - c.vt) * (1 - Math.exp(-h * 1.5));
        placeOrbit(h);
      } else {
        accel(c.x, c.y, bodies);
        c.vx += AX * h; c.vy += AY * h;
        c.x += c.vx * h; c.y += c.vy * h;
        let hit = null;
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i], d = hyp(c.x - b.x, c.y - b.y);
          if (d < b.r + CR) { hit = b; break; }
          if (d - b.r < 16 + b.r * 0.12 && S.skimId !== b.id && b !== S.releasedFrom) skim(b);
        }
        if (hit) { crash(hit); break; }
      }
      if (S.mode === 'over') return;
    }
    if (S.mode === 'over') return;

    // stardust magnet + flying dust
    gatherDust(c.x, c.y, 58);
    for (let i = 0; i < F.n; i++) {
      F.v[i] += 1500 * gdt;
      const dx = c.x - F.x[i], dy = c.y - F.y[i], d = hyp(dx, dy) || 1;
      const st = Math.min(d, F.v[i] * gdt);
      F.x[i] += dx / d * st; F.y[i] += dy / d * st;
      if (d < 10) {
        collectDust();
        emit(F.x[i], F.y[i], (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 0.35, 1, 0, 0.9, 0, 3);
        F.n--; F.x[i] = F.x[F.n]; F.y[i] = F.y[F.n]; F.v[i] = F.v[F.n]; i--;
      }
    }

    // charges regen
    if (S.charges < 3) { S.chargeT += gdt; if (S.chargeT > 8) { S.chargeT = 0; S.charges++; } } else S.chargeT = 0;

    // void tide (RUN)
    if (S.run === 'run') {
      const gap = c.x - S.tideX;
      let sp = 40 + 95 * Math.min(1, S.t / 300);
      if (gap > 2500) sp *= 3.5;
      S.tideX += sp * gdt;
      S.tideP = Math.max(0, Math.min(1, 1 - gap / 1100));
      SND.tide(S.tideP);
      if (gap < 0 && !c.rescue) tideHit();
    } else S.tideP = 0;
    if (S.mode === 'over') return;

    // lost in space
    if (!c.lat && !c.rescue) {
      let close = false;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (hyp(c.x - b.x, c.y - b.y) < reach(b) * 1.7) { close = true; break; }
      }
      if (close) S.lostT = Math.max(0, S.lostT - gdt * 2); else S.lostT += gdt;
      if (S.lostT > 2.6) {
        const sec = Math.ceil(5.6 - S.lostT);
        if (sec !== S.lostBeep) { S.lostBeep = sec; if (sec > 0) SND.S.beep(); }
        if (S.lostT > 5.6) rescue();
      }
    } else S.lostT = 0;

    // bookkeeping
    pushTrail(); pushPath(false);
    if (c.x > S.maxX) S.maxX = c.x;
    const sec = W.sectorIndexAt(S.maxX);
    if (sec > S.sector) {
      S.sector = sec;
      const sd = W.sectorFor(sec);
      W.setPalette(sd, false);
      SND.setKey(sd.key, sd.mode, false);
      SND.S.sector();
      S.bannerA = 'SECTOR ' + String(sec + 1).padStart(2, '0'); S.bannerB = sd.name; S.bannerT = 4.5;
      if (on.sector) on.sector();
    }
    if (S.hintStage === 0 && !c.docked) { S.hintStage = 1; S.hint = 'RELEASE TO FLING'; }
    if (S.hintT > 0) { S.hintT -= dt; if (S.hintT <= 0 && S.hintStage === 3) { S.hintStage = 4; S.hint = ''; } }

    predict(bodies);

    // comet tail
    if (!c.rescue) {
      const sp = hyp(c.vx, c.vy);
      if (Math.random() < 0.9) emit(c.x + (Math.random() - 0.5) * 4, c.y + (Math.random() - 0.5) * 4,
        -c.vx * 0.08 + (Math.random() - 0.5) * 30, -c.vy * 0.08 + (Math.random() - 0.5) * 30,
        0.35 + sp / 2000, 1, 0, 0.35 + Math.random() * 0.4, 0, 1.5);
    }

    // audio state
    if (c.lat) SND.humUpdate(Math.min(1, (c.vt - VMIN) / (VMAX - VMIN)), c.vt / (6.2832 * c.or));
    SND.setIntensity(S.run === 'attract' ? 1 : S.mult >= 6 ? 3 : S.mult >= 4 ? 2 : S.mult >= 2 ? 1 : 0);

    camUpdate(dt);
    W.evict(c.x, c.y);
  }

  function stepParticles(dt) {
    for (let i = 0; i < PN; i++) {
      if (P.l[i] <= 0) continue;
      P.l[i] -= dt;
      const k = Math.exp(-P.d[i] * dt);
      P.vx[i] *= k; P.vy[i] *= k;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt;
    }
    for (let i = 0; i < QN; i++) if (Q.l[i] > 0) Q.l[i] -= dt;
  }

  function camUpdate(dt) {
    const c = S.c, cam = S.cam;
    let tx, ty, vh;
    if (S.mode === 'over') {
      const b = S.box, e = Math.min(1, S.overT / 2.8), ee = e * e * (3 - 2 * e);
      const aspect = S.cssW / S.cssH;
      const bw = (b[2] - b[0]) + 900, bh = (b[3] - b[1]) + 900;
      const fitH = Math.max(bh * 2.3, bw / aspect * 1.1);
      vh = 1150 + (fitH - 1150) * ee;
      tx = c.x + ((b[0] + b[2]) / 2 - c.x) * ee;
      ty = c.y + ((b[1] + b[3]) / 2 + vh * 0.15 - c.y) * ee;
      cam.x = tx; cam.y = ty; cam.vh = vh;
      return;
    }
    const sp = hyp(c.vx, c.vy);
    let lx = c.vx * 0.3, ly = c.vy * 0.3;
    const ll = hyp(lx, ly);
    if (ll > 360) { lx *= 360 / ll; ly *= 360 / ll; }
    tx = c.x + lx; ty = c.y + ly;
    vh = 1100 + Math.min(1, sp / 900) * 380;
    if (c.lat) {
      const b = c.lat;
      tx = tx * 0.55 + b.x * 0.45; ty = ty * 0.55 + b.y * 0.45;
      vh = Math.max(vh, (c.or * 2 + 280) * 1.2);
    }
    if (S.mode === 'title') { vh *= 1.2; ty += vh * 0.1; }
    const k = 1 - Math.exp(-dt * 3.2);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    cam.vh += (vh - cam.vh) * (1 - Math.exp(-dt * 1.6));
  }

  // ── input ──
  function press() {
    if (S.mode !== 'play') return;
    S.hold = true;
    if (S.c.lat && S.c.docked) { S.c.docked = false; S.c.holdT = 0; }
  }
  function unpress() { S.hold = false; }
  function pulse() { if (S.mode === 'play') S.pulseReq = true; }

  function end() { if (S.mode === 'play') gameOver(); }

  return { S, P, PN, F, Q, QN, on, reset, update, press, unpress, pulse, reach, end };
})();
