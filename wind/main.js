'use strict';
// ───────────────────────── Main: loop, input, HUD, menus, settings ─────────────────────────
(() => {
  const $ = id => document.getElementById(id);
  if (!GLX) { $('nogl').hidden = false; $('title').hidden = true; return; }
  const { gl, canvas, env } = GLX;
  const PROF = GLX.prof;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const settings = Object.assign({ sens: 1, invert: false, fov: 72, units: 'kmh', track: 'shuffle', physics: 'relaxed', assists: true, quality: '', res: 'auto', tod: 'afternoon', vol: 70, music: true, vario: true, fps: true },
    store.get('windborne.settings', {}));
  // metres per second → display unit
  const UNITS = { kmh: [3.6, 'KM/H'], mph: [2.23694, 'MPH'], kts: [1.94384, 'KTS'] };
  const unit = () => UNITS[settings.units] || UNITS.kmh;
  let bestSeeds = store.get('windborne.seeds', 0);

  // time of day: the sun's direction and the air (haze = aerosol density, ap = aerial-perspective distance scale);
  // everything else — sky, sun colour, ambient light — comes out of the atmosphere model
  const TOD = {
    morning: { sun: [0.78, 0.3, -0.55], haze: 2.4, ap: 1.7, ev: 0.1 },
    afternoon: { sun: [0.42, 0.64, -0.64], haze: 1.6, ap: 1.4, ev: 0 },
    dusk: { sun: [-0.74, 0.13, 0.66], haze: 1.6, ap: 1.5, ev: 0 },
  };
  let apScale = 1.4, evBias = 0;
  function applyTod() {
    const t = TOD[settings.tod] || TOD.afternoon;
    const l = Math.hypot(...t.sun);
    env.sun.set(t.sun.map(c => c / l));
    ATMOS.setHaze(t.haze); apScale = t.ap; evBias = t.ev;
  }
  applyTod();
  // scene lighting from the atmosphere (GPU readback, a frame or two behind), with a CPU estimate until it arrives
  function applyLight(camY) {
    const L = ATMOS.light;
    if (L.ready) { env.sunCol.set(L.sun); env.amb.set(L.amb); env.zen.set(L.zen); env.hor.set(L.hor); return; }
    const c = ATMOS.lighting(camY, env.sun);
    for (let k = 0; k < 3; k++) { env.sunCol[k] = c.sun[k] / Math.PI; env.amb[k] = c.sky[k] / Math.PI; env.zen[k] = env.amb[k] * 0.9; env.hor[k] = env.amb[k] * 1.3; }
  }
  // exposure follows the light with partial adaptation, so dusk still reads as dusk
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  function autoExposure() {
    const key = lum(env.sunCol) * Math.max(env.sun[1], 0.02) + lum(env.amb);
    return 0.95 * Math.pow(Math.max(key, 1e-3), -0.62) * Math.pow(2, evBias);
  }

  // ── quality presets ──
  // budget: the internal pixel count Auto resolution starts from (it then scales 55–100% to hold the refresh rate);
  // a Retina laptop would otherwise render 5–6 megapixels
  const PRESETS = {
    low: { msaa: 1, fxaa: true, budget: 1.25e6, terrainLod: 1.6, grass: false, detail: 0 },
    medium: { msaa: 2, fxaa: false, budget: 2.1e6, terrainLod: 1.25, grass: true, detail: 1 },
    high: { msaa: 4, fxaa: false, budget: 3.7e6, terrainLod: 1.0, grass: true, detail: 2 },
  };
  // first run: pick from the GPU (discrete → High, Apple silicon → Medium, other integrated / mobile → Low)
  function detectQuality() {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    if (/RTX|GTX (10[6-8]|16|9[78])|Radeon (RX|Pro) ?[5-9]\d{2,3}|RX [5-9]\d{3}|Arc A[57]|Quadro|Titan|Apple M\d (Pro|Max|Ultra)/i.test(r)) return 'high';
    if (/Apple|Radeon/i.test(r)) return 'medium';
    return 'low';
  }
  if (!PRESETS[settings.quality]) settings.quality = ({ balanced: 'medium', performance: 'low' })[settings.quality] || detectQuality();
  const preset = () => PRESETS[settings.quality] || PRESETS.medium;

  // ── sizing & adaptive resolution ──
  let cssW = 1, cssH = 1, scale = 1, lowT = 0, highT = 0, avgDt = 1 / 60, fastest = 1;
  const recent = new Float32Array(120); let ri = 0;
  // the canvas stays at display resolution; the scene renders at a scaled internal resolution and POST upscales it
  function resize() {
    cssW = canvas.clientWidth || 1; cssH = canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  const autoRes = () => settings.res === 'auto';
  // internal render scale relative to the canvas (display pixels)
  const renderScale = () => {
    if (!autoRes()) return +settings.res || 1;
    const fit = Math.min(1, Math.sqrt(preset().budget / Math.max(1, canvas.width * canvas.height)));
    return fit * scale;
  };
  const msaa = () => preset().msaa;
  const applyQuality = () => {
    const q = settings.quality, p = preset();
    SHADOW.preset = q; CLOUDS.preset = q; SHAFTS.preset = q; WATER.preset = q;
    SCENERY.gustRes = q === 'high' ? 512 : 256;
    if (typeof WINDFX !== 'undefined') WINDFX.level = { low: 0, medium: 1, high: 2 }[q];
    TERRAIN.lod = p.terrainLod; TERRAIN.detail = p.detail;
    POST.opts.fxaa = p.fxaa;
    for (const m of MODELS) if (m.DBG && 'grass' in m.DBG) m.DBG.grass = p.grass;
  };
  applyQuality();
  new ResizeObserver(resize).observe(canvas);
  const sorted = new Float32Array(120);
  function adapt(dt) {
    if (dt > 0.1) return;
    recent[ri] = dt; ri = (ri + 1) % recent.length;
    // the display's frame interval: a low percentile of recent frame times (the minimum is too jittery on fast displays)
    if (ri % 30 === 0) { sorted.set(recent); sorted.sort(); let k = 0; while (k < 119 && sorted[k] <= 0) k++; fastest = sorted[Math.min(119, k + 12)] || fastest; }
    avgDt += (dt - avgDt) * 0.05;
    if (!autoRes()) return;
    // hold the refresh rate, but never chase beyond ~144 fps: on 240–360 Hz displays that would just churn resolution
    const budget = Math.max(fastest, 1 / 144);
    if (avgDt > budget * 1.25) { lowT += dt; highT = 0; } else if (avgDt < budget * 1.06) { highT += dt; lowT = 0; } else { lowT = 0; highT = 0; }
    if (lowT > 1.0 && scale > 0.55) { scale = Math.max(0.55, scale - 0.08); lowT = 0; }
    if (highT > 5 && scale < 1) { scale = Math.min(1, scale + 0.04); highT = 0; }
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
  FLIGHT.spawn(start[0], start[1], start.length > 2 ? start[2] : bestDir, 130);
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
  const closeSettings = () => { $('settings').hidden = true; };
  $('btnDone').addEventListener('click', closeSettings);
  $('btnClose').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', e => { if (e.target === $('settings')) closeSettings(); }); // click outside the panel

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
    if (e.key === 'Escape' && !$('settings').hidden) { closeSettings(); return; }
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
    document.querySelectorAll('[data-res]').forEach(b => b.setAttribute('aria-pressed', b.dataset.res === String(settings.res)));
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
  document.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { settings.quality = b.dataset.q; scale = 1; applyQuality(); syncSettings(); save(); }));
  document.querySelectorAll('[data-res]').forEach(b => b.addEventListener('click', () => { settings.res = b.dataset.res; scale = 1; syncSettings(); save(); }));
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
  const proj = new Float32Array(16), view = new Float32Array(16), vpG = new Float32Array(16), projG = new Float32Array(16), invVP = new Float32Array(16);
  const air = new Float32Array(3);
  const ctx = { dt: 0, time: 0, cam, g, env, vp: env.vp, drift, fp: false, mode, shadow: -1 };
  // shadow casters for cascade i (env.vp is the cascade's matrix): terrain in the mid/far cascades, objects in the rest
  function drawCasters(i, info) {
    TERRAIN.drawShadow(cam, info.far ? 3 : 1); // every cascade: hills shadow what's near too; same LOD as the view, or coarse terrain shadows the fine
    if (info.far) return;
    ctx.shadow = i;
    for (let k = 0; k < MODELS.length; k++) if (MODELS[k].drawOpaque) MODELS[k].drawOpaque(ctx);
    if (info.near && mode === 'play') GLIDER.draw(g, cam, env.vp, false, 0);
    ctx.shadow = -1;
  }
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

    if (canvas.clientWidth !== cssW || canvas.clientHeight !== cssH) resize(); // in case the ResizeObserver hasn't fired
    const aspect = canvas.width / canvas.height;
    FLIGHT.updateCamera(dt, mode === 'title' ? 'cine' : camMode, settings.fov, aspect);
    env.cam[0] = cam.pos[0]; env.cam[1] = cam.pos[1]; env.cam[2] = cam.pos[2];
    const fp = mode === 'play' && camMode === 'fp';
    M4.persp(proj, cam.fovY, aspect, fp ? 0.5 : 1.0, 26000);
    M4.view(view, cam.r, cam.u, cam.f);
    M4.mul(env.vp, proj, view);
    M4.inv(invVP, env.vp);
    PROF.mark('atmos');
    ATMOS.update(cam.pos[1], env.sun, invVP);
    applyLight(cam.pos[1]);
    const rs = renderScale(), W = Math.max(1, Math.round(canvas.width * rs)), H = Math.max(1, Math.round(canvas.height * rs));
    env.atm[0] = 1 / W; env.atm[1] = 1 / H; env.atm[2] = apScale; env.atm[3] = ATMOS.state.camH;

    SCENERY.update(running ? dt : 0, cam, g, drift);
    ctx.dt = running ? dt : 0; ctx.time = env.time; ctx.fp = fp; ctx.mode = mode;
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].update) MODELS[i].update(ctx.dt, ctx);
    if (SCENERY.events.seeds) {
      for (let i = 0; i < SCENERY.events.seeds; i++) SOUND.seed();
      seeds += SCENERY.events.seeds; g.breath = Math.min(1, g.breath + 0.06 * SCENERY.events.seeds);
      if (seeds > bestSeeds) { bestSeeds = seeds; store.set('windborne.seeds', bestSeeds); }
    }
    if (running) WORLD.evict(g.pos[0], g.pos[2]);
    CLOUDS.buildMap(cam, SCENERY.puffs(), SCENERY.puffCount());

    PROF.mark('shadows');
    TERRAIN.beginFrame();
    SHADOW.render(cam, drawCasters);
    PROF.mark('waves');
    if (WATER.enabled && msaa() > 1) WATER.update(env.time);
    PROF.mark('terrain');
    POST.begin(W, H, msaa());
    gl.clear(gl.DEPTH_BUFFER_BIT);
    TERRAIN.draw(g, cam);
    PROF.mark('scenery');
    SCENERY.drawOpaque();
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].drawOpaque) { PROF.mark(MODELS[i].name); MODELS[i].drawOpaque(ctx); }
    PROF.mark('glider');
    if (!fp) GLIDER.draw(g, cam, env.vp, false, g.jet);
    PROF.mark('water');
    // the water reads the terrain below it from the depth buffer (resolved mid-frame; with MSAA off the depth texture
    // is the live attachment and can't be sampled, so Low keeps the simpler water)
    if (WATER.enabled && POST.targets.samples > 1) {
      // full water: needs the scene so far (colour + depth) as textures, and the clouds seen in the mirror
      POST.resolve(true);
      PROF.mark('waterMirror');
      const mirror = WATER.mirror && CLOUDS.volumetric ? CLOUDS.renderMirror(cam, W, H, drift) : null;
      POST.rebind();
      PROF.mark('waterDraw');
      WATER.draw(g, cam, POST.targets.color, POST.targets.depth, mirror, fp ? 0.5 : 1.0, 26000);
    } else TERRAIN.drawWater(g, cam, null, fp ? 0.5 : 1.0, 26000);
    if (CLOUDS.volumetric) {
      PROF.mark('clouds');
      POST.resolveDepth();
      if (CLOUDS.render(cam, POST.targets.depth, W, H, drift)) { POST.rebind(); CLOUDS.composite(); } else POST.rebind();
      if (SHAFTS.enabled) { // needs the depth resolved above
        PROF.mark('shafts');
        if (SHAFTS.render(POST.targets.depth, CLOUDS.texture, W, H, ATMOS.state.haze)) { POST.rebind(); SHAFTS.composite(); } else POST.rebind();
      }
    }
    PROF.mark('transparent');
    air[0] = g.air[0]; air[1] = g.air[1]; air[2] = g.air[2];
    SCENERY.drawTransparent(cam, g, air, drift, mode === 'play' ? clamp((g.V - 12) / 30, 0, 1) : 0);
    for (let i = 0; i < MODELS.length; i++) if (MODELS[i].drawTransparent) MODELS[i].drawTransparent(ctx);
    PROF.mark('fpGlider');
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    if (fp && g.crashT <= 0) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      M4.persp(projG, cam.fovY, aspect, 0.02, 60);
      M4.mul(vpG, projG, view);
      GLIDER.draw(g, cam, vpG, true, g.jet);
    }
    POST.opts.exposure = autoExposure();
    PROF.mark('post');
    POST.end(env.time);
    PROF.frame();

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
      hud.fps.textContent = settings.fps ? `${fpsShown} fps · ${ms.toFixed(1)} ms cpu · ${Math.round(renderScale() * 100)}% res` : '';
      fpsFrames = 0; fpsT = 0;
    }
  }
  $('bestSeeds').textContent = bestSeeds;
  syncSettings();
  setScreen('title');
  resize();
  requestAnimationFrame(t => { last = t; loop(t); });
  // debug hook: advance the sim by n frames of dt seconds
  window.WB = { FLIGHT, SCENERY, TERRAIN, POST, ATMOS, PROF, SHADOW, CLOUDS, SHAFTS, WATER, settings, stick, get mode() { return mode; }, applyTod,
    step(n, dts) { for (let i = 0; i < n; i++) frame(last + dts * 1000); }, setCam(m) { camMode = m; } };
})();
