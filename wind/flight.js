'use strict';
// ───────────────────────── Flight: aerodynamics, ground contact, cameras, autopilot ─────────────────────────
// Two physics models share state and ground handling:
//   relaxed   — lift/drag on the whole wing, attitude driven by a control law (assists on) or rate/AoA commands (off)
//   realistic — 6-DOF rigid body; lift, drag and moments summed over wing strips, elevons, winglet fins
const FLIGHT = (() => {
  const MASS = 85, S = 8.5, RHO = 1.18, CL0 = 0.22, CLA = 5.0, A_STALL = 0.26, CD0 = 0.016, K = 0.04;
  const NMAX = 5, THRUST = 760, THRUST_REAL = 300, G = 9.81, BOTTOM = 0.48;
  const W = MASS * G;
  const cfg = { physics: 'relaxed', assists: true };

  const g = {
    pos: [0, 200, 0], vel: [0, 0, -25], q: [0, 0, 0, 1],
    r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1],
    stick: [0, 0], boost: false, breath: 1, jet: 0,
    air: [0, 0, 0], wind: [0, 0, 0], V: 25, alpha: 0, beta: 0, nload: 1, vs: 0, phi: 0, vario: 0,
    agl: 200, ground: 0, onGround: false, onWater: false, contactV: 0,
    crashT: 0, invuln: 0, live: true, rollRate: 0, yawRateW: 0, stall: 0,
    w: [0, 0, 0], elevL: 0, elevR: 0, bankHold: 0,
    events: { crash: 0, splash: 0, touch: 0, respawn: 0 },
  };
  const tn = [0, 0, 0], tmp = [0, 0, 0];

  function basis() {
    Q.rot(g.r, g.q, 1, 0, 0); Q.rot(g.u, g.q, 0, 1, 0); Q.rot(g.f, g.q, 0, 0, -1);
  }
  function setHeading(yaw, pitch) {
    const qa = Q.axis([0, 0, 0, 1], 0, 1, 0, -yaw), qb = Q.axis([0, 0, 0, 1], 1, 0, 0, pitch || 0);
    Q.mul(g.q, qa, qb); basis();
    g.w[0] = g.w[1] = g.w[2] = 0;
  }
  const heading = () => Math.atan2(g.f[0], -g.f[2]);

  let home = null; // [x, z, yaw, agl] to respawn at after a crash (a camera bookmark), or null
  const setHome = h => { home = h; };
  function spawn(x, z, yaw, agl) {
    g.pos[0] = x; g.pos[2] = z; g.pos[1] = groundH(x, z) + (agl || 150);
    const real = cfg.physics === 'realistic', s = real ? RS.trimV : 27;
    setHeading(yaw, real ? RS.trimAlpha : 0);
    // fly with the air mass: airspeed along the heading plus the local wind, so there's no sideslip at spawn
    WORLD.windAt(g.pos[0], g.pos[1], g.pos[2], g.wind);
    g.vel[0] = Math.sin(yaw) * s + g.wind[0]; g.vel[1] = 0; g.vel[2] = -Math.cos(yaw) * s + g.wind[2];
    g.crashT = 0; g.invuln = 2; g.live = true; g.breath = Math.max(g.breath, 0.6);
    g.stick[0] = g.stick[1] = 0;
  }
  function setMode(physics, assists) {
    if (physics !== cfg.physics) { g.w[0] = g.w[1] = g.w[2] = 0; }
    cfg.physics = physics; cfg.assists = assists;
    WORLD.realistic = physics === 'realistic';
  }

  function crash() {
    if (g.crashT > 0) return;
    g.crashT = 1.7; g.live = false; g.events.crash++;
    for (let k = 0; k < 40; k++) SCENERY.emit(g.pos[0], g.pos[1], g.pos[2], (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, 1.4, 1.2, g.onWater ? 1 : 3);
  }
  function jetStep(h) {
    const want = g.boost && g.breath > 0.001 && g.live;
    g.jet += ((want ? 1 : 0) - g.jet) * (1 - Math.exp(-h * (want ? 5 : 3)));
    if (want) g.breath = Math.max(0, g.breath - h / 7); else g.breath = Math.min(1, g.breath + h / 45);
  }

  // ───────── relaxed model ─────────
  function stepRelaxed(h) {
    const r = g.r, u = g.u, f = g.f, p = g.pos, v = g.vel;
    const ax0 = v[0] - g.wind[0], ay0 = v[1] - g.wind[1], az0 = v[2] - g.wind[2];
    const Vr = Math.hypot(ax0, ay0, az0);
    g.V = Vr; g.air[0] = ax0; g.air[1] = ay0; g.air[2] = az0;
    let fx = 0, fy = -W, fz = 0;
    let alpha = 0, beta = 0, lx = u[0], ly = u[1], lz = u[2];
    if (Vr > 0.5) {
      const nx = ax0 / Vr, ny = ay0 / Vr, nz = az0 / Vr;
      const vf = nx * f[0] + ny * f[1] + nz * f[2], vu = nx * u[0] + ny * u[1] + nz * u[2], vr = nx * r[0] + ny * r[1] + nz * r[2];
      alpha = Math.atan2(-vu, vf); beta = Math.atan2(vr, vf);
      const qd = 0.5 * RHO * Vr * Vr;
      let CL = CL0 + CLA * alpha;
      const aa = Math.abs(alpha);
      g.stall = aa > A_STALL ? Math.min(1, (aa - A_STALL) * 4) : 0;
      if (aa > A_STALL) CL *= Math.max(0.25, 1 - (aa - A_STALL) * 3.2);
      CL = clamp(CL, -1.2, 1.5);
      const ge = 1 - 0.55 * Math.exp(-Math.max(g.agl, 0) / 4.5);
      const CD = CD0 + K * CL * CL * ge + (aa > A_STALL ? (aa - A_STALL) * 0.9 : 0) + Math.abs(beta) * 0.08;
      lx = r[1] * nz - r[2] * ny; ly = r[2] * nx - r[0] * nz; lz = r[0] * ny - r[1] * nx;
      const ll = Math.hypot(lx, ly, lz) || 1; lx /= ll; ly /= ll; lz /= ll;
      const L = qd * S * CL, D = qd * S * CD;
      fx += L * lx - D * nx; fy += L * ly - D * ny; fz += L * lz - D * nz;
      const side = -vr * qd * S * 0.25;
      fx += side * r[0]; fy += side * r[1]; fz += side * r[2];
      g.nload = L / W;
    }
    g.alpha = alpha; g.beta = beta;
    jetStep(h);
    if (g.jet > 0.01) { const T = THRUST * g.jet; fx += f[0] * T; fy += f[1] * T; fz += f[2] * T; }
    // ground cushion: air trapped under the wing softens the last few metres of a descent
    if (g.agl < 8 && v[1] < 0 && g.live) fy += MASS * Math.min(-v[1], 10) * 1.3 * Math.exp(-Math.max(g.agl, 0) / 2.5);
    const accN = (fx * lx + fy * ly + fz * lz) / MASS; // curvature of the flight path in the wing's plane
    v[0] += fx / MASS * h; v[1] += fy / MASS * h; v[2] += fz / MASS * h;
    p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;

    const sx = g.stick[0], sy = g.stick[1];
    const phi = Math.atan2(-r[1], u[1]);
    g.phi = phi;
    const qd = 0.5 * RHO * Math.max(Vr, 1) * Math.max(Vr, 1);
    const aMax = Math.min(A_STALL * 0.92, (NMAX * W / (qd * S) - CL0) / CLA);
    const aMin = Math.max(-0.16, (-2.2 * W / (qd * S) - CL0) / CLA);
    const auth = clamp(Vr / 14, 0.25, 1);
    const yawRate = -3.2 * clamp(beta, -0.8, 0.8) * auth;
    let pitchRate, rollRate;
    if (cfg.assists) {
      // pitch commands load factor: neutral holds the path (with gentle speed stability), back pulls g
      const sp = Math.hypot(v[0], v[1], v[2]);
      const gam = Math.asin(clamp(v[1] / Math.max(sp, 0.1), -1, 1));
      const cphi = Math.cos(phi);
      const nHold = cphi > 0.05 ? Math.cos(gam) * (1 + (1 / Math.max(cphi, 0.35) - 1) * 0.8) : 0;
      const nCmd = nHold + clamp((Vr - 22) * 0.025, -0.4, 0.8) + (sy > 0 ? sy * 3.3 : sy * 1.9);
      const aCmd = clamp((nCmd * W / (qd * S) - CL0) / CLA, aMin, aMax);
      pitchRate = clamp(accN / Math.max(Vr, 3) + 4.5 * (aCmd - alpha), -2.6, 2.6) * auth;
      // roll: stick sets a bank angle that is held; past 85% it rolls continuously
      const horiz = clamp(1 - (Math.abs(f[1]) - 0.6) / 0.3, 0, 1);
      const pull = clamp((sy - 0.65) / 0.3, 0, 1);
      const ax = Math.abs(sx);
      if (ax <= 0.85) {
        let err = (sx / 0.85) * 1.3 - phi;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        const lvl = clamp(err * 3.2, -2.4, 2.4), free = sx * 1.9;
        const w = horiz * (1 - pull);
        rollRate = free * (1 - w) + lvl * w;
      } else rollRate = Math.sign(sx) * (2.4 + (ax - 0.85) / 0.15 * 1.7);
    } else {
      // raw: stick is angle of attack and roll rate, nothing levels or holds for you
      const aCmd = clamp(0.012 + sy * (sy > 0 ? 0.24 : 0.14), aMin, A_STALL * 1.1);
      pitchRate = clamp(accN / Math.max(Vr, 3) + 4.5 * (aCmd - alpha), -2.6, 2.6) * auth;
      rollRate = sx * 2.8;
    }
    rollRate *= clamp(Vr / 10, 0.3, 1);
    g.rollRate = rollRate;
    const wx = f[0] * rollRate + r[0] * pitchRate + u[0] * yawRate;
    const wy = f[1] * rollRate + r[1] * pitchRate + u[1] * yawRate;
    const wz = f[2] * rollRate + r[2] * pitchRate + u[2] * yawRate;
    g.yawRateW = wy;
    Q.spin(g.q, wx, wy, wz, h);
    g.elevL = clamp(-sy * 0.25 + sx * 0.2, -0.4, 0.4); g.elevR = clamp(-sy * 0.25 - sx * 0.2, -0.4, 0.4);
  }

  // ───────── realistic model ─────────
  // body frame: +x right, +y up, +z back. Positions below are relative to the centre of gravity.
  const RS = (() => {
    const DIH = 5 * Math.PI / 180, N = 7, SPAN = 3.8, CG = [0, -0.05, -0.3];
    const strips = [];
    for (const side of [1, -1]) {
      for (let i = 0; i < N; i++) {
        const x0 = i / N * SPAN, x1 = (i + 1) / N * SPAN, xm = (x0 + x1) / 2;
        const chord = 1.9 - 0.36 * xm;
        strips.push({
          p: [side * xm - CG[0], xm * Math.tan(DIH) - CG[1], -1.0 + 0.33 * xm + chord * 0.25 - CG[2]],
          area: chord * (x1 - x0), chord, side,
          twist: -0.06 * Math.pow(xm / SPAN, 1.2),            // washout: tips fly at lower angle
          elev: xm > 1.1 ? 0.55 : 0,                           // elevon effectiveness (outboard)
          n: [-side * Math.sin(DIH), Math.cos(DIH), 0],        // section normal
          s: [Math.cos(DIH), side * Math.sin(DIH), 0],         // span axis (+x), cross(s, forward) = n
          frac: (side * xm + SPAN) / (2 * SPAN),               // 0 left tip … 1 right tip, for wind sampling
        });
      }
    }
    // upswept tips work as fins: side force behind the CG gives weathervane yaw stability
    const fins = [1, -1].map(side => ({ p: [side * 3.75 - CG[0], 0.45 - CG[1], 0.55 - CG[2]], area: 0.24, chord: 0.5,
      n: [1, 0, 0], s: [0, -1, 0], frac: side > 0 ? 1 : 0, twist: 0, elev: 0 }));
    const I = [42, 175, 140];                                  // pitch (x), yaw (y), roll (z) kg·m²
    return { strips, fins, I, CG, trim: 0, trimAlpha: 0.05, trimV: 24 };
  })();

  function polar(a, out) { // full-range section polar: attached flow → stall → flat plate
    const A0 = 0.035, CLAS = 4.9, AS = 0.25;
    const lin = CLAS * (a + A0), aa = Math.abs(a);
    let cl = lin, cd = 0.008;
    if (aa > AS) {
      const t = clamp((aa - AS) / 0.18, 0, 1);
      const clStall = CLAS * (Math.sign(a) * AS + A0) * 0.78;
      cl = lerp(clStall, 1.1 * Math.sin(2 * a), t);
      cd += 1.25 * Math.sin(a) * Math.sin(a) * (0.35 + 0.65 * t);
    }
    out[0] = cl; out[1] = cd + 0.05 * cl * cl * (aa < 0.6 ? 1 : 0.3);
    return out;
  }
  const PL = [0, 0];
  const F = [0, 0, 0], M = [0, 0, 0], vb = [0, 0, 0], wL = [0, 0, 0], wR = [0, 0, 0], wC = [0, 0, 0];
  const qi = [0, 0, 0, 1], gustL = [0, 0, 0], gustR = [0, 0, 0];
  const AERO = { stall: 0, lift: 0 };
  // one lifting surface: local air includes CG motion, rotation, and the wind difference across the span
  function surf(sg, isFin, vbx, vby, vbz, w, dL, dR, gl, gr, ge) {
      const p = sg.p, gustL = gl, gustR = gr;
      // local air: CG motion + rotation, minus the wind difference across the span (gust = wind here − wind at CG)
      const gx = gustL[0] + (gustR[0] - gustL[0]) * sg.frac, gy = gustL[1] + (gustR[1] - gustL[1]) * sg.frac, gz = gustL[2] + (gustR[2] - gustL[2]) * sg.frac;
      const vx = vbx + w[1] * p[2] - w[2] * p[1] - gx;
      const vy = vby + w[2] * p[0] - w[0] * p[2] - gy;
      const vz = vbz + w[0] * p[1] - w[1] * p[0] - gz;
      const s = sg.s, n = sg.n;
      const vs = vx * s[0] + vy * s[1] + vz * s[2];
      const px = vx - s[0] * vs, py = vy - s[1] * vs, pz = vz - s[2] * vs;   // velocity in the section plane
      const V2 = px * px + py * py + pz * pz;
      if (V2 < 0.25) return;
      const Vm = Math.sqrt(V2);
      const vc = -pz, vn = px * n[0] + py * n[1] + pz * n[2];
      const d = isFin ? 0 : (sg.side > 0 ? dR : dL) * sg.elev;
      const a = Math.atan2(-vn, vc) + sg.twist + d;
      polar(a, PL);
      let cl = PL[0], cd = PL[1];
      if (isFin) { cl = clamp(3.2 * Math.atan2(-vn, vc), -0.9, 0.9); cd = 0.02 + 0.3 * cl * cl; }
      else cd -= 0.05 * cl * cl * (1 - ge);
      const qA = 0.5 * RHO * V2 * sg.area;
      // lift ⟂ section velocity: normalize(cross(s, v)); drag along −v
      let lx = s[1] * pz - s[2] * py, ly = s[2] * px - s[0] * pz, lz = s[0] * py - s[1] * px;
      const ll = Math.hypot(lx, ly, lz) || 1; lx /= ll; ly /= ll; lz /= ll;
      const fx = qA * (cl * lx - cd * px / Vm), fy = qA * (cl * ly - cd * py / Vm), fz = qA * (cl * lz - cd * pz / Vm);
      F[0] += fx; F[1] += fy; F[2] += fz;
      M[0] += p[1] * fz - p[2] * fy; M[1] += p[2] * fx - p[0] * fz; M[2] += p[0] * fy - p[1] * fx;
      if (!isFin) {
        // section pitching moment about its aerodynamic centre (reflexed profile + elevon)
        const cm = (0.012 - 0.45 * d) * qA * sg.chord;
        M[0] += s[0] * cm; M[1] += s[1] * cm; M[2] += s[2] * cm;
        const ae = Math.abs(a); if (ae > 0.25) AERO.stall = Math.max(AERO.stall, Math.min(1, (ae - 0.25) * 4));
        AERO.lift += qA * cl;
      }
  }
  // sum aerodynamic force F and moment M (body frame) for body air-velocity vb, body rates w, elevons dL,dR
  function aero(vbx, vby, vbz, w, dL, dR, gl, gr, ge) {
    F[0] = F[1] = F[2] = M[0] = M[1] = M[2] = 0;
    AERO.stall = 0; AERO.lift = 0;
    const st = RS.strips, fi = RS.fins;
    for (let i = 0; i < st.length; i++) surf(st[i], false, vbx, vby, vbz, w, dL, dR, gl, gr, ge);
    for (let i = 0; i < fi.length; i++) surf(fi[i], true, vbx, vby, vbz, w, dL, dR, gl, gr, ge);
    // pilot, nacelle and skids
    const V = Math.hypot(vbx, vby, vbz), dq = 0.5 * RHO * V * 0.09;
    F[0] -= dq * vbx; F[1] -= dq * vby; F[2] -= dq * vbz;
    return AERO;
  }

  // trim once: elevon setting and angle of attack for steady level flight at trimV with centred stick
  (function trim() {
    const zero = [0, 0, 0], w0 = [0, 0, 0];
    let best = 0, bestM = 1e9, bestA = 0.05;
    for (let d = -0.2; d <= 0.2; d += 0.0025) {
      let lo = -0.1, hi = 0.25;
      for (let k = 0; k < 40; k++) {
        const a = (lo + hi) / 2;
        aero(0, -RS.trimV * Math.sin(a), -RS.trimV * Math.cos(a), w0, d, d, zero, zero, 1);
        const lift = F[1] * Math.cos(a) - F[2] * Math.sin(a);
        if (lift > W) hi = a; else lo = a;
      }
      const a = (lo + hi) / 2;
      aero(0, -RS.trimV * Math.sin(a), -RS.trimV * Math.cos(a), w0, d, d, zero, zero, 1);
      if (Math.abs(M[0]) < bestM) { bestM = Math.abs(M[0]); best = d; bestA = a; }
    }
    RS.trim = best; RS.trimAlpha = bestA;
  })();

  const wBody = [0, 0, 0];
  function stepRealistic(h) {
    const r = g.r, u = g.u, f = g.f, p = g.pos, v = g.vel, w = g.w;
    // wind at the CG and near each wingtip: differences across the span roll you in thermals and gusts
    wC[0] = g.wind[0]; wC[1] = g.wind[1]; wC[2] = g.wind[2];
    WORLD.windAt(p[0] - r[0] * 3.4, p[1] - r[1] * 3.4, p[2] - r[2] * 3.4, wL);
    WORLD.windAt(p[0] + r[0] * 3.4, p[1] + r[1] * 3.4, p[2] + r[2] * 3.4, wR);
    const ax0 = v[0] - wC[0], ay0 = v[1] - wC[1], az0 = v[2] - wC[2];
    const Vr = Math.hypot(ax0, ay0, az0);
    g.V = Vr; g.air[0] = ax0; g.air[1] = ay0; g.air[2] = az0;
    // world → body (inverse rotation)
    qi[0] = -g.q[0]; qi[1] = -g.q[1]; qi[2] = -g.q[2]; qi[3] = g.q[3];
    Q.rot(vb, qi, ax0, ay0, az0);
    Q.rot(gustL, qi, wL[0] - wC[0], wL[1] - wC[1], wL[2] - wC[2]);
    Q.rot(gustR, qi, wR[0] - wC[0], wR[1] - wC[1], wR[2] - wC[2]);

    // controls: stick → elevon deflection (servo-limited), with optional stability augmentation
    const sx = g.stick[0], sy = g.stick[1];
    const phi = Math.atan2(-r[1], u[1]);
    g.phi = phi;
    const alpha = Math.atan2(vb[1] * -1, -vb[2]);
    let sym, diff;
    if (cfg.assists) {
      // fly-by-wire: stick is roll rate; centred holds the bank (≤45°, small banks level out);
      // pitch is pitch rate with turn compensation; angle of attack is limited short of the stall
      let pCmd;
      if (Math.abs(sx) > 0.06) { g.bankHold = phi; pCmd = sx * 2.1; }
      else {
        const bh = Math.abs(g.bankHold) < 0.1 ? 0 : clamp(g.bankHold, -0.8, 0.8);
        g.bankHold = bh; pCmd = clamp((bh - phi) * 1.6, -1.2, 1.2);
      }
      const turnQ = Math.abs(phi) < 1.2 ? G / Math.max(Vr, 8) * Math.sin(phi) * Math.tan(phi) : 0;
      const qCmd = sy * 0.9 + turnQ;
      sym = RS.trim + clamp((w[0] - qCmd) * 0.16, -0.25, 0.25) + (alpha > 0.2 ? (alpha - 0.2) * 1.5 : 0);
      diff = clamp((pCmd + w[2]) * 0.2, -0.26, 0.26);
    } else {
      sym = RS.trim - sy * 0.24;
      diff = sx * 0.26;
    }
    const tR = clamp(sym - diff, -0.4, 0.4), tL = clamp(sym + diff, -0.4, 0.4);
    const rate = 3.5 * h;
    g.elevR += clamp(tR - g.elevR, -rate, rate); g.elevL += clamp(tL - g.elevL, -rate, rate);

    const ge = 1 - 0.5 * Math.exp(-Math.max(g.agl, 0) / 4);
    const info = aero(vb[0], vb[1], vb[2], w, g.elevL, g.elevR, gustL, gustR, ge);
    g.stall = info.stall; g.alpha = alpha; g.beta = Math.atan2(vb[0], -vb[2]); g.nload = info.lift / W;
    jetStep(h);
    if (g.jet > 0.01) { const T = THRUST_REAL * g.jet; F[2] -= T; M[0] += 0.04 * T; }
    // integrate: forces to world, gravity, rotation with gyroscopic term
    Q.rot(tmp, g.q, F[0], F[1], F[2]);
    v[0] += tmp[0] / MASS * h; v[1] += (tmp[1] / MASS - G) * h; v[2] += tmp[2] / MASS * h;
    p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
    const I = RS.I;
    const hx = I[0] * w[0], hy = I[1] * w[1], hz = I[2] * w[2];
    w[0] += (M[0] - (w[1] * hz - w[2] * hy)) / I[0] * h;
    w[1] += (M[1] - (w[2] * hx - w[0] * hz)) / I[1] * h;
    w[2] += (M[2] - (w[0] * hy - w[1] * hx)) / I[2] * h;
    for (let k = 0; k < 3; k++) w[k] = clamp(w[k], -8, 8);
    Q.rot(wBody, g.q, w[0], w[1], w[2]);
    Q.spin(g.q, wBody[0], wBody[1], wBody[2], h);
    g.rollRate = -w[2]; g.yawRateW = wBody[1];
  }

  // ───────── ground, water, obstacles (both models) ─────────
  function contact(h) {
    const r = g.r, u = g.u, f = g.f, p = g.pos, v = g.vel, real = cfg.physics === 'realistic';
    const th = terrainH(p[0], p[2], 1);
    const surf = Math.max(th, 0);
    g.ground = surf; g.onWater = th < 0;
    g.agl = p[1] - BOTTOM - surf;
    g.onGround = false;
    if (g.agl < 0) {
      if (g.onWater) { tn[0] = 0; tn[1] = 1; tn[2] = 0; } else terrainN(p[0], p[2], tn);
      const vn = v[0] * tn[0] + v[1] * tn[1] + v[2] * tn[2];
      const upDot = u[0] * tn[0] + u[1] * tn[1] + u[2] * tn[2];
      const sp0 = Math.hypot(v[0], v[1], v[2]);
      g.contactV = -vn;
      const bad = real ? (vn < -4.5 || upDot < 0.7 || (g.onWater && sp0 > 26)) : (vn < -11 || upDot < 0.35);
      if (bad && g.invuln <= 0) { crash(); return true; }
      p[1] = surf + BOTTOM;
      const bounce = real ? 1.1 : vn < -4 ? 1.35 : 1.05;
      if (vn < 0) { v[0] -= tn[0] * vn * bounce; v[1] -= tn[1] * vn * bounce; v[2] -= tn[2] * vn * bounce; }
      const sp = Math.hypot(v[0], v[1], v[2]);
      const rolling = g.jet > 0.2;
      if (real) {
        // skid friction: constant deceleration (grass μ≈0.35, water drag grows with speed)
        const dec = (g.onWater ? 1.2 + sp * 0.12 : rolling ? 0.6 : 3.4) * h;
        const k = sp > 1e-3 ? Math.max(0, sp - dec) / sp : 0;
        v[0] *= k; v[1] *= k; v[2] *= k;
        g.w[0] *= Math.exp(-6 * h); g.w[1] *= Math.exp(-6 * h); g.w[2] *= Math.exp(-6 * h);
      } else {
        const drag = rolling ? (g.onWater ? 0.3 : 0.12) : g.onWater ? 0.5 + 1.8 * (1 - clamp(sp / 25, 0, 1)) : 0.9 + 1.5 * (1 - clamp(sp / 20, 0, 1));
        const e = Math.exp(-drag * h);
        v[0] *= e; v[1] *= e; v[2] *= e;
      }
      if (!g.jet && Math.hypot(v[0], v[1], v[2]) < 0.6) { v[0] = v[1] = v[2] = 0; }
      // settle attitude onto the surface (loosely while the jet is pushing for take-off)
      const cx = u[1] * tn[2] - u[2] * tn[1], cy = u[2] * tn[0] - u[0] * tn[2], cz = u[0] * tn[1] - u[1] * tn[0];
      const settle = rolling ? 1 : 4;
      Q.spin(g.q, cx * settle, cy * settle, cz * settle, h);
      g.onGround = true;
      g.agl = 0;
    }
    for (const s of [1, -1]) {
      const tx = p[0] + r[0] * 3.7 * s + u[0] * 0.3, ty = p[1] + r[1] * 3.7 * s + u[1] * 0.3, tz = p[2] + r[2] * 3.7 * s + u[2] * 0.3;
      if (ty < groundH(tx, tz)) {
        if (g.V > (real ? 8 : 16) && g.invuln <= 0) { crash(); return true; }
        Q.spin(g.q, -f[0] * s * 2.5, -f[1] * s * 2.5, -f[2] * s * 2.5, h);
        g.w[2] *= 0.5;
      }
    }
    if (g.invuln <= 0 && g.V > 9) {
      let hit = g.agl < 12 && SCENERY.treeHit(p[0], p[1], p[2]);
      for (let i = 0; i < MODELS.length && !hit; i++) if (MODELS[i].hit && MODELS[i].hit(p[0], p[1], p[2])) hit = true;
      if (hit) { crash(); return true; }
    }
    return false;
  }

  function step(h) {
    if (g.crashT > 0) {
      g.crashT -= h;
      g.vel[0] *= 0.98; g.vel[1] *= 0.98; g.vel[2] *= 0.98;
      if (g.crashT <= 0) {
        // back to the bookmark if the page was opened at one (a jump, hidden by the crash veil), else just behind the crash
        if (home) { spawn(...home); chase.pos = null; }
        else { const yaw = heading(); spawn(g.pos[0] - Math.sin(yaw) * 60, g.pos[2] + Math.cos(yaw) * 60, yaw, 160); }
        g.events.respawn++;
      }
      return;
    }
    g.invuln = Math.max(0, g.invuln - h);
    basis();
    WORLD.windAt(g.pos[0], g.pos[1], g.pos[2], g.wind);
    if (cfg.physics === 'realistic') stepRealistic(h); else stepRelaxed(h);
    if (contact(h)) return;
    g.vs = g.vel[1];
  }

  let prevE = null;
  function update(dt) {
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) step(h);
    basis();
    // variometer: raw climb when relaxed; total-energy compensated when realistic (pulling up doesn't fake lift)
    const e = g.V * g.V / (2 * G);
    const te = prevE === null || dt <= 0 ? g.vs : g.vs + (e - prevE) / dt;
    prevE = e;
    g.vario = cfg.physics === 'realistic' ? clamp(te, -30, 30) : g.vs;
  }

  // ── cameras ──
  const cam = { pos: [0, 0, 0], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1], q: [0, 0, 0, 1], fovY: 1.2, tanX: 1, tanY: 1, near: 0.8 };
  const look = { yaw: 0, pitch: 0, turn: 0, free: false };
  const chase = { pos: null, q: [0, 0, 0, 1] };
  const shake = { t: 0, amp: 0 };
  const qa = [0, 0, 0, 1], qb = [0, 0, 0, 1], qc = [0, 0, 0, 1], qt = [0, 0, 0, 1];
  let blendT = 1;
  const from = { pos: [0, 0, 0], q: [0, 0, 0, 1] };
  function beginBlend() { from.pos = cam.pos.slice(); from.q = cam.q.slice(); blendT = 0; }

  function camFirstPerson(dt, fovBase) {
    Q.rot(tmp, g.q, GLIDER.HEAD[0], GLIDER.HEAD[1], GLIDER.HEAD[2]);
    cam.pos[0] = g.pos[0] + tmp[0]; cam.pos[1] = g.pos[1] + tmp[1]; cam.pos[2] = g.pos[2] + tmp[2];
    look.turn += (clamp(g.yawRateW * 0.5 - g.rollRate * 0.04, -0.32, 0.32) - look.turn) * (1 - Math.exp(-dt * 2.5));
    if (!look.free) { look.yaw *= Math.exp(-dt * 5); look.pitch *= Math.exp(-dt * 5); }
    shake.t += dt;
    const V = g.V;
    const amp = 0.0009 * (V / 30) * (V / 30) + g.stall * 0.012 + (g.onGround ? 0.004 * Math.min(1, V / 15) : 0)
      + g.jet * 0.0025 + (g.agl < 15 ? 0.0015 * (1 - g.agl / 15) * V / 30 : 0) + SCENERY.events.cloud * 0.003;
    shake.amp += (amp - shake.amp) * (1 - Math.exp(-dt * 6));
    const t = shake.t;
    const sp = shake.amp * (Math.sin(t * 23.1) + Math.sin(t * 37.7 + 1.3) * 0.6 + Math.sin(t * 61.3 + 2.1) * 0.3);
    const sy = shake.amp * (Math.sin(t * 19.7 + 0.4) + Math.sin(t * 43.3 + 2.7) * 0.5);
    Q.axis(qa, 0, 1, 0, look.yaw + look.turn + sy);
    Q.axis(qb, 1, 0, 0, look.pitch - 0.07 + sp);
    Q.axis(qc, 0, 0, 1, g.phi * 0.08);
    Q.mul(qt, g.q, qa); Q.mul(qt, qt, qb); Q.mul(cam.q, qt, qc);
    cam.fovY = (fovBase + clamp((V - 25) / 55, 0, 1) * 11 + g.jet * 4) * Math.PI / 180;
    cam.near = 0.3;
  }
  function camChase(dt, fovBase) {
    if (!chase.pos) chase.pos = g.pos.slice();
    const d = 11, up = 2.8;
    const tx = g.pos[0] - g.f[0] * d + g.u[0] * up * 0.4, ty = g.pos[1] - g.f[1] * d + up, tz = g.pos[2] - g.f[2] * d + g.u[2] * up * 0.4;
    const k = 1 - Math.exp(-dt * 5);
    chase.pos[0] += (tx - chase.pos[0]) * k; chase.pos[1] += (ty - chase.pos[1]) * k; chase.pos[2] += (tz - chase.pos[2]) * k;
    chase.pos[1] = Math.max(chase.pos[1], groundH(chase.pos[0], chase.pos[2]) + 1.5);
    const lx = g.pos[0] + g.f[0] * 6 - chase.pos[0], ly = g.pos[1] + g.f[1] * 6 + 0.6 - chase.pos[1], lz = g.pos[2] + g.f[2] * 6 - chase.pos[2];
    lookAtQ(cam.q, lx, ly, lz, g.u[0] * 0.35, 1 - 0.35 + g.u[1] * 0.35, g.u[2] * 0.35);
    cam.pos[0] = chase.pos[0]; cam.pos[1] = chase.pos[1]; cam.pos[2] = chase.pos[2];
    cam.fovY = (fovBase + clamp((g.V - 25) / 55, 0, 1) * 8) * Math.PI / 180;
    cam.near = 0.8;
  }
  let cineT = 0;
  function camCine(dt) {
    cineT += dt;
    const shot = Math.floor(cineT / 11) % 3, a = cineT * 0.07;
    let ox, oy, oz;
    if (shot === 0) { ox = Math.cos(a) * 16; oy = 3.5; oz = Math.sin(a) * 16; }
    else if (shot === 1) { ox = g.r[0] * 9 - g.f[0] * 5; oy = 1.2; oz = g.r[2] * 9 - g.f[2] * 5; }
    else { ox = -g.f[0] * 30 + g.r[0] * 10; oy = 14; oz = -g.f[2] * 30 + g.r[2] * 10; }
    const tx = g.pos[0] + ox, tz = g.pos[2] + oz;
    const ty = Math.max(g.pos[1] + oy, groundH(tx, tz) + 3);
    if (!chase.pos) chase.pos = [tx, ty, tz];
    const k = (cineT % 11) < dt * 1.5 ? 1 : 1 - Math.exp(-dt * 3);
    chase.pos[0] += (tx - chase.pos[0]) * k; chase.pos[1] += (ty - chase.pos[1]) * k; chase.pos[2] += (tz - chase.pos[2]) * k;
    lookAtQ(cam.q, g.pos[0] - chase.pos[0], g.pos[1] + 0.8 - chase.pos[1], g.pos[2] - chase.pos[2], 0, 1, 0);
    cam.pos[0] = chase.pos[0]; cam.pos[1] = chase.pos[1]; cam.pos[2] = chase.pos[2];
    cam.fovY = 52 * Math.PI / 180; cam.near = 0.8;
  }
  const lr = [0, 0, 0], lu = [0, 0, 0], lb = [0, 0, 0];
  function lookAtQ(out, fx, fy, fz, ux, uy, uz) {
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    lr[0] = rx; lr[1] = ry; lr[2] = rz;
    lu[0] = ry * fz - rz * fy; lu[1] = rz * fx - rx * fz; lu[2] = rx * fy - ry * fx;
    lb[0] = -fx; lb[1] = -fy; lb[2] = -fz;
    return Q.fromBasis(out, lr, lu, lb);
  }
  function updateCamera(dt, mode, fovBase, aspect) {
    if (mode === 'fp') camFirstPerson(dt, fovBase);
    else if (mode === 'chase') camChase(dt, fovBase);
    else camCine(dt);
    if (mode !== 'chase' && mode !== 'cine') chase.pos = null;
    if (blendT < 1) {
      blendT = Math.min(1, blendT + dt / 1.3);
      const e = blendT * blendT * (3 - 2 * blendT);
      for (let i = 0; i < 3; i++) cam.pos[i] = from.pos[i] + (cam.pos[i] - from.pos[i]) * e;
      Q.slerp(cam.q, from.q, cam.q, e);
    }
    Q.rot(cam.r, cam.q, 1, 0, 0); Q.rot(cam.u, cam.q, 0, 1, 0); Q.rot(cam.f, cam.q, 0, 0, -1);
    cam.tanY = Math.tan(cam.fovY / 2); cam.tanX = cam.tanY * aspect;
  }

  // ── title-screen pilot ──
  const ap = { t: 0, h0: 0 };
  const probe = [0, 0, 0];
  function autopilot(dt) {
    ap.t += dt;
    const yawDes = ap.h0 + Math.sin(ap.t * 0.045) * 1.3 + Math.sin(ap.t * 0.011) * 2.2;
    let err = yawDes - heading();
    err = Math.atan2(Math.sin(err), Math.cos(err));
    let maxG = 0;
    for (const d of [0, 150, 320, 520]) {
      probe[0] = g.pos[0] + g.f[0] * d; probe[2] = g.pos[2] + g.f[2] * d;
      maxG = Math.max(maxG, groundH(probe[0], probe[2]));
    }
    const altT = maxG + 95;
    const sy = clamp((altT - g.pos[1]) * 0.012 - g.vel[1] * 0.07, -0.45, 0.6);
    const sx = clamp(err * 0.9, -0.5, 0.5);
    const k = 1 - Math.exp(-dt * 1.6);
    g.stick[0] += (sx - g.stick[0]) * k; g.stick[1] += (sy - g.stick[1]) * k;
    g.boost = g.pos[1] - maxG < 55 || g.V < 17;
  }
  function resetAutopilot() { ap.t = 0; ap.h0 = heading(); }

  return { g, cam, look, cfg, RS, spawn, setHome, setMode, update, updateCamera, autopilot, resetAutopilot, beginBlend, heading, setHeading };
})();
