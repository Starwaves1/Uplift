'use strict';
// ───────────────────────── Audio: planet hums, generative layers, chip-soft SFX ─────────────────────────
const SND = (() => {
  let ctx = null, master, comp, musicBus, musicLP, sfxBus, revSend, delaySend, noiseBuf;
  let droneA, droneB, droneGain, rumbleGain, airFilter;
  let vol = 0.5, musicOn = true;
  const MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11], lydian: [0, 2, 4, 6, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  };
  let key = 50, scale = MODES.lydian, degrees = [0, 1, 2, 4, 5, 6];
  let chord = [50, 54, 57, 61];
  let intensity = 0, tempo = 88, step = 0, nextTime = 0, running = false;
  const beats = new Float64Array(16); let beatHead = 0;
  let hum = null;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = vol;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = musicOn ? 1 : 0;
    musicLP = ctx.createBiquadFilter(); musicLP.type = 'lowpass'; musicLP.frequency.value = 16000;
    musicBus.connect(musicLP).connect(master);
    sfxBus = ctx.createGain(); sfxBus.connect(master);

    // reverb
    const len = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.35; d[i] = lp * Math.pow(1 - i / len, 3); }
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    revSend = ctx.createGain(); revSend.gain.value = 1;
    const revOut = ctx.createGain(); revOut.gain.value = 0.55;
    revSend.connect(conv).connect(revOut).connect(master);

    // ping-pong-ish delay
    delaySend = ctx.createGain();
    const dl = ctx.createDelay(1.5), dr = ctx.createDelay(1.5);
    dl.delayTime.value = 0.51; dr.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2600;
    const pl = ctx.createStereoPanner(); pl.pan.value = -0.6;
    const pr = ctx.createStereoPanner(); pr.pan.value = 0.6;
    delaySend.connect(dl); dl.connect(pl).connect(master); dl.connect(dr); dr.connect(pr).connect(master);
    dr.connect(dlp).connect(fb).connect(dl);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // drone bed
    droneGain = ctx.createGain(); droneGain.gain.value = 0.0001;
    const dlpf = ctx.createBiquadFilter(); dlpf.type = 'lowpass'; dlpf.frequency.value = 420;
    droneA = ctx.createOscillator(); droneA.type = 'triangle';
    droneB = ctx.createOscillator(); droneB.type = 'sawtooth';
    const dbg = ctx.createGain(); dbg.gain.value = 0.25;
    droneA.connect(dlpf); droneB.connect(dbg).connect(dlpf);
    dlpf.connect(droneGain); droneGain.connect(musicBus); droneGain.connect(revSend);
    droneA.start(); droneB.start();
    // space air
    const air = ctx.createBufferSource(); air.buffer = noiseBuf; air.loop = true;
    airFilter = ctx.createBiquadFilter(); airFilter.type = 'bandpass'; airFilter.frequency.value = 700; airFilter.Q.value = 0.6;
    const airG = ctx.createGain(); airG.gain.value = 0.018;
    const airLfo = ctx.createOscillator(); airLfo.frequency.value = 0.05;
    const airAmt = ctx.createGain(); airAmt.gain.value = 380;
    airLfo.connect(airAmt).connect(airFilter.frequency); airLfo.start();
    air.connect(airFilter).connect(airG).connect(musicBus); air.start();
    // tide rumble
    const rum = ctx.createBufferSource(); rum.buffer = noiseBuf; rum.loop = true;
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 160;
    rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0;
    rum.connect(rlp).connect(rumbleGain).connect(sfxBus); rum.start();

    setKey(key, 'lydian', true);
    setInterval(schedule, 25);
    return true;
  }
  function resume() { if (ctx && ctx.state !== 'running') ctx.resume(); }
  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  const now = () => (ctx ? ctx.currentTime : 0);

  function setVolume(v) { vol = v; if (master) master.gain.setTargetAtTime(v, now(), 0.05); }
  function setMusic(on) { musicOn = on; if (musicBus) musicBus.gain.setTargetAtTime(on ? 1 : 0, now(), 0.2); }
  function muffle(on) {
    if (!ctx) return;
    musicLP.frequency.setTargetAtTime(on ? 650 : 16000, now(), 0.15);
    sfxBus.gain.setTargetAtTime(on ? 0.25 : 1, now(), 0.1);
  }

  function isDim(deg) {
    const n = i => scale[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7);
    return n(2) - n(0) === 3 && n(4) - n(0) === 6;
  }
  function setKey(root, mode, instant) {
    key = root; scale = MODES[mode] || MODES.ionian;
    degrees = []; for (let d = 0; d < 7; d++) if (!isDim(d)) degrees.push(d);
    chord = chordFor(0);
    if (!ctx) return;
    const t = now(), tc = instant ? 0.01 : 1.5;
    droneA.frequency.setTargetAtTime(mtof(root - 12), t, tc);
    droneB.frequency.setTargetAtTime(mtof(root - 5) * 1.003, t, tc);
  }
  function chordFor(deg) {
    const n = i => key + scale[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7);
    return [n(0), n(2), n(4), n(6)];
  }
  function degreeFromSeed(s) { return degrees[Math.floor(s * degrees.length) % degrees.length]; }
  function bed(level) { if (ctx) droneGain.gain.setTargetAtTime(0.05 * level, now(), 0.8); }

  // ── voices ──
  function voice(midi, t, vel, type, dur, opts) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(mtof(midi), t);
    if (opts && opts.glide) o.frequency.exponentialRampToValueAtTime(mtof(midi + opts.glide), t + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + (opts && opts.att || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (type === 'square' || type === 'sawtooth') {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = (opts && opts.lp) || 2200;
      o.connect(f); node = f;
    }
    const p = ctx.createStereoPanner(); p.pan.value = (opts && opts.pan) || 0;
    node.connect(g).connect(p);
    p.connect((opts && opts.bus) || sfxBus);
    if (opts && opts.rev) { const r = ctx.createGain(); r.gain.value = opts.rev; p.connect(r).connect(revSend); }
    if (opts && opts.del) { const d = ctx.createGain(); d.gain.value = opts.del; p.connect(d).connect(delaySend); }
    o.start(t); o.stop(t + dur + 0.05);
  }
  function bell(midi, t, vel, pan) {
    voice(midi, t, vel, 'sine', 2.2, { pan, rev: 0.5, del: 0.25 });
    voice(midi + 19.02, t, vel * 0.25, 'sine', 0.8, { pan, rev: 0.4 });
  }
  function noise(t, dur, vel, type, f0, f1, q, bus) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(bus || sfxBus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    return g;
  }

  // ── planet hum (sustained while tethered) ──
  function humStart(deg, big) {
    if (!ctx) return;
    humStop(0.4);
    chord = chordFor(deg);
    const t = now();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.075, t + 0.35);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 1.2;
    const trem = ctx.createGain(); trem.gain.value = 0.8;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 1;
    const la = ctx.createGain(); la.gain.value = 0.2;
    lfo.connect(la).connect(trem.gain); lfo.start(t);
    f.connect(trem).connect(g); g.connect(musicBus); g.connect(revSend);
    const oscs = [lfo];
    const oct = big ? -12 : 0;
    chord.forEach((m, i) => {
      for (let k = -1; k <= 1; k += 2) {
        const o = ctx.createOscillator(); o.type = i === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = mtof(m + oct); o.detune.value = k * 6;
        const vg = ctx.createGain(); vg.gain.value = i === 0 ? 0.5 : 0.16;
        o.connect(vg).connect(f); o.start(t); oscs.push(o);
      }
    });
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = mtof(chord[0] - 12 + oct);
    const sg = ctx.createGain(); sg.gain.value = 0.55; sub.connect(sg).connect(g); sub.start(t); oscs.push(sub);
    hum = { g, f, lfo, oscs };
  }
  function humUpdate(wind, revHz) {
    if (!hum) return;
    const t = now();
    hum.f.frequency.setTargetAtTime(520 + wind * 2800, t, 0.08);
    hum.lfo.frequency.setTargetAtTime(Math.min(8, Math.max(0.3, revHz * 2)), t, 0.2);
  }
  function humStop(rel) {
    if (!hum || !ctx) return;
    const t = now(), h = hum; hum = null;
    h.g.gain.cancelScheduledValues(t);
    h.g.gain.setValueAtTime(Math.max(h.g.gain.value, 0.0001), t);
    h.g.gain.exponentialRampToValueAtTime(0.0001, t + rel);
    h.oscs.forEach(o => o.stop(t + rel + 0.1));
  }

  // ── generative layers ──
  function setIntensity(i) { intensity = i; }
  function setRunning(r) { running = r; if (r && ctx) nextTime = Math.max(nextTime, now() + 0.05); }
  function schedule() {
    if (!ctx || ctx.state !== 'running' || !running) return;
    const spb = 60 / tempo / 2; // eighth notes
    if (nextTime < now()) nextTime = now() + 0.02;
    while (nextTime < now() + 0.12) {
      playStep(step, nextTime);
      nextTime += spb; step = (step + 1) % 16;
    }
  }
  function playStep(s, t) {
    if (s % 2 === 0) { beats[beatHead] = t; beatHead = (beatHead + 1) % 16; }
    if (!musicOn) return;
    if (intensity >= 1) {
      const pat = [0, 1, 2, 3, 2, 1, 2, 3];
      const m = chord[pat[s % 8]] + 12 + (s >= 8 && s % 4 === 3 ? 12 : 0);
      voice(m, t, 0.045, 'triangle', 0.45, { bus: musicBus, pan: (s % 2 ? 0.35 : -0.35), del: 0.35, rev: 0.25 });
    }
    if (intensity >= 2) {
      if (s % 4 === 0) {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.32, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.45);
      }
      if (s % 2 === 1) noise(t, 0.05, 0.035, 'highpass', 7000, 0, 0.7, musicBus);
    }
    if (intensity >= 3) {
      if (s % 2 === 0) voice(chord[0] - 12, t, 0.09, 'sawtooth', 0.28, { bus: musicBus, lp: 520 });
      if (s % 8 === 6) noise(t, 0.18, 0.05, 'bandpass', 1800, 900, 1.4, musicBus);
    }
  }
  function beatAge() {
    if (!ctx) return 9;
    const n = now() - (ctx.outputLatency || ctx.baseLatency || 0);
    let best = 9;
    for (let i = 0; i < 16; i++) { const a = n - beats[i]; if (a >= 0 && a < best) best = a; }
    return best;
  }

  // ── SFX ──
  const S = {
    catch(q) {
      if (!ctx) return; const t = now();
      chord.forEach((m, i) => voice(m + 12, t + i * 0.035, 0.06, 'triangle', 0.9, { pan: -0.3 + i * 0.2, rev: 0.4, del: 0.2 }));
      if (q >= 2) bell(chord[2] + 24, t + 0.14, 0.07, 0.2);
      if (q >= 3) bell(chord[0] + 36, t + 0.22, 0.05, -0.2);
    },
    release(speed) {
      if (!ctx) return; const t = now();
      noise(t, 0.35, 0.07 + speed * 0.05, 'bandpass', 380, 2600, 1.6);
    },
    dust(n) {
      if (!ctx) return; const t = now();
      const idx = n % 12, m = chord[idx % 4] + 24 + 12 * Math.floor(idx / 4) - 12;
      voice(m, t, 0.035, 'square', 0.14, { lp: 3200, rev: 0.3, pan: Math.random() * 0.8 - 0.4 });
    },
    pulse() {
      if (!ctx) return; const t = now();
      voice(62, t, 0.14, 'sine', 0.45, { glide: -24, rev: 0.5 });
      voice(chord[1] + 24, t + 0.03, 0.03, 'square', 0.2, { lp: 2800, del: 0.4 });
    },
    skim() {
      if (!ctx) return; const t = now();
      voice(chord[2] + 12, t, 0.05, 'sine', 0.3, { glide: 12, rev: 0.4 });
    },
    mult() {
      if (!ctx) return; const t = now();
      voice(chord[0] + 24, t, 0.05, 'square', 0.1, { lp: 3000 });
      voice(chord[2] + 24, t + 0.08, 0.05, 'square', 0.16, { lp: 3000, del: 0.3 });
    },
    crash() {
      if (!ctx) return; const t = now();
      noise(t, 0.7, 0.35, 'lowpass', 2400, 90, 0.8);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.75);
      [7, 3, 0, -5].forEach((d, i) => voice(key + 24 + d, t + i * 0.07, 0.04, 'square', 0.12, { lp: 1800 }));
    },
    beep() { if (ctx) voice(81, now(), 0.04, 'square', 0.09, { lp: 2400 }); },
    hover() { if (ctx) voice(88, now(), 0.018, 'square', 0.04, { lp: 3000 }); },
    click() { if (ctx) { const t = now(); voice(76, t, 0.03, 'square', 0.06, { lp: 2600 }); voice(83, t + 0.05, 0.03, 'square', 0.08, { lp: 2600 }); } },
    sector() {
      if (!ctx) return; const t = now();
      chordFor(0).forEach((m, i) => bell(m + 24, t + i * 0.12, 0.04, -0.4 + i * 0.25));
    },
    over() {
      if (!ctx) return; const t = now();
      [12, 7, 3, 0, -5, -12].forEach((d, i) => voice(key + 12 + d, t + i * 0.16, 0.06, 'triangle', 1.2, { rev: 0.6, del: 0.3 }));
    },
    start() {
      if (!ctx) return; const t = now();
      chordFor(0).forEach((m, i) => voice(m + 12, t + i * 0.06, 0.05, 'square', 0.3, { lp: 2400, del: 0.3, rev: 0.3 }));
    },
  };
  function tide(p) { if (rumbleGain) rumbleGain.gain.setTargetAtTime(Math.min(1, p) * 0.35, now(), 0.15); }

  return {
    init, resume, suspend, setVolume, setMusic, muffle, setKey, chordFor, degreeFromSeed, bed,
    humStart, humUpdate, humStop, setIntensity, setRunning, beatAge, tide, S,
    get ready() { return !!ctx; },
  };
})();
