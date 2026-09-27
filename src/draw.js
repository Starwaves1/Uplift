'use strict';
// ───────────────────────── Draw: world → batches, in-engine HUD ─────────────────────────
const DRAW = (() => {
  const { B, spr, line, text } = GL;
  const opts = { b4: 0, fps: true };
  const stats = { fps: 0, ms: 0 };
  const F = { pix: 1, time: 0, light: null, neb: [0, 0], star: [0, 0], seed: 0, nebAmt: 1, dith: [0, 0], pal: null, invert: 0, vign: 0.32, bright: 1, b4: 0 };
  let cx = 0, cy = 0, pix = 1, IW = 1, IH = 1, vx0 = 0, vx1 = 0, vy0 = 0, vy1 = 0;
  const inView = (x, y, r) => x + r > vx0 && x - r < vx1 && y + r > vy0 && y - r < vy1;
  const mod8 = v => ((Math.round(v) % 8) + 8) % 8;

  function body(b, t, over) {
    const R = Math.max(b.r, pix * 1.6);
    if (b.moon && !over && inView(b.x, b.y, b.moon.orbitR + 10))
      spr(B.bodies, b.x - cx, b.y - cy, b.moon.orbitR + pix * 2, b.moon.orbitR + pix * 2, 0, 1, 0, 0, 0.16, 0, 0, 1, b.moon.orbitR, pix, 0, 0);
    if (!inView(b.x, b.y, R * 2.3)) return;
    const x = b.x - cx, y = b.y - cy;
    if (b.ring) spr(B.bodies, x, y, R * 2.12 + pix, R * 2.12 * b.ringTilt + pix * 2, b.ringRot, 3, b.seed, 0, 1, 1, 1, 1, R * 1.35, R * 2.1, b.ringTilt, 0);
    spr(B.bodies, x, y, R * 1.25, R * 1.25, 0, 2, b.seed, 1, 1, 1, 1, 1, b.type, t * b.spin, 0, 0);
    if (b.ring) spr(B.bodies, x, y, R * 2.12 + pix, R * 2.12 * b.ringTilt + pix * 2, b.ringRot, 3, b.seed, 0, 1, 1, 1, 1, R * 1.35, R * 2.1, b.ringTilt, 1);
    if (b.visited && !over) spr(B.fx, x, y, R + pix * 6, R + pix * 6, 0, 1, 0, 0, 0, 0, 0.32, 1, R + pix * 3.5, pix, 0, 0);
  }

  function brackets(b, rot, r, g, bl, grow) {
    const s = Math.max(b.r, pix * 2) + pix * (7 + grow);
    spr(B.fxTop, b.x - cx, b.y - cy, s, s, rot, 7, 0, 0, r, g, bl, 1, pix * 5, 0, 0, 0);
  }

  function hud(S) {
    const pad = 8;
    const play = S.mode === 'play' || S.mode === 'pause';
    if (play) {
      text('SCORE', pad, pad, 1, 0.5, 0, 0, 1, 0);
      const sc = String(Math.floor(S.score)), z = Math.max(0, 7 - sc.length);
      text('0000000'.slice(0, z), pad, pad + 10, 2, 0.28, 0, 0, 1, 0);
      text(sc, pad + z * 12, pad + 10, 2, 1, 0, 0, 1, 0);
      if (S.mult > 1) text('x' + S.mult, pad + Math.max(7, sc.length) * 12 + 6, pad + 10, 2, 0, 1, 0, 1, 0);
      text('CHAIN ' + S.chain, pad, pad + 29, 1, 0.62, 0, 0, 1, 0);
      const rx = IW - pad;
      if (S.run === 'run') {
        text('HULL', rx - 36, pad + 1, 1, 0.5, 0, 0, 1, 1);
        for (let i = 0; i < 3; i++) {
          const ix = rx - 4 - i * 11, iy = pad + 4;
          if (i < S.hull) spr(B.hud, ix, iy, 4.5, 4.5, 0, 0, 0, 0, 0, 1, 0, 1, 3.6, 0, 0, 0);
          else spr(B.hud, ix, iy, 4.5, 4.5, 0, 1, 0, 0, 0.35, 0, 0, 1, 3, 1, 0, 0);
        }
      }
      const py = S.run === 'run' ? pad + 16 : pad + 4;
      text('PULSE', rx - 36, py - 3, 1, 0.5, 0, 0, 1, 1);
      for (let i = 0; i < 3; i++) {
        const ix = rx - 4 - i * 11;
        if (i < S.charges) spr(B.hud, ix, py, 4.5, 4.5, Math.PI / 4, 8, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0);
        else spr(B.hud, ix, py, 4.5, 4.5, 0, 1, 0, 0, 0.35, 0, 0, 1, 3, 1, 0, 0);
      }
      if (S.charges < 3) spr(B.hud, rx - 26 + 11, py + 8, (S.chargeT / 8) * 13, 0.5, 0, 8, 0, 0, 0, 0, 0.6, 1, 0, 0, 0, 0);
      const sd = WORLD.sectorFor(S.sector);
      text('SECTOR ' + String(S.sector + 1).padStart(2, '0') + '  ' + sd.name, pad, IH - pad - 17, 1, 0.45, 0, 0, 1, 0);
      text('DIST ' + (Math.max(0, S.maxX) / 1000).toFixed(1) + 'K', pad, IH - pad - 7, 1, 0.62, 0, 0, 1, 0);
      if (S.hint) {
        const hb = Math.sin(S.real * 4) > -0.3 ? 1 : 0.55;
        text(S.hint, IW / 2, IH - pad - 26, 1, 0, 0, hb, 1, 0.5, 0);
      }
      if (S.bannerT > 0) {
        const a = Math.min(1, S.bannerT, (4.5 - S.bannerT) * 1.5);
        text(S.bannerA, IW / 2, IH * 0.2, 1, 0.7, 0, 0, a, 0.5, 0);
        text(S.bannerB, IW / 2, IH * 0.2 + 12, 3, 1, 0, 0, a, 0.5, 1);
      }
      if (S.lostT > 2.6) {
        const blink = (S.real * 3) % 1 < 0.6 ? 1 : 0.35;
        text('SIGNAL LOST', IW / 2, IH * 0.34, 2, 0, 1, 0, blink, 0.5, 0);
        text(String(Math.max(1, Math.ceil(5.6 - S.lostT))), IW / 2, IH * 0.34 + 20, 4, 1, 0, 0, 1, 0.5, 1);
        text('HOLD LEFT CLICK NEAR A PLANET', IW / 2, IH * 0.34 + 54, 1, 0.7, 0, 0, 1, 0.5, 0);
      }
      if (S.tideP > 0.02) {
        const a = Math.min(1, S.tideP * 1.6) * (0.6 + 0.4 * Math.sin(S.real * 8));
        text('<< TIDE', pad, IH / 2 - 3, 1, 0, 1, 0, a, 0, 0);
      }
    }
    if (S.mode === 'title') {
      const e = Math.min(1, (S.real - S.startT) / 1.4);
      const s = Math.max(2, Math.floor(IW * 0.64 / 72));
      const y = Math.round(IH * 0.13);
      text('GRAVITY LOOM', IW / 2 + s, y + s, s, 0, 0, 0.5, e, 0.5, 0);
      text('GRAVITY LOOM', IW / 2, y, s, 1, 0, 0, e, 0.5, 1);
      const sub = 'A SLINGSHOT DRIFT THROUGH THE QUIET DARK';
      text(sub, IW / 2, y + 7 * s + 9, 1, 0.62, 0, 0, Math.max(0, e * 1.4 - 0.4), 0.5, 0);
    }
    if (S.mode === 'pause') {
      spr(B.hud, IW / 2, IH / 2, IW / 2 + 2, IH / 2 + 2, 0, 8, 0, 1, 0, 0, 0, 0.5, 0, 0, 0, 0);
      text('PAUSED', IW / 2, IH * 0.3, 3, 1, 0, 0, 1, 0.5, 1);
    }
    if (S.mode === 'over') {
      const e = Math.min(1, S.overT / 1.2);
      text('THE WEAVE', IW / 2, Math.round(IH * 0.08), 3, 1, 0, 0, e, 0.5, 1);
      text(S.caught + ' PLANETS  ' + Math.round(S.maxX / 1000) + 'K ACROSS', IW / 2, Math.round(IH * 0.08) + 26, 1, 0.6, 0, 0, e, 0.5, 0);
    }
    if (opts.fps) {
      const str = stats.fps + ' FPS  ' + stats.ms.toFixed(1) + 'MS';
      text(str, IW - pad, IH - pad - 7, 1, 0.42, 0, 0, 1, 1, 0);
    }
  }

  function render() {
    const S = GAME.S, c = S.c;
    IW = GL.IW; IH = GL.IH;
    pix = S.cam.vh / IH;
    let sx = 0, sy = 0;
    if (S.cam.shake > 0.05) { sx = (Math.random() - 0.5) * 2 * S.cam.shake; sy = (Math.random() - 0.5) * 2 * S.cam.shake; }
    cx = Math.round(S.cam.x / pix + sx) * pix; cy = Math.round(S.cam.y / pix + sy) * pix;
    const hw = IW * pix / 2, hh = IH * pix / 2;
    vx0 = cx - hw; vx1 = cx + hw; vy0 = cy - hh; vy1 = cy + hh;
    const t = S.t, rt = S.real, over = S.mode === 'over';

    // bodies
    const list = over ? S.visited : WORLD.bodies;
    for (let i = 0; i < list.length; i++) body(list[i], t, over);

    // void tide
    if (S.run === 'run' && S.tideX > vx0 - 400 && !over) {
      const left = vx0 - 60, right = Math.min(vx1 + 60, S.tideX + 330);
      if (right > left) {
        const qc = (left + right) / 2;
        spr(B.tide, qc - cx, 0, (right - left) / 2, hh + pix * 4, 0, 4, 0, 0, 1, 1, 1, 1, S.tideX - qc, cy, 0, 0);
      }
    }

    // the woven thread
    const p = S.path, n = S.pathN;
    if (n > 1) {
      let end = n, start = Math.max(0, n - 5000), stp = 1, g = 0.3;
      if (over) {
        start = 0; g = 0.62;
        end = Math.max(2, Math.floor(n * Math.min(1, S.overT / 2.6)));
        stp = Math.max(1, Math.ceil(n / 40000));
      }
      let ax = p[start * 2], ay = p[start * 2 + 1];
      for (let i = start + stp; i < end; i += stp) {
        const bx = p[i * 2], by = p[i * 2 + 1];
        if (Math.max(ax, bx) > vx0 && Math.min(ax, bx) < vx1 && Math.max(ay, by) > vy0 && Math.min(ay, by) < vy1)
          line(ax - cx, ay - cy, bx - cx, by - cy, pix, 0, 1, 1, 0.1, g, 0, 0);
        ax = bx; ay = by;
      }
    }

    if (!over) {
      // tether + orbit guide
      if (c.lat && !c.rescue) {
        const b = c.lat, ang = Math.atan2(c.y - b.y, c.x - b.x);
        const sx0 = b.x + Math.cos(ang) * b.r, sy0 = b.y + Math.sin(ang) * b.r;
        spr(B.fx, b.x - cx, b.y - cy, c.or + pix * 2, c.or + pix * 2, 0, 1, 0, 0, 0, 0, 0.2, 1, c.or, pix, 0, 0);
        if (c.docked) line(sx0 - cx, sy0 - cy, c.x - cx, c.y - cy, pix, pix * 4, 0.7, 0.7, 0, 0, 0.55, 0);
        else {
          const w = 1 + Math.min(1, (c.vt - 250) / 630) * 1.2;
          line(sx0 - cx, sy0 - cy, c.x - cx, c.y - cy, pix * w, 0, 1, 1, 0, 0, 1, 0);
        }
        spr(B.fx, sx0 - cx, sy0 - cy, pix * 3, pix * 3, 0, 0, 0, 0, 0, 0, 1, 1, pix * 1.5, 0, 0, 0);
      }
      if (c.rescue) {
        const b = c.rescue.b;
        line(b.x - b.r - cx, b.y - cy, c.x - cx, c.y - cy, pix, pix * 3, 1, 0.6, 0, 0, 0.9, 0);
      }
      // prediction
      if (S.predN && !c.rescue) {
        const la = c.lat ? (c.docked ? 0.55 : 1) : 0.35;
        for (let i = 0; i < S.predN; i++) {
          const f = 1 - i / S.predN;
          spr(B.fx, S.pred[i * 2] - cx, S.pred[i * 2 + 1] - cy, pix * 0.5, pix * 0.5, 0, 8, 0, 0, 0, 0, 0.85, la * (0.15 + 0.85 * f), 0, 0, 0, 0);
        }
        if (S.predCrash && c.lat) {
          const qx = (S.predCX - cx) / pix + IW / 2, qy = (S.predCY - cy) / pix + IH / 2;
          text('x', qx, qy - 3, 1, 0, 1, 0, 0.6 + 0.4 * Math.sin(rt * 12), 0.5, 0);
        }
      }
      // stardust
      const near = WORLD.near;
      for (let ci = 0; ci < near.length; ci++) {
        const cell = near[ci];
        if (!cell.dustN) continue;
        const d = cell.dust, al = cell.alive;
        for (let k = 0; k < cell.dustN; k++) {
          if (!al[k]) continue;
          const x = d[k * 2], y = d[k * 2 + 1];
          if (!inView(x, y, 10)) continue;
          const tw = 0.5 + 0.5 * Math.sin(rt * 4.5 + k * 1.7 + x * 0.013);
          spr(B.fx, x - cx, y - cy, pix * 4, pix * 4, 0, 6, 0, 0, 0, 0.5 + tw * 0.45, 0, 1, pix * (1.6 + tw * 1.6), 0, 0, 0);
        }
      }
      const Fd = GAME.F;
      for (let i = 0; i < Fd.n; i++) spr(B.fx, Fd.x[i] - cx, Fd.y[i] - cy, pix, pix, 0, 8, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0);
      // pulse wave
      if (S.pulseT < 0.6) {
        const e = S.pulseT / 0.6, r = 420 * (1 - Math.pow(1 - e, 3));
        spr(B.fx, S.pulseX - cx, S.pulseY - cy, r + pix * 3, r + pix * 3, 0, 1, 0, 0, 0, 0, 1, 1 - e, r, pix * 2, 0, 0);
      }
    }

    // particles
    const P = GAME.P;
    for (let i = 0; i < GAME.PN; i++) {
      const l = P.l[i];
      if (l <= 0) continue;
      const x = P.x[i], y = P.y[i];
      if (!inView(x, y, 4)) continue;
      const s = P.s[i] * pix * 0.5;
      spr(B.fx, x - cx, y - cy, s, s, 0, 8, 0, 0, P.r[i], P.g[i], P.b[i], Math.min(1, l / P.m[i] * 1.4), 0, 0, 0, 0);
    }

    if (!over) {
      // comet trail + head
      const tr = S.trail, tn = S.trailN;
      for (let i = 0; i < tn - 1; i++) {
        const u = i / Math.max(1, tn - 1);
        line(tr[i * 2] - cx, tr[i * 2 + 1] - cy, tr[i * 2 + 2] - cx, tr[i * 2 + 3] - cy,
          pix * (3.4 - 2.6 * u), 0, 1, 1, 0.1, 1 - u * 0.85, 0, 0);
      }
      const blink = S.invuln > 0 && (rt * 12) % 1 < 0.5;
      if (!blink) spr(B.fx, c.x - cx, c.y - cy, pix * 8, pix * 8, 0, 0, 0, 0, 0.3, 1, 0, 1, pix * 1.8, 0.6, 0, 0);
      // targeting
      if (S.target && !c.lat) brackets(S.target, rt * 0.9, 0, 0, S.hold ? 1 : 0.62, S.hold ? 2 : 0);
      if (S.predTarget && c.lat && !S.predCrash) brackets(S.predTarget, -rt * 1.4, 0, 0.85, 0, 2 + Math.sin(rt * 6) * 1.5);
    }

    // popups
    const Q = GAME.Q;
    for (let i = 0; i < GAME.QN; i++) {
      const l = Q.l[i];
      if (l <= 0) continue;
      const e = 1 - l / Q.m[i];
      const qx = (Q.x[i] - cx) / pix + IW / 2, qy = (Q.y[i] - cy) / pix + IH / 2 - e * 14;
      const ch = Q.ch[i];
      text(Q.str[i], qx, qy, Q.s[i], ch === 0 ? 1 : 0, ch === 1 ? 1 : 0, ch === 2 ? 1 : 0, Math.min(1, (l / Q.m[i]) * 2.5), 0.5, 0);
    }

    hud(S);

    F.pix = pix; F.time = rt; F.light = WORLD.pal.light; F.pal = WORLD.pal;
    F.neb[0] = (cx * 0.12 * 0.0015) % 1000; F.neb[1] = (cy * 0.12 * 0.0015) % 1000;
    F.star[0] = cx / 3; F.star[1] = cy / 3;
    F.seed = (WORLD.seed % 997) * 0.37;
    F.dith[0] = mod8(cx / pix); F.dith[1] = mod8(-cy / pix);
    F.invert = S.invert > 0 ? 1 : 0;
    F.b4 = opts.b4;
    F.bright = 1 + Math.max(0, 0.12 - SND.beatAge()) * (S.mult >= 4 ? 0.9 : 0);
    GL.render(F);
  }

  return { render, opts, stats };
})();
