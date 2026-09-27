'use strict';
// ───────────────────────── Audio: wind, jet, variometer, chimes; music lives in music.js ─────────────────────────
const SOUND = (() => {
  let ctx = null, master, sfxBus, revSend, delSend, noiseBuf, musicGates = [];
  let windLP, windG, whistleBP, whistleG, rushG, jetG, jetOsc = [], jetLP, windPan, muffle, varioG;
  let vol = 0.7, musicOn = true, varioOn = true;
  const st = { V: 0, agl: 100, jet: 0, climb: 0, beta: 0, cloud: 0, active: false, ground: false };
  let climbAvg = 0;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    if (ctx) return true;
    if (window.WB_MUTE) return false; // test builds never make sound
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = vol;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3;
    muffle = ctx.createBiquadFilter(); muffle.type = 'lowpass'; muffle.frequency.value = 18000;
    master.connect(muffle).connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.connect(master);

    const len = Math.floor(ctx.sampleRate * 3.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.3; d[i] = lp * Math.pow(1 - i / len, 2.6); }
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    revSend = ctx.createGain(); const ro = ctx.createGain(); ro.gain.value = 0.6;
    revSend.connect(conv).connect(ro).connect(master);
    delSend = ctx.createGain();
    const dl = ctx.createDelay(2), fb = ctx.createGain(), dlp = ctx.createBiquadFilter();
    dl.delayTime.value = 0.68; fb.gain.value = 0.33; dlp.type = 'lowpass'; dlp.frequency.value = 2400;
    delSend.connect(dl); dl.connect(dlp).connect(fb).connect(dl); dl.connect(revSend); dl.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < nd.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.97 * b0 + w * 0.3; nd[i] = b0 * 0.6 + w * 0.15; }
    const src = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(0, Math.random() * 2); return s; };

    // music: dry, reverb and echo paths each pass through a gate so muting silences tails too
    const gate = dest => { const g = ctx.createGain(); g.gain.value = musicOn ? 0.9 : 0; g.connect(dest); musicGates.push(g); return g; };
    const musicDry = gate(master), musicRev = gate(revSend), musicDel = gate(delSend);
    if (typeof MUSIC !== 'undefined') MUSIC.attach(ctx, { dry: musicDry, rev: musicRev, del: musicDel, noise: noiseBuf });

    windPan = ctx.createStereoPanner();
    windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 400; windLP.Q.value = 0.8;
    windG = ctx.createGain(); windG.gain.value = 0;
    src().connect(windLP).connect(windG).connect(windPan).connect(sfxBus);
    whistleBP = ctx.createBiquadFilter(); whistleBP.type = 'bandpass'; whistleBP.frequency.value = 900; whistleBP.Q.value = 7;
    whistleG = ctx.createGain(); whistleG.gain.value = 0;
    src().connect(whistleBP).connect(whistleG).connect(windPan);
    const rhp = ctx.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 1800;
    rushG = ctx.createGain(); rushG.gain.value = 0;
    src().connect(rhp).connect(rushG).connect(sfxBus);

    jetLP = ctx.createBiquadFilter(); jetLP.type = 'lowpass'; jetLP.frequency.value = 900;
    jetG = ctx.createGain(); jetG.gain.value = 0;
    for (const [type, det, gv] of [['sawtooth', 0, 0.3], ['sawtooth', 7, 0.3], ['triangle', 1200, 0.25]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = 180; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = gv;
      o.connect(og).connect(jetLP); o.start(); jetOsc.push(o);
    }
    const jn = ctx.createBiquadFilter(); jn.type = 'bandpass'; jn.frequency.value = 2400; jn.Q.value = 0.7;
    src().connect(jn).connect(jetLP);
    jetLP.connect(jetG).connect(sfxBus);

    varioG = ctx.createGain(); varioG.gain.value = 1; varioG.connect(sfxBus);
    setInterval(varioTick, 20);
    return true;
  }
  const now = () => ctx.currentTime;
  function resume() { if (ctx && ctx.state !== 'running') ctx.resume(); }
  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function setVolume(v) { vol = v; if (master) master.gain.setTargetAtTime(v, now(), 0.05); }
  function setMusic(on) {
    musicOn = on;
    if (ctx) for (const g of musicGates) g.gain.setTargetAtTime(on ? 0.9 : 0, now(), 0.12);
  }
  function setVario(on) { varioOn = on; }
  function setMuffled(on) { if (muffle) muffle.frequency.setTargetAtTime(on ? 700 : 18000, now(), 0.2); }
  function setRunning(r) { if (typeof MUSIC !== 'undefined') MUSIC.setRunning(r); }

  let lastUpd = 0, lastFrame = 0;
  function update(s) {
    Object.assign(st, s);
    if (!ctx) return;
    const t = now(), dt = Math.min(0.1, t - lastFrame); lastFrame = t;
    climbAvg += (st.climb - climbAvg) * (1 - Math.exp(-dt / 0.6)); // vario needle lag
    if (typeof MUSIC !== 'undefined') MUSIC.setState(st);
    if (t - lastUpd < 0.03) return;
    lastUpd = t;
    const V = st.active ? st.V : 0;
    const v = clamp(V / 70, 0, 1.3);
    windG.gain.setTargetAtTime(0.02 + Math.pow(v, 1.6) * 0.5 + st.cloud * 0.1, t, 0.08);
    windLP.frequency.setTargetAtTime(260 + v * 1900 + st.cloud * 400, t, 0.08);
    whistleG.gain.setTargetAtTime(Math.max(0, v - 0.55) * 0.12, t, 0.1);
    whistleBP.frequency.setTargetAtTime(700 + v * 900, t, 0.1);
    windPan.pan.setTargetAtTime(clamp(st.beta * 3, -0.7, 0.7), t, 0.1);
    const rush = st.agl < 20 ? (1 - st.agl / 20) * clamp(V / 40, 0, 1.2) : 0;
    rushG.gain.setTargetAtTime(rush * 0.22 + (st.ground ? clamp(V / 30, 0, 1) * 0.15 : 0), t, 0.06);
    jetG.gain.setTargetAtTime(st.jet * 0.1, t, 0.12);
    jetLP.frequency.setTargetAtTime(500 + st.jet * 2600, t, 0.2);
    for (const o of jetOsc) o.frequency.setTargetAtTime(140 + st.jet * 330, t, 0.35);
  }

  // variometer: beeps faster and higher the harder you climb, a soft low tone when sinking hard
  let nextBeep = 0, sinkTone = null;
  function varioTick() {
    if (!ctx || ctx.state !== 'running') return;
    const t = now(), on = varioOn && st.active && !st.ground;
    const c = climbAvg;
    if (on && c > 0.25) {
      if (nextBeep < t) {
        const k = clamp(c / 5, 0, 1.4);
        const f = 480 + k * 620, len = 0.13 - k * 0.05;
        const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = f; o2.type = 'sine'; o2.frequency.value = f * 2;
        const g2 = ctx.createGain(); g2.gain.value = 0.25;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.11, t + 0.008);
        g.gain.setValueAtTime(0.11, t + len - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g); o2.connect(g2).connect(g); g.connect(varioG);
        o.start(t); o2.start(t); o.stop(t + len + 0.02); o2.stop(t + len + 0.02);
        nextBeep = t + clamp(0.52 - k * 0.3, 0.1, 0.52);
      }
    } else nextBeep = Math.min(nextBeep, t + 0.05);
    // sink: a steady tone that starts just past a normal glide and falls in pitch as you sink faster
    const sink = on && c < -1.6;
    const sf = clamp(560 + (c + 1.6) * 38, 230, 560), sa = clamp(0.05 + (-c - 1.6) * 0.006, 0.05, 0.09);
    if (sink && !sinkTone) {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = sf; o2.type = 'sine'; o2.frequency.value = sf * 2; g2.gain.value = 0.3;
      g.gain.value = 0.0001; g.gain.setTargetAtTime(sa, t, 0.15);
      o.connect(g); o2.connect(g2).connect(g); g.connect(varioG); o.start(t); o2.start(t);
      sinkTone = { o, o2, g };
    } else if (sinkTone) {
      if (sink) {
        sinkTone.o.frequency.setTargetAtTime(sf, t, 0.15); sinkTone.o2.frequency.setTargetAtTime(sf * 2, t, 0.15);
        sinkTone.g.gain.setTargetAtTime(sa, t, 0.15);
      } else { sinkTone.g.gain.setTargetAtTime(0.0001, t, 0.08); sinkTone.o.stop(t + 0.5); sinkTone.o2.stop(t + 0.5); sinkTone = null; }
    }
  }

  // ── one-shots ──
  let seedRun = 0, seedT = 0;
  function seed() {
    if (!ctx) return;
    const t = now();
    seedRun = t - seedT < 1.6 ? seedRun + 1 : 0; seedT = t;
    const m = typeof MUSIC !== 'undefined' ? MUSIC.chime(seedRun) : 74 + [0, 2, 4, 7, 9][seedRun % 5];
    for (const [mm, v, d] of [[m, 0.06, 1.6], [m + 12, 0.02, 0.9], [m + 19.02, 0.012, 0.6]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = mtof(mm);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(sfxBus); const rs = ctx.createGain(); rs.gain.value = 0.6; g.connect(rs).connect(revSend);
      o.start(t); o.stop(t + d + 0.05);
    }
  }
  function burst(dur, vel, type, f0, f1) {
    const t = now(), s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(sfxBus); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  function splash() { if (ctx) burst(0.6, 0.25, 'bandpass', 1400, 500); }
  function thud() { if (ctx) { burst(0.35, 0.3, 'lowpass', 400, 80); } }
  function crash() {
    if (!ctx) return;
    burst(1.2, 0.5, 'lowpass', 1600, 60);
    const t = now(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 1);
  }
  function thermal() { if (ctx) burst(1.4, 0.06, 'bandpass', 300, 1400); }

  return { init, resume, suspend, setVolume, setMusic, setVario, setMuffled, setRunning, update, seed, splash, thud, crash, thermal,
    get ready() { return !!ctx; }, get climb() { return climbAvg; } };
})();
