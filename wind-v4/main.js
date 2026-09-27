'use strict';
// ───────────────────────── Main: loop, input, HUD, menus, settings ─────────────────────────
(() => {
  const $ = id => document.getElementById(id);
  if (!GLX) { $('nogl').hidden = false; $('title').hidden = true; return; }
  const { gl, canvas, env } = GLX;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const settings = Object.assign({ sens: 1, invert: false, fov: 72, units: 'kmh', track: 'shuffle', physics: 'relaxed', assists: true, quality: 'auto', tod: 'afternoon', vol: 70, music: true, vario: true, fps: true },
    store.get('windborne.settings', {}));
  // metres per second → display unit
  const UNITS = { kmh: [3.6, 'KM/H'], mph: [2.23694, 'MPH'], kts: [1.94384, 'KTS'] };
  const unit = () => UNITS[settings.units] || UNITS.kmh;
  let bestSeeds = store.get('windborne.seeds', 0);

  const TOD = {
    morning: { sun: [0.78, 0.3, -0.55], sunCol: [1.12, 0.9, 0.72], zen: [0.2, 0.39, 0.74], hor: [0.86, 0.85, 0.88], amb: [0.56, 0.62, 0.8], fog: 0.00014 },
    afternoon: { sun: [0.42, 0.64, -0.64], sunCol: [1.22, 1.14, 1.0], zen: [0.13, 0.36, 0.8], hor: [0.68, 0.83, 0.97], amb: [0.5, 0.63, 0.86], fog: 0.00011 },
    dusk: { sun: [-0.74, 0.13, 0.66], sunCol: [1.3, 0.74, 0.46], zen: [0.15, 0.21, 0.47], hor: [0.98, 0.7, 0.54], amb: [0.5, 0.45, 0.62], fog: 0.00013 },
  };
  function applyTod() {
    const t = TOD[settings.tod] || TOD.afternoon;
    const l = Math.hypot(...t.sun);
    env.sun.set(t.sun.map(c => c / l)); env.sunCol.set(t.sunCol); env.zen.set(t.zen); env.hor.set(t.hor); env.amb.set(t.amb); env.fog = t.fog;
  }
  applyTod();

  // ── sizing & adaptive resolution ──
  let cssW = 1, cssH = 1, scale = 1, lowT = 0, highT = 0, avgDt = 1 / 60, fastest = 1;
  const recent = new Float32Array(120); let ri = 0;
  const maxScale = () => ({ high: 1, balanced: 0.8, performance: 0.62, auto: 1 })[settings.quality] || 1;
  function resize() {
    cssW = canvas.clientWidth || 1; cssH = canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = settings.quality === 'auto' ? scale : maxScale();
    const w = Math.max(1, Math.round(cssW * dpr * s)), h = Math.max(1, Math.round(cssH * dpr * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  new ResizeObserver(resize).observe(canvas);
  function adapt(dt) {
    if (dt > 0.1) return;
    recent[ri] = dt; ri = (ri + 1) % recent.length;
    fastest = 1; for (let i = 0; i < recent.length; i++) if (recent[i] > 0 && recent[i] < fastest) fastest = recent[i];
    avgDt += (dt - avgDt) * 0.05;
    if (settings.quality !== 'auto') return;
    if (avgDt > fastest * 1.3) { lowT += dt; highT = 0; } else if (avgDt < fastest * 1.07) { highT += dt; lowT = 0; } else { lowT = 0; highT = 0; }
    if (lowT > 1.2 && scale > 0.5) { scale = Math.max(0.5, scale - 0.1); lowT = 0; resize(); }
    if (highT > 6 && scale < 1) { scale = Math.min(1, scale + 0.05); highT = 0; resize(); }
  }

  // ── state ──
  const g = FLIGHT.g, cam = FLIGHT.cam, look = FLIGHT.look;
  let mode = 'title', paused = false, camMode = 'fp', locked = false, absMode = false, hudOn = true;
  const stick = [0, 0];
  let seeds = 0, drift = [0, 0, 0], veil = 0, lastCrash = 0, lastRespawn = 0, wasGround = false, thermalOn = false;
  const start = WORLD.findStart();
  let bestDir = 0, bestH = -1e9;
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2, h = terrainH(start[0] + Math.sin(a) * 1600, start[1] - Math.cos(a) * 1600, 1);
    if (h > bestH) { bestH = h; bestDir = a; }
  }
  FLIGHT.spawn(start[0], start[1], bestDir, 130);
  FLIGHT.resetAutopilot();

  function setScreen(s) {
    $('title').hidden = s !== 'title';
    $('pause').hidden = s !== 'pause';
    $('hud').hidden = s !== 'play' || !hudOn;
    if (s !== 'pause' && s !== 'title') $('settings').hidden = true;
    document.body.dataset.mode = s;
  }
  function lockPointer() {
    absMode = false;
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { absMode = true; });
    } catch (e) { absMode = true; }
    setTimeout(() => { if (mode === 'play' && !paused && document.pointerLockElement !== canvas) absMode = true; }, 500);
  }
  function takeFlight() {
    SOUND.init(); SOUND.resume(); applyAudio(); SOUND.setRunning(true);
    mode = 'play'; paused = false;
    stick[0] = g.stick[0]; stick[1] = g.stick[1];
    g.boost = false;
    FLIGHT.setMode(settings.physics, settings.assists);
    FLIGHT.beginBlend();
    setScreen('play');
    lockPointer();
  }
  function pause() {
    if (mode !== 'play' || paused) return;
    paused = true; g.boost = false; look.free = false;
    SOUND.setMuffled(true);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    setScreen('pause');
  }
  function resume() {
    if (!paused) return;
    paused = false; SOUND.setMuffled(false); SOUND.resume();
    setScreen('play'); lockPointer();
  }
  function toTitle() {
    paused = false; mode = 'title'; SOUND.setMuffled(false);
    FLIGHT.setMode('relaxed', true);
    FLIGHT.beginBlend(); FLIGHT.resetAutopilot();
    setScreen('title');
  }

  $('fly').addEventListener('click', takeFlight);
  $('btnResume').addEventListener('click', resume);
  $('btnTitle').addEventListener('click', toTitle);
  const openSettings = () => { syncSettings(); $('settings').hidden = false; };
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettings2').addEventListener('click', openSettings);
  $('btnDone').addEventListener('click', () => { $('settings').hidden = true; });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked && mode === 'play' && !paused && !absMode) pause();
  });
  document.addEventListener('pointerlockerror', () => { absMode = true; });

  const dz = v => (Math.abs(v) < 0.035 ? 0 : v);
  window.addEventListener('mousemove', e => {
    if (mode !== 'play' || paused) return;
    const dx = locked ? e.movementX : 0, dy = locked ? e.movementY : 0;
    if (look.free && locked) {
      look.yaw = clamp(look.yaw - dx * 0.0035, -2.6, 2.6); look.pitch = clamp(look.pitch - dy * 0.0035, -1.2, 1.1);
      return;
    }
    const inv = settings.invert ? -1 : 1;
    if (locked) {
      const k = settings.sens / 380;
      stick[0] += dx * k; stick[1] -= dy * k * inv;
    } else {
      const R = Math.min(cssW, cssH) * 0.32;
      stick[0] = (e.clientX - cssW / 2) / R; stick[1] = -(e.clientY - cssH / 2) / R * inv;
    }
    const l = Math.hypot(stick[0], stick[1]);
    if (l > 1) { stick[0] /= l; stick[1] /= l; }
  });
  window.addEventListener('mousedown', e => {
    if (mode !== 'play' || paused) return;
    if (e.target.closest && e.target.closest('button, input, select, .panel')) return;
    if (!locked && !absMode) { lockPointer(); return; }
    if (e.button === 0) g.boost = true;
    if (e.button === 2) look.free = true;
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) g.boost = false; if (e.button === 2) look.free = false; });
  window.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('wheel', e => { if (mode === 'play' && !paused) { const m = e.deltaY > 0 ? 'chase' : 'fp'; if (m !== camMode) { camMode = m; FLIGHT.beginBlend(); } } }, { passive: true });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mode === 'play') { if (paused) resume(); else pause(); }
    if ((e.key === 'c' || e.key === 'C') && mode === 'play') { camMode = camMode === 'fp' ? 'chase' : 'fp'; FLIGHT.beginBlend(); }
    if ((e.key === 'h' || e.key === 'H') && mode === 'play') { hudOn = !hudOn; $('hud').hidden = !hudOn || paused; }
    if (e.key === 'n' || e.key === 'N') skipTrack();
  });
  window.addEventListener('blur', () => { g.boost = false; look.free = false; pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); SOUND.suspend(); } else if (mode !== 'title' || SOUND.ready) SOUND.resume(); });

  // ── settings UI ──
  function syncSettings() {
    $('setSens').value = settings.sens; $('setFov').value = settings.fov; $('setVol').value = settings.vol;
    for (const [id, v] of [['setInvert', settings.invert], ['setMusic', settings.music], ['setVario', settings.vario], ['setFps', settings.fps], ['setAssist', settings.assists]]) {
      $(id).setAttribute('aria-pressed', v); $(id).textContent = v ? 'On' : 'Off';
    }
    document.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-pressed', b.dataset.q === settings.quality));
    document.querySelectorAll('[data-tod]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tod === settings.tod));
    document.querySelectorAll('[data-units]').forEach(b => b.setAttribute('aria-pressed', b.dataset.units === settings.units));
    document.querySelectorAll('[data-phys]').forEach(b => b.setAttribute('aria-pressed', b.dataset.phys === settings.physics));
    $('setTrack').value = settings.track;
    $('hSpdU').textContent = unit()[1];
  }
  function save() { store.set('windborne.settings', settings); }
  function applyAudio() { SOUND.setVolume(settings.vol / 100 * 0.9); SOUND.setMusic(settings.music); SOUND.setVario(settings.vario); }
  $('setSens').addEventListener('input', e => { settings.sens = +e.target.value; save(); });
  $('setFov').addEventListener('input', e => { settings.fov = +e.target.value; save(); });
  $('setVol').addEventListener('input', e => { settings.vol = +e.target.value; applyAudio(); save(); });
  for (const [id, key] of [['setInvert', 'invert'], ['setMusic', 'music'], ['setVario', 'vario'], ['setFps', 'fps']]) {
    $(id).addEventListener('click', () => { settings[key] = !settings[key]; applyAudio(); syncSettings(); save(); });
  }
  document.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { settings.quality = b.dataset.q; scale = maxScale(); resize(); syncSettings(); save(); }));
  document.querySelectorAll('[data-tod]').forEach(b => b.addEventListener('click', () => { settings.tod = b.dataset.tod; applyTod(); syncSettings(); save(); }));
  document.querySelectorAll('[data-units]').forEach(b => b.addEventListener('click', () => { settings.units = b.dataset.units; hudT = 1; syncSettings(); save(); }));
  const applyFlight = () => { if (mode === 'play') FLIGHT.setMode(settings.physics, settings.assists); };
  document.querySelectorAll('[data-phys]').forEach(b => b.addEventListener('click', () => { settings.physics = b.dataset.phys; applyFlight(); syncSettings(); save(); }));
  $('setAssist').addEventListener('click', () => { settings.assists = !settings.assists; applyFlight(); syncSettings(); save(); });

  // ── soundtrack ──
  const trackSel = $('setTrack');
  trackSel.innerHTML = '<option value="shuffle">Shuffle all</option>' + MUSIC.TRACKS.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  if (settings.track !== 'shuffle' && !MUSIC.TRACKS.some(t => t.id === settings.track)) settings.track = 'shuffle';
  MUSIC.choose(settings.track);
  trackSel.addEventListener('change', () => { settings.track = trackSel.value; MUSIC.choose(settings.track); save(); });
  function skipTrack() {
    if (!SOUND.ready) return;
    MUSIC.next();
    if (settings.track !== 'shuffle') { settings.track = MUSIC.current.id; trackSel.value = settings.track; save(); }
  }
  MUSIC.onTrack = name => {
    $('nowPlaying').textContent = name;
    if (mode === 'play' && !paused) note('♪ ' + name, 3.5);
  };
  $('btnSkip').addEventListener('click', skipTrack);
  $('btnSkip2').addEventListener('click', skipTrack);

  // ── HUD ──
  const hud = { spd: $('hSpd'), alt: $('hAlt'), vs: $('hVs'), vsArrow: $('hVsArrow'), breath: $('hBreath'), seeds: $('hSeeds'),
    note: $('hNote'), fps: $('hFps'), stickDot: $('stickDot'), stickRing: $('stickRing'), veil: $('veil') };
  let hudT = 0, fpsFrames = 0, fpsT = 0, fpsShown = 0, noteText = '', noteT = 0;
  function note(t, dur) { noteText = t; noteT = dur || 2.5; hud.note.textContent = t; hud.note.classList.add('on'); }
  function updateHud(dt) {
    hudT += dt; noteT -= dt;
    if (noteT <= 0 && hud.note.classList.contains('on')) hud.note.classList.remove('on');
    const R = absMode ? Math.min(cssW, cssH) * 0.32 : 60;
    hud.stickRing.style.width = hud.stickRing.style.height = (R * 2) + 'px';
    hud.stickDot.style.transform = `translate(${g.stick[0] * R}px, ${-g.stick[1] * R}px)`;
    hud.stickRing.style.opacity = look.free ? 0.1 : 0.25 + Math.min(1, Math.hypot(g.stick[0], g.stick[1]) * 2) * 0.45;
    if (hudT < 0.1) return;
    hudT = 0;
    hud.spd.textContent = Math.round(g.V * unit()[0]);
    hud.alt.textContent = Math.round(g.pos[1]);
    const vs = g.vario;
    hud.vs.textContent = (vs >= 0 ? '+' : '') + vs.toFixed(1);
    hud.vsArrow.dataset.dir = vs > 0.3 ? 'up' : vs < -0.3 ? 'down' : 'level';
    hud.breath.style.transform = `scaleX(${g.breath.toFixed(3)})`;
    hud.breath.parentElement.dataset.low = g.breath < 0.15;
    hud.seeds.textContent = seeds;
  }

  // ── render ──
  const proj = new Float32Array(16), view = new Float32Array(16), vpG = new Float32Array(16), projG = new Float32Array(16);
  const air = new Float32Array(3);
  const ctx = { dt: 0, time: 0, cam, g, env, vp: env.vp, drift, fp: false, mode };
  let last = performance.now();
  function loop(ts) { requestAnimationFrame(loop); frame(ts); }
  function frame(ts) {
    let dt = (ts - last) / 1000; last = ts;
    if (!(dt > 0)) dt = 1 / 240;
    adapt(dt);
    if (dt > 0.05) dt = 0.05;
    const t0 = performance.now();
    const running = !paused;

    if (running) {
      if (mode === 'title') FLIGHT.autopilot(dt);
      else { g.stick[0] = dz(stick[0]); g.stick[1] = dz(stick[1]); }
      FLIGHT.update(dt);
      env.time += dt;
      drift[0] += WORLD.WIND[0] * 0.6 * dt; drift[2] += WORLD.WIND[2] * 0.6 * dt;
    }
    // events
    if (g.events.crash !== lastCrash) {
      lastCrash = g.events.crash; SOUND.crash();
      if (mode === 'play') note('The wind caught you. Back to the sky…', 2.2);
    }
    if (g.events.respawn !== lastRespawn) { lastRespawn = g.events.respawn; FLIGHT.beginBlend(); }
    if (g.onGround && !wasGround && g.contactV > 1.5) { g.onWater ? SOUND.splash() : SOUND.thud(); }
    wasGround = g.onGround;
    if (g.onGround && running) {
      const sp = g.V;
      if (sp > 4 && Math.random() < 0.8) {
        for (let k = 0; k < 2; k++) SCENERY.emit(g.pos[0] + (Math.random() - 0.5) * 2, g.pos[1] - 0.4, g.pos[2] + (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 3 - g.vel[0] * 0.2, 1 + Math.random() * (g.onWater ? 5 : 2), (Math.random() - 0.5) * 3 - g.vel[2] * 0.2,
          g.onWater ? 0.9 : 0.7, g.onWater ? 0.5 : 0.35, g.onWater ? 1 : 3);
      }
      if (mode === 'play' && sp < 1 && noteT < 0) note('Landed. Hold left click to take off.', 3);
    } else if (g.agl < 3 && g.onWater === false && running && g.V > 10 && Math.random() < 0.3) {
      SCENERY.emit(g.pos[0], g.pos[1] - g.agl - 0.3, g.pos[2], (Math.random() - 0.5) * 2, 0.8, (Math.random() - 0.5) * 2, 0.6, 0.25, 3);
    }
    if (g.pos[1] < 10 && g.agl < 5 && !g.onGround && g.onWater && g.V > 12 && running && Math.random() < 0.9) {
      SCENERY.emit(g.pos[0] + (Math.random() - 0.5) * 3, 0.1, g.pos[2] + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 2 + Math.random() * 4 * (1 - g.agl / 5), (Math.random() - 0.5) * 4, 0.8, 0.45, 1);
    }
    const th = WORLD.info.thermal > 1.2;
    if (th && !thermalOn && mode === 'play') { SOUND.thermal(); note('Rising air', 1.6); }
    thermalOn = th;

    const aspect = canvas.width / canvas.height;
    FLIGHT.updateCamera(dt, mode === 'title' ? 'cine' : camMode, settings.fov, aspect);
    env.cam[0] = cam.pos[0]; env.cam[1] = cam.pos[1]; env.cam[2] = cam.pos[2];
    const fp = mode === 'play' && camMode === 'fp';
    M4.persp(proj, cam.fovY, aspect, fp ? 0.5 : 1.0, 26000);
    M4.view(view, cam.r, cam.u, cam.f);
    M4.mul(env.vp, proj, view);

    SCENERY.update(running ? dt : 0, cam, g, drift);
    ctx.dt = running ? dt : 0; ctx.time = env.time; ctx.fp = fp; ctx.mode = mode;
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].update) MODELS[i].update(ctx.dt, ctx);
    if (SCENERY.events.seeds) {
      for (let i = 0; i < SCENERY.events.seeds; i++) SOUND.seed();
      seeds += SCENERY.events.seeds; g.breath = Math.min(1, g.breath + 0.06 * SCENERY.events.seeds);
      if (seeds > bestSeeds) { bestSeeds = seeds; store.set('windborne.seeds', bestSeeds); }
    }
    if (running) WORLD.evict(g.pos[0], g.pos[2]);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    TERRAIN.draw(g, cam);
    SCENERY.drawOpaque();
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].drawOpaque) MODELS[i].drawOpaque(ctx);
    if (!fp) GLIDER.draw(g, cam, env.vp, false, g.jet);
    TERRAIN.drawWater(g);
    air[0] = g.air[0]; air[1] = g.air[1]; air[2] = g.air[2];
    SCENERY.drawTransparent(cam, g, air, drift, mode === 'play' ? clamp((g.V - 12) / 30, 0, 1) : 0);
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].drawTransparent) MODELS[i].drawTransparent(ctx);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    if (fp && g.crashT <= 0) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      M4.persp(projG, cam.fovY, aspect, 0.02, 60);
      M4.mul(vpG, projG, view);
      GLIDER.draw(g, cam, vpG, true, g.jet);
    }

    // veil: cloud whiteout + crash fade
    const want = Math.max(SCENERY.events.cloud * 0.85, g.crashT > 0 ? clamp((1.7 - g.crashT) / 0.8, 0, 1) : 0);
    veil += (want - veil) * (1 - Math.exp(-dt * (g.crashT > 0 ? 6 : 3)));
    hud.veil.style.opacity = veil.toFixed(3);

    SOUND.update({ V: g.V, agl: g.agl, jet: g.jet, climb: g.vario, beta: g.beta, cloud: SCENERY.events.cloud, active: mode === 'play' && !paused, ground: g.onGround });
    updateHud(dt);
    fpsFrames++; fpsT += (ts - (frame.prev || ts)) / 1000; frame.prev = ts;
    if (fpsT >= 0.5) {
      fpsShown = Math.round(fpsFrames / fpsT);
      const ms = performance.now() - t0;
      hud.fps.textContent = settings.fps ? `${fpsShown} fps · ${ms.toFixed(1)} ms cpu · ${Math.round((settings.quality === 'auto' ? scale : maxScale()) * 100)}% res` : '';
      fpsFrames = 0; fpsT = 0;
    }
  }
  $('bestSeeds').textContent = bestSeeds;
  syncSettings();
  setScreen('title');
  resize();
  requestAnimationFrame(t => { last = t; loop(t); });
  // debug hook: advance the sim by n frames of dt seconds
  window.WB = { FLIGHT, SCENERY, TERRAIN, settings, stick, get mode() { return mode; },
    step(n, dts) { for (let i = 0; i < n; i++) frame(last + dts * 1000); }, setCam(m) { camMode = m; } };
})();
