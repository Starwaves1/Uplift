'use strict';
// ───────────────────────── UI: menus, settings, input, main loop ─────────────────────────
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const settings = Object.assign({ vol: 45, music: true, px: 'fine', dither: '8', fps: true }, store.get('gloom.settings', {}));
  const best = { run: store.get('gloom.best.run', 0), drift: store.get('gloom.best.drift', 0) };
  const PX = { chunky: 240, fine: 360, crisp: 480 };

  if (!GL) { $('nogl').hidden = false; $('menu').hidden = true; return; }

  // ── pixel mouse icons ──
  const MOUSE = ['  #####  ', ' #LL#RR# ', '#LLL#RRR#', '#LLL#RRR#', '#LLL#RRR#', '#########',
    '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', ' #.....# ', '  #####  '];
  function mouseSvg(mode) {
    let r = '';
    MOUSE.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === ' ') return;
      let f = 'var(--b1)';
      if (ch === '#') f = 'var(--b4)';
      if (ch === 'L') f = mode === 'L' ? 'var(--c1)' : mode === 'U' ? 'var(--b3)' : 'var(--b2)';
      if (ch === 'R') f = mode === 'R' ? 'var(--a1)' : 'var(--b2)';
      r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${f}"/>`;
    }));
    if (mode === 'U') r += '<rect x="2" y="-3" width="1" height="2" fill="var(--c2)"/><rect x="1" y="-2" width="3" height="1" fill="var(--c2)"/>';
    return `<svg viewBox="0 -3 9 16" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
  }
  document.querySelectorAll('.mico').forEach(el => { el.innerHTML = mouseSvg(el.dataset.m); });

  // ── sizing ──
  let pw = 0, ph = 0;
  const S = GAME.S;
  function applySize() {
    if (!pw || !ph) return;
    GL.resize(PX[settings.px] || 360, pw, ph);
    document.documentElement.style.setProperty('--px', (GL.K / (window.devicePixelRatio || 1)) + 'px');
  }
  const ro = new ResizeObserver(entries => {
    const e = entries[0];
    if (e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0]) {
      pw = e.devicePixelContentBoxSize[0].inlineSize; ph = e.devicePixelContentBoxSize[0].blockSize;
    } else {
      const d = window.devicePixelRatio || 1;
      pw = Math.round(e.contentRect.width * d); ph = Math.round(e.contentRect.height * d);
    }
    S.cssW = e.contentRect.width || 1; S.cssH = e.contentRect.height || 1;
    applySize();
  });
  try { ro.observe(GL.canvas, { box: 'device-pixel-content-box' }); } catch (e) { ro.observe(GL.canvas); }

  // ── screens ──
  const screens = { title: $('menu'), pause: $('pause'), over: $('over') };
  function setMode(m) {
    document.body.dataset.mode = m;
    Object.keys(screens).forEach(k => { screens[k].hidden = k !== m; });
    $('btnPause').hidden = m !== 'play';
    if (m !== 'title' && m !== 'pause') $('settings').hidden = true;
  }
  const pad7 = n => String(Math.floor(n)).padStart(7, '0');
  function showBest() { $('bestRun').textContent = pad7(best.run); $('bestDrift').textContent = pad7(best.drift); }

  function audioOn() {
    if (!SND.init()) return;
    SND.resume(); SND.setVolume(settings.vol / 100 * 0.9); SND.setMusic(settings.music);
    SND.setRunning(true);
  }
  function start(run) {
    audioOn();
    GAME.reset(run);
    SND.bed(1); SND.S.start();
    setMode('play');
  }
  function toTitle() {
    GAME.reset('attract');
    SND.humStop(0.5); SND.muffle(false); SND.tide(0); SND.bed(0.7);
    showBest(); setMode('title');
  }
  function pause() {
    if (S.mode !== 'play') return;
    S.mode = 'pause'; GAME.unpress();
    SND.muffle(true); SND.setRunning(false); SND.tide(0);
    setMode('pause');
  }
  function resume() {
    if (S.mode !== 'pause') return;
    S.mode = 'play'; SND.muffle(false); SND.setRunning(true);
    $('settings').hidden = true;
    setMode('play');
  }

  GAME.on.over = () => {
    setMode('wait');
    const key = S.run === 'drift' ? 'drift' : 'run';
    let nb = false;
    if (S.score > best[key]) { best[key] = Math.floor(S.score); store.set('gloom.best.' + key, best[key]); nb = true; }
    $('overWhy').textContent = S.run === 'drift' ? 'DRIFT COMPLETE' : S.tideP > 0.5 ? 'THE TIDE CAUGHT YOU' : 'HULL BREACHED';
    $('overBest').hidden = !nb;
    $('overScore').textContent = pad7(S.score);
    $('stPlanets').textContent = S.caught;
    $('stPerfect').textContent = S.perfects;
    $('stChain').textContent = S.maxChain;
    $('stDust').textContent = S.dustTotal;
    $('stDist').textContent = (Math.max(0, S.maxX) / 1000).toFixed(1) + 'K';
    $('stBest').textContent = pad7(best[key]);
    setTimeout(() => { if (S.mode === 'over') setMode('over'); }, 1500);
  };

  // ── buttons ──
  $('btnRun').addEventListener('click', () => start('run'));
  $('btnDrift').addEventListener('click', () => start('drift'));
  $('btnPause').addEventListener('click', pause);
  $('btnResume').addEventListener('click', resume);
  $('btnEnd').addEventListener('click', () => { S.mode = 'play'; SND.muffle(false); SND.setRunning(true); GAME.end(); });
  $('btnAgain').addEventListener('click', () => start(S.run === 'drift' ? 'drift' : 'run'));
  $('btnMenu').addEventListener('click', toTitle);
  const openSettings = () => { syncSettingsUI(); $('settings').hidden = false; };
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettings2').addEventListener('click', openSettings);
  $('btnCloseSet').addEventListener('click', () => { $('settings').hidden = true; });
  document.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => { if (SND.ready) SND.S.hover(); });
    b.addEventListener('click', () => { if (SND.ready) SND.S.click(); });
  });

  // ── settings ──
  function saveSettings() { store.set('gloom.settings', settings); }
  function syncSettingsUI() {
    $('setVol').value = settings.vol;
    $('setMusic').textContent = settings.music ? 'ON' : 'OFF';
    $('setMusic').setAttribute('aria-pressed', settings.music);
    $('setFps').textContent = settings.fps ? 'ON' : 'OFF';
    $('setFps').setAttribute('aria-pressed', settings.fps);
    document.querySelectorAll('#setPx button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === settings.px));
    document.querySelectorAll('#setDither button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === settings.dither));
  }
  function applySettings() {
    DRAW.opts.fps = settings.fps;
    DRAW.opts.b4 = settings.dither === '4' ? 1 : 0;
    if (SND.ready) { SND.setVolume(settings.vol / 100 * 0.9); SND.setMusic(settings.music); }
  }
  $('setVol').addEventListener('input', e => { settings.vol = +e.target.value; applySettings(); saveSettings(); });
  $('setMusic').addEventListener('click', () => { settings.music = !settings.music; applySettings(); syncSettingsUI(); saveSettings(); });
  $('setFps').addEventListener('click', () => { settings.fps = !settings.fps; applySettings(); syncSettingsUI(); saveSettings(); });
  document.querySelectorAll('#setPx button').forEach(b => b.addEventListener('click', () => {
    settings.px = b.dataset.v; applySize(); syncSettingsUI(); saveSettings();
  }));
  document.querySelectorAll('#setDither button').forEach(b => b.addEventListener('click', () => {
    settings.dither = b.dataset.v; applySettings(); syncSettingsUI(); saveSettings();
  }));

  // ── input ──
  window.addEventListener('mousemove', e => { S.mx = e.clientX; S.my = e.clientY; }, { passive: true });
  window.addEventListener('mousedown', e => {
    if (!SND.ready) audioOn();
    if (e.target.closest && e.target.closest('button, input, .panel')) return;
    if (S.mode !== 'play') return;
    e.preventDefault();
    if (e.button === 0) GAME.press();
    else if (e.button === 2) GAME.pulse();
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) GAME.unpress(); });
  window.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', () => { GAME.unpress(); pause(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pause(); SND.suspend(); } else SND.resume();
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') { if (S.mode === 'play') pause(); else if (S.mode === 'pause') resume(); }
    if (e.key === 'm' || e.key === 'M') { settings.music = !settings.music; applySettings(); saveSettings(); }
  });

  // ── palette → CSS ──
  const vars = ['--b0', '--b1', '--b2', '--b3', '--b4', '--b5', '--a0', '--a1', '--a2', '--c0', '--c1', '--c2'];
  let lastPal = '';
  function syncPal() {
    const p = WORLD.pal, arr = [];
    const hx = (a, i) => '#' + [0, 1, 2].map(k => Math.round(Math.min(1, Math.max(0, a[i * 3 + k])) * 255).toString(16).padStart(2, '0')).join('');
    for (let i = 0; i < 6; i++) arr.push(hx(p.base, i));
    for (let i = 0; i < 3; i++) arr.push(hx(p.accA, i));
    for (let i = 0; i < 3; i++) arr.push(hx(p.accB, i));
    const s = arr.join();
    if (s === lastPal) return;
    lastPal = s;
    const st = document.documentElement.style;
    arr.forEach((v, i) => st.setProperty(vars[i], v));
  }

  // ── loop ──
  let last = performance.now(), fpsStart = last, frames = 0, msAcc = 0, palTick = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    let dt = (ts - last) / 1000; last = ts;
    if (!(dt > 0)) dt = 1 / 240;
    if (dt > 0.05) dt = 0.05;
    const t0 = performance.now();
    GAME.update(dt);
    DRAW.render();
    msAcc += performance.now() - t0; frames++;
    if (ts - fpsStart >= 500) {
      DRAW.stats.fps = Math.round(frames * 1000 / (ts - fpsStart));
      DRAW.stats.ms = msAcc / frames;
      frames = 0; msAcc = 0; fpsStart = ts;
    }
    if (++palTick % 8 === 0) syncPal();
  }

  applySettings(); syncSettingsUI(); showBest();
  GAME.reset('attract');
  setMode('title');
  requestAnimationFrame(t => { last = t; fpsStart = t; frame(t); });
})();
