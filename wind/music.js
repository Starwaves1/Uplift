'use strict';
// ───────────────────────── Music: a collection of generative soundtracks ─────────────────────────
// Each track is composed from recurring motifs developed over a sectioned form (intro, A, B, …, outro),
// voiced with its own instruments. Flight intensity (speed, climb, jet) brings layers in and out.
const MUSIC = (() => {
  let ctx = null, dry = null, rev = null, del = null, noise = null;
  let st = { V: 25, climb: 0, jet: 0, active: false };
  let dryRun = false, dryCount = 0;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  };

  // ── voice plumbing ──
  function out(node, pan, dAmt, rAmt, lAmt) {
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan || 0, -0.9, 0.9);
    node.connect(p);
    const d = ctx.createGain(); d.gain.value = dAmt; p.connect(d).connect(dry);
    if (rAmt) { const r = ctx.createGain(); r.gain.value = rAmt; p.connect(r).connect(rev); }
    if (lAmt) { const l = ctx.createGain(); l.gain.value = lAmt; p.connect(l).connect(del); }
  }
  function osc(type, f, t, stop, dest, amp, detune) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f; if (detune) o.detune.value = detune;
    g.gain.value = amp; o.connect(g).connect(dest); o.start(t); o.stop(stop);
    return o;
  }
  function vibrato(oscs, t, rate, cents, delay, stop) {
    const l = ctx.createOscillator(), g = ctx.createGain();
    l.frequency.value = rate; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(cents, t + delay);
    l.connect(g); for (const o of oscs) g.connect(o.detune);
    l.start(t); l.stop(stop);
  }
  // attack → hold for dur → release
  function shape(g, t, a, peak, dur, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + Math.max(a, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a, dur) + rel);
    return t + Math.max(a, dur) + rel + 0.05;
  }
  function noiseSrc(t, stop, dest) {
    const s = ctx.createBufferSource(); s.buffer = noise; s.connect(dest); s.start(t, Math.random() * 1.5); s.stop(stop); return s;
  }

  // ── instruments: (midi, t, dur, vel, pan) ──
  const INST = {
    piano(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(Math.min(7000, f * 7), t); lp.frequency.exponentialRampToValueAtTime(Math.max(500, f * 1.6), t + 1.8);
      const stop = t + dur + 1.8;
      osc('triangle', f, t, stop, lp, 1); osc('sine', f * 2, t, stop, lp, 0.3); osc('sine', f * 3.01, t, stop, lp, 0.06);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.2, t + 0.006);
      g.gain.exponentialRampToValueAtTime(v * 0.07, t + 0.45); g.gain.setTargetAtTime(0.0001, t + Math.max(dur, 0.25), 0.4);
      lp.connect(g); out(g, pan, 1, 0.38, 0.1);
    },
    pluck(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(f * 8, t); lp.frequency.exponentialRampToValueAtTime(f * 1.3, t + 0.5);
      const stop = t + 1.4;
      osc('triangle', f, t, stop, lp, 1); osc('sine', f * 2, t, stop, lp, 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.15, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      lp.connect(g); out(g, pan, 1, 0.3, 0.22);
    },
    pizz(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = Math.min(1500, f * 5);
      osc('triangle', f, t, t + 0.6, lp, 1); osc('sine', f, t, t + 0.6, lp, 0.6);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.26, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      lp.connect(g); out(g, pan, 1, 0.2, 0);
    },
    bell(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain();
      const c = ctx.createOscillator(), mo = ctx.createOscillator(), mg = ctx.createGain();
      c.frequency.value = f; mo.frequency.value = f * 3.5;
      mg.gain.setValueAtTime(f * 2.2 * v, t); mg.gain.exponentialRampToValueAtTime(1, t + 0.9);
      mo.connect(mg).connect(c.frequency); c.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.09, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      c.start(t); mo.start(t); c.stop(t + 2.5); mo.stop(t + 2.5);
      out(g, pan, 1, 0.5, 0.25);
    },
    flute(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = Math.min(6000, f * 5);
      const stop = shape(g, t, 0.07, v * 0.11, dur, 0.22);
      const o1 = osc('sine', f, t, stop, lp, 1), o2 = osc('triangle', f * 2, t, stop, lp, 0.12);
      vibrato([o1, o2], t, 5.2, 11, 0.3, stop);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 1.5; bp.Q.value = 2.5;
      const nb = ctx.createGain(); nb.gain.value = 0.05; noiseSrc(t, stop, bp); bp.connect(nb).connect(lp);
      lp.connect(g); out(g, pan, 1, 0.45, 0.18);
    },
    ocarina(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain();
      const stop = shape(g, t, 0.05, v * 0.12, dur, 0.18);
      const o1 = osc('sine', f, t, stop, g, 1), o2 = osc('sine', f * 3, t, stop, g, 0.04);
      vibrato([o1, o2], t, 4.6, 16, 0.2, stop);
      out(g, pan, 1, 0.55, 0.2);
    },
    accordion(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter(), tr = ctx.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 1900;
      const stop = shape(g, t, 0.03, v * 0.055, dur, 0.1);
      osc('square', f, t, stop, lp, 1, -7); osc('square', f, t, stop, lp, 1, 7); osc('sawtooth', f * 2, t, stop, lp, 0.25);
      const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 5.5; lg.gain.value = 0.18;
      tr.gain.value = 0.82; l.connect(lg).connect(tr.gain); l.start(t); l.stop(stop);
      lp.connect(tr).connect(g); out(g, pan, 1, 0.25, 0.05);
    },
    strings(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900 + v * 1100; lp.Q.value = 0.4;
      const stop = shape(g, t, 0.45, v * 0.045, dur, 0.9);
      const os = [-9, 0, 9].map(d => osc('sawtooth', f, t, stop, lp, 1, d));
      vibrato(os, t, 5, 7, 0.6, stop);
      lp.connect(g); out(g, pan, 1, 0.55, 0.05);
    },
    choir(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), sum = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400;
      const stop = shape(g, t, 0.9, v * 0.11, dur, 1.4);
      const src = ctx.createGain();
      const os = [-6, 6].map(d => osc('sawtooth', f, t, stop, src, 1, d));
      vibrato(os, t, 4.2, 8, 0.8, stop);
      for (const [ff, q, a] of [[780, 7, 1], [1150, 9, 0.6], [2600, 10, 0.18]]) {
        const bp = ctx.createBiquadFilter(), bg = ctx.createGain(); bp.type = 'bandpass'; bp.frequency.value = ff; bp.Q.value = q; bg.gain.value = a;
        src.connect(bp).connect(bg).connect(sum);
      }
      sum.connect(lp).connect(g); out(g, pan, 1, 0.7, 0);
    },
    pad(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 800 + v * 900;
      const stop = shape(g, t, 1.2, v * 0.034, dur, 2.2);
      osc('sawtooth', f, t, stop, lp, 1, -6); osc('sawtooth', f, t, stop, lp, 1, 6); osc('triangle', f / 2, t, stop, lp, 0.5);
      lp.connect(g); out(g, pan, 1, 0.6, 0);
    },
    bass(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 650;
      const stop = shape(g, t, 0.012, v * 0.26, dur * 0.9, 0.18);
      osc('sine', f, t, stop, lp, 1); osc('triangle', f, t, stop, lp, 0.35);
      lp.connect(g); out(g, pan, 1, 0.08, 0);
    },
    drone(m, t, dur, v, pan) {
      const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 360;
      const stop = shape(g, t, 2.5, v * 0.12, dur, 3);
      osc('sine', f, t, stop, lp, 1); osc('sawtooth', f, t, stop, lp, 0.3, 4); osc('sine', f * 1.5, t, stop, lp, 0.25);
      lp.connect(g); out(g, pan, 1, 0.4, 0);
    },
  };
  const PERC = {
    kick(t, v) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.34, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); o.start(t); o.stop(t + 0.45); out(g, 0, 1, 0.05, 0);
    },
    frame(t, v) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(92, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.26, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); o.start(t); o.stop(t + 0.55);
      const bp = ctx.createBiquadFilter(), ng = ctx.createGain(); bp.type = 'bandpass'; bp.frequency.value = 260; bp.Q.value = 1.2;
      ng.gain.setValueAtTime(v * 0.18, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      noiseSrc(t, t + 0.15, bp); bp.connect(ng); ng.connect(g);
      out(g, -0.15, 1, 0.3, 0);
    },
    shaker(t, v) { hiss(t, v * 0.05, 0.055, 6500, 0.25); },
    hat(t, v) { hiss(t, v * 0.04, 0.035, 8500, -0.25); },
    tamb(t, v) {
      hiss(t, v * 0.045, 0.14, 7000, 0.35);
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = 5200;
      g.gain.setValueAtTime(v * 0.006, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); o.connect(g); o.start(t); o.stop(t + 0.12); out(g, 0.35, 1, 0.1, 0);
    },
    tick(t, v) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 1250; o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.07, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g); o.start(t); o.stop(t + 0.08); out(g, 0.2, 1, 0.2, 0);
    },
    clap(t, v) { for (let k = 0; k < 3; k++) hiss(t + k * 0.011, v * 0.07, 0.05 + k * 0.03, 1600, -0.1, 'bandpass'); },
  };
  function hiss(t, amp, len, f, pan, type) {
    const fl = ctx.createBiquadFilter(), g = ctx.createGain();
    fl.type = type || 'highpass'; fl.frequency.value = f; fl.Q.value = 0.9;
    g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    noiseSrc(t, t + len + 0.02, fl); fl.connect(g); out(g, pan, 1, 0.12, 0);
  }

  // ── the collection ──
  // motif notes: [tick, durTicks, scaleStep, velocity] across a phrase of phraseBars bars
  const TRACKS = [
    { id: 'valley', name: 'Valley Waltz', bpm: 84, beats: 3, sub: 2, key: 50, mode: 'ionian', every: 1,
      prog: { A: [0, 0, 5, 5, 3, 3, 4, 4, 0, 0, 5, 5, 1, 4, 0, 0], B: [3, 4, 2, 5, 1, 4, 0, 0, 3, 4, 2, 5, 1, 1, 4, 4] },
      form: ['intro', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['piano', 'flute', 'piano'], leadAt: 74,
      motifs: [
        [[0, 2, 0, .8], [2, 1, 1, .55], [3, 1, 2, .6], [4, 2, 4, .8], [6, 4, 2, .7], [10, 2, 1, .6]],
        [[0, 3, 4, .8], [3, 1, 3, .55], [4, 2, 2, .7], [6, 2, 1, .6], [8, 4, 0, .75]],
        [[0, 1, 0, .7], [1, 1, 2, .6], [2, 2, 4, .8], [4, 2, 5, .7], [6, 6, 4, .8]],
        [[0, 2, 7, .8], [2, 2, 6, .6], [4, 2, 4, .7], [6, 2, 2, .6], [8, 4, 1, .7]],
      ],
      pad: 'strings', padVel: 0.55, bass: { inst: 'pizz', pat: '1.....' }, comp: { inst: 'piano', pat: '..c.c.', vel: 0.32 },
      arp: { inst: 'pluck', pat: '1.3.5.', min: 0.45 }, counter: { inst: 'flute', min: 0.6 } },
    { id: 'updraft', name: 'Updraft', bpm: 108, beats: 4, sub: 4, key: 52, mode: 'lydian', every: 2,
      prog: { A: [0, 1, 5, 4, 0, 1, 5, 4], B: [3, 4, 2, 5, 3, 4, 1, 1] },
      form: ['intro', 'A', 'A', 'B', 'A', 'B', 'outro'], lead: ['flute', 'strings', 'flute'], leadAt: 76,
      motifs: [
        [[0, 6, 4, .8], [6, 2, 5, .6], [8, 8, 7, .9], [16, 6, 6, .7], [22, 2, 5, .6], [24, 8, 4, .8]],
        [[0, 4, 7, .8], [4, 4, 9, .8], [8, 8, 8, .7], [16, 4, 6, .7], [20, 4, 5, .6], [24, 8, 4, .8]],
        [[0, 2, 0, .7], [2, 2, 2, .6], [4, 4, 4, .7], [8, 8, 5, .8], [16, 8, 7, .8], [24, 8, 6, .7]],
      ],
      pad: 'pad', padVel: 0.7, bass: { inst: 'bass', pat: '1.1.1.1.1.1.5.8.' }, arp: { inst: 'pluck', pat: '1358583513585835', min: 0.15 },
      perc: { min: 0.35, rows: { kick: 'x.......x.......', shaker: '..x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.' }, full: 0.65, fullRows: { kick: 'x.......x.x.....', clap: '....x.......x...' } } },
    { id: 'clouds', name: 'Sea of Clouds', bpm: 60, beats: 4, sub: 2, key: 53, mode: 'lydian', every: 2,
      prog: { A: [0, 1, 2, 0], B: [4, 5, 3, 1] },
      form: ['intro', 'A', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['bell', 'bell', 'choir'], leadAt: 81,
      motifs: [
        [[0, 4, 4, .6], [6, 2, 2, .5], [8, 8, 0, .6]],
        [[2, 2, 7, .5], [4, 4, 5, .5], [10, 6, 4, .6]],
        [[0, 8, 2, .55], [8, 4, 4, .5], [12, 4, 1, .5]],
      ],
      pad: 'choir', padVel: 0.7, bass: { inst: 'drone', pat: '1.......', every: 2 }, counter: { inst: 'strings', min: 0.4 } },
    { id: 'harbor', name: 'Harbor Lights', bpm: 64, beats: 2, sub: 3, key: 55, mode: 'ionian', every: 1,
      prog: { A: [0, 4, 5, 3, 0, 4, 0, 0], B: [3, 0, 3, 4, 5, 2, 3, 4] },
      form: ['intro', 'A', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['accordion', 'flute', 'accordion', 'pluck'], leadAt: 72,
      motifs: [
        [[0, 1, 0, .8], [1, 1, 1, .6], [2, 1, 2, .7], [3, 2, 4, .8], [5, 1, 2, .6], [6, 3, 1, .7], [9, 3, 0, .7]],
        [[0, 2, 4, .8], [2, 1, 5, .6], [3, 2, 4, .7], [5, 1, 2, .6], [6, 6, 0, .8]],
        [[0, 1, 7, .8], [1, 1, 6, .6], [2, 1, 4, .7], [3, 3, 5, .8], [6, 1, 4, .6], [7, 1, 2, .6], [8, 4, 1, .7]],
      ],
      pad: 'strings', padVel: 0.35, bass: { inst: 'pizz', pat: '1..5..' }, comp: { inst: 'pluck', pat: '..c..c', vel: 0.5 },
      perc: { min: 0.3, rows: { frame: 'x.....', tamb: '...x..' }, full: 0.6, fullRows: { frame: 'x..x..', tamb: '.x..xx' } } },
    { id: 'stones', name: 'Old Stones', bpm: 70, beats: 4, sub: 2, key: 57, mode: 'dorian', every: 2,
      prog: { A: [0, 6, 0, 3], B: [2, 3, 6, 0] },
      form: ['intro', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['ocarina', 'ocarina', 'bell'], leadAt: 69,
      motifs: [
        [[0, 3, 0, .7], [3, 1, 1, .5], [4, 4, 2, .7], [8, 2, 4, .7], [10, 2, 3, .6], [12, 4, 1, .7]],
        [[0, 2, 4, .7], [2, 2, 6, .6], [4, 8, 5, .8], [12, 4, 4, .6]],
        [[0, 4, 7, .7], [4, 2, 6, .6], [6, 2, 4, .6], [8, 8, 3, .7]],
      ],
      pad: 'strings', padVel: 0.5, bass: { inst: 'drone', pat: '1.......', every: 2 },
      perc: { min: 0.45, rows: { frame: 'x.....x.' } }, counter: { inst: 'bell', min: 0.55 } },
    { id: 'evening', name: 'Evening Tide', bpm: 76, beats: 4, sub: 2, key: 58, mode: 'ionian', every: 1,
      prog: { A: [3, 4, 2, 5, 1, 4, 0, 0], B: [5, 3, 0, 4, 5, 3, 1, 4] },
      form: ['intro', 'A', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['piano', 'strings', 'piano'], leadAt: 72,
      motifs: [
        [[0, 2, 2, .7], [2, 2, 1, .6], [4, 2, 0, .7], [6, 2, 1, .6], [8, 6, 2, .8], [14, 2, 4, .6]],
        [[0, 3, 4, .8], [3, 1, 5, .6], [4, 4, 4, .7], [8, 2, 2, .6], [10, 6, 1, .7]],
        [[0, 4, 5, .7], [4, 2, 4, .6], [6, 2, 2, .6], [8, 8, 4, .8]],
      ],
      pad: 'strings', padVel: 0.65, bass: { inst: 'bass', pat: '1...5...' }, arp: { inst: 'piano', pat: '1.5.8.5.', min: 0.35 } },
    { id: 'kites', name: 'Kite Chase', bpm: 120, beats: 4, sub: 4, key: 48, mode: 'ionian', every: 1,
      prog: { A: [0, 5, 3, 4, 0, 5, 1, 4], B: [3, 4, 2, 5, 1, 4, 0, 0] },
      form: ['intro', 'A', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'outro'], lead: ['bell', 'flute', 'bell', 'piano'], leadAt: 79,
      motifs: [
        [[0, 2, 0, .8], [2, 2, 2, .7], [4, 2, 4, .8], [6, 2, 2, .6], [8, 4, 5, .8], [12, 4, 4, .7], [16, 2, 2, .7], [18, 2, 4, .6], [20, 4, 1, .7], [24, 8, 0, .8]],
        [[0, 2, 4, .8], [2, 2, 5, .6], [4, 2, 7, .8], [6, 2, 5, .6], [8, 2, 4, .7], [10, 2, 2, .6], [12, 4, 3, .7], [16, 8, 2, .7], [24, 8, 0, .7]],
        [[0, 4, 7, .8], [4, 4, 6, .7], [8, 4, 5, .7], [12, 4, 4, .6], [16, 8, 5, .8], [24, 8, 4, .7]],
      ],
      pad: 'accordion', padVel: 0.4, bass: { inst: 'pizz', pat: '1...5...8...5...' }, comp: { inst: 'piano', pat: '....c.......c...', vel: 0.3 },
      perc: { min: 0.25, rows: { kick: 'x.......x.......', tick: '..x...x...x...x.', shaker: 'x.x.x.x.x.x.x.x.' }, full: 0.6, fullRows: { kick: 'x.......x...x...', clap: '....x.......x...' } } },
  ];

  // ── harmony helpers ──
  let T = null, SC = MODES.ionian;
  const deg2midi = d => T.key + SC[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  function chordTones(root) { return [root, root + 2, root + 4]; }
  function nearestDeg(root, target) { // absolute degree of `root` closest to midi target
    let best = root, bd = 1e9;
    for (let o = -3; o <= 4; o++) { const d = root + 7 * o, dist = Math.abs(deg2midi(d) - target); if (dist < bd) { bd = dist; best = d; } }
    return best;
  }
  function snapToChord(d, root) {
    const pcs = chordTones(root).map(x => ((x % 7) + 7) % 7), pc = ((d % 7) + 7) % 7;
    if (pcs.includes(pc)) return d;
    return pcs.includes((pc + 1) % 7) ? d + 1 : d - 1;
  }
  function voicing(root, lo, n) { // chord tones stacked upward from near `lo`
    const out = [], base = nearestDeg(root, lo);
    const steps = [0, 2, 4, 7, 9].slice(0, n);
    for (const s of steps) out.push(deg2midi(base + s));
    return out;
  }

  // ── sequencer state ──
  let running = false, nextT = 0, formIdx = 0, bar = 0, tk = 0, gap = 0, intensity = 0.35;
  let playlist = [], choice = 'shuffle', secCount = {}, phrase = [], phraseIdx = 0, onTrack = null, lastTrackId = null;
  const TPB = () => T.beats * T.sub;
  const tickDur = () => 60 / T.bpm / T.sub;
  const secBars = s => (s === 'intro' || s === 'outro' ? 4 : T.prog[s].length * T.every);
  const progAt = (s, b) => {
    if (s === 'outro') return 0;
    const p = T.prog[s === 'intro' ? 'A' : s];
    return p[Math.floor(b / T.every) % p.length];
  };
  function pickTrack() {
    if (choice !== 'shuffle') return TRACKS.find(t => t.id === choice) || TRACKS[0];
    if (!playlist.length) {
      playlist = TRACKS.map(t => t.id).sort(() => Math.random() - 0.5);
      if (playlist[0] === lastTrackId && playlist.length > 1) playlist.push(playlist.shift());
    }
    const id = playlist.shift();
    return TRACKS.find(t => t.id === id);
  }
  function startTrack(t) {
    T = t; SC = MODES[t.mode]; formIdx = 0; bar = 0; tk = 0; secCount = {}; phrase = []; phraseIdx = 0;
    lastTrackId = t.id;
    if (onTrack && !dryRun) onTrack(t.name, t.id);
  }

  function buildPhrase(sec, rootDeg) {
    phrase = [];
    if (sec === 'intro' || sec === 'outro') {
      if (sec === 'outro') phrase.push({ at: 0, dur: TPB() * 3, d: nearestDeg(0, T.leadAt), v: 0.6 });
      return;
    }
    const rep = secCount[sec] || 0, p = phraseIdx;
    if (intensity < 0.3 && p % 4 === 2) return;               // breathe
    if (rep === 0 && sec === 'A' && p === 0 && formIdx === 1) return; // let the first theme arrive late
    const bank = T.motifs;
    const mi = sec === 'B' ? [2, 2, bank.length > 3 ? 3 : 1, 2][p % 4] : [0, 0, 1, 0][p % 4];
    const motif = bank[Math.min(mi, bank.length - 1)];
    let anchor = nearestDeg(rootDeg, T.leadAt + (st.climb > 2 ? 2 : st.climb < -4 ? -2 : 0));
    const tpb = TPB(), maxT = tpb * 2;
    motif.forEach(([at, dur, step, v], i) => {
      let s = step;
      if (p % 4 === 1) s += 2;
      if (p % 4 === 2 && rep % 2 === 1) s = 4 - s;
      if (p % 4 === 3 && i === motif.length - 1) { s = 0; dur = maxT - at; }
      let a = at;
      if (rep % 2 === 1 && i > 0 && dur > 1) { a = at + 1; dur -= 1; }
      let d = anchor + s;
      const barOf = Math.floor(a / tpb);
      if (a % T.sub === 0) d = snapToChord(d, progAt(sec, bar + barOf));
      phrase.push({ at: a, dur, d, v: v * (0.9 + Math.random() * 0.2) });
      if (Math.random() < 0.18 && i < motif.length - 1 && dur >= 2) phrase.push({ at: a + dur - 1, dur: 1, d: d + (Math.random() < 0.5 ? 1 : -1), v: v * 0.6 });
    });
  }

  function play(inst, m, t, dur, v, pan) { if (dryRun) { dryCount++; return; } INST[inst](m, t, dur, v, pan); }
  function hit(kind, t, v) { if (dryRun) { dryCount++; return; } PERC[kind](t, v); }
  function patTone(ch, root, lo) { // pattern char → midi
    const map = { 1: 0, 3: 2, 5: 4, 8: 7 };
    return deg2midi(nearestDeg(root, lo) + map[ch]);
  }

  function step(t) {
    if (gap > 0) { gap--; return; }
    const sec = T.form[formIdx], tpb = TPB(), dt = tickDur();
    const root = progAt(sec, bar), chordStart = bar % T.every === 0 && tk === 0;
    const I = intensity, lvl = sec === 'intro' || sec === 'outro' ? 0.6 : 1;
    const hum = () => t + (Math.random() - 0.5) * 0.01;
    if (tk === 0 && bar % 2 === 0) { buildPhrase(sec, root); phraseIdx++; }
    if (chordStart) {
      const len = dt * tpb * T.every;
      voicing(root, 55, 4).forEach((m, i) => play(T.pad, m, t, len, T.padVel * lvl * (0.8 + I * 0.3), -0.4 + i * 0.27));
      if (T.counter && I > T.counter.min && sec !== 'intro' && sec !== 'outro') {
        const m = deg2midi(nearestDeg(root + (Math.random() < 0.5 ? 2 : 4), 70));
        play(T.counter.inst, m, t + dt * T.sub, len - dt * T.sub, 0.5, 0.35);
      }
    }
    const ch = T.bass.pat[tk % T.bass.pat.length];
    if (ch !== '.' && (!T.bass.every || bar % T.bass.every === 0)) {
      const lo = T.bass.inst === 'drone' ? 40 : 38;
      play(T.bass.inst, patTone(ch, root, lo), t, T.bass.inst === 'drone' ? dt * tpb * (T.bass.every || 1) : dt * 2, 0.8 * lvl, 0);
    }
    if (T.comp && T.comp.pat[tk] === 'c') voicing(root, 60, 3).forEach((m, i) => play(T.comp.inst, m, hum(), dt, T.comp.vel * lvl, -0.2 + i * 0.2));
    if (T.arp && I > T.arp.min) {
      const c = T.arp.pat[tk % T.arp.pat.length];
      if (c !== '.') play(T.arp.inst, patTone(c, root, 64), hum(), dt * 2, 0.45 + I * 0.25, (tk % 4) / 2 - 0.75);
    }
    if (T.perc && I > T.perc.min && sec !== 'intro') {
      const rows = T.perc.full && I > T.perc.full ? Object.assign({}, T.perc.rows, T.perc.fullRows) : T.perc.rows;
      for (const k in rows) { const c = rows[k][tk % rows[k].length]; if (c !== '.') hit(k, hum(), (c === 'X' ? 1 : 0.75) * (0.6 + I * 0.4)); }
    }
    const pt = (bar % 2) * tpb + tk;
    const leadInst = T.lead[Math.min(T.lead.length - 1, Math.floor((formIdx - 1) / 2))] || T.lead[0];
    for (const n of phrase) if (n.at === pt) play(leadInst, deg2midi(n.d), hum(), n.dur * dt, n.v * (0.75 + I * 0.3) * lvl, 0.1);

    if (++tk >= tpb) {
      tk = 0;
      if (++bar >= secBars(sec)) {
        secCount[sec] = (secCount[sec] || 0) + 1;
        bar = 0; phraseIdx = 0; formIdx++;
        if (formIdx >= T.form.length) { gap = tpb * 2; startTrack(pickTrack()); }
      }
    }
  }

  function schedule() {
    if (!ctx || ctx.state !== 'running' || !running) return;
    const target = st.active ? clamp(0.2 + clamp((st.V - 18) / 50, 0, 1) * 0.55 + st.jet * 0.2 + clamp(st.climb / 6, 0, 1) * 0.1, 0, 1) : 0.35;
    intensity += (target - intensity) * 0.02;
    if (!T) startTrack(pickTrack());
    const now = ctx.currentTime;
    if (nextT < now) nextT = now + 0.05;
    while (nextT < now + 0.15) { const d = tickDur(); step(nextT); nextT += d; }
  }

  return {
    TRACKS: TRACKS.map(t => ({ id: t.id, name: t.name })),
    attach(c, buses) { ctx = c; dry = buses.dry; rev = buses.rev; del = buses.del; noise = buses.noise; setInterval(schedule, 25); },
    setState(s) { st = s; },
    setRunning(r) { running = r; if (r && ctx) nextT = Math.max(nextT, ctx.currentTime + 0.1); },
    choose(id) { choice = id; playlist = []; if (ctx) { gap = 0; startTrack(pickTrack()); } },
    next() { playlist = playlist.filter(i => i !== (T && T.id)); gap = 0; startTrack(choice === 'shuffle' ? pickTrack() : TRACKS[(TRACKS.indexOf(T) + 1) % TRACKS.length]); if (choice !== 'shuffle') choice = T.id; return T.id; },
    set onTrack(fn) { onTrack = fn; },
    get current() { return T ? { id: T.id, name: T.name } : null; },
    // a note from the current key's pentatonic for pickups (k counts up a run)
    chime(k) {
      const t = T || TRACKS[0], sc = MODES[t.mode], pent = sc[2] === 3 ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5];
      const d = pent[k % 5] + 7 * Math.floor(k / 5) % 14;
      return t.key + 24 + sc[d % 7] + 12 * Math.floor(d / 7) - (t.key > 54 ? 12 : 0);
    },
    // exercise every track's full form without audio; returns notes per track
    selfTest() {
      const res = {}, keep = T;
      dryRun = true;
      for (const tr of TRACKS) {
        startTrack(tr); dryCount = 0; gap = 0;
        let guard = 0;
        while (T === tr && guard++ < 100000) step(0);
        res[tr.id] = { notes: dryCount, ticks: guard, minutes: +(guard * 60 / tr.bpm / tr.sub / 60).toFixed(1) };
      }
      dryRun = false; T = keep; if (T) SC = MODES[T.mode];
      return res;
    },
  };
})();
