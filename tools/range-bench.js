// View-range bench for the muted test build in a hidden tab (no requestAnimationFrame): frames are driven through
// WB.step, the GPU profiler (GLX.prof) times each pass, and frames can be saved through tools/shot_server.py.
//   await import('/tools/range-bench.js?v=' + Date.now())
//   await B.ready()                          wait for the game and its ground materials, take flight, fixed 100% res,
//                                            and (when present) the far forest filled in
//   views: open the page with ?fly&at=X,Y,HEADING,ALT (the spectator camera), one view per page load
//   await B.pump(n)                          run n frames, yielding to the browser between them
//   await B.measure(n)                       per-pass GPU ms (10th percentiles over the last 60 frames) + stats
//   await B.shot(name)                       render one frame and save it (shot server port: B.port, default 8793)
const B = window.B = { port: 8793 };
const tick = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
B.pump = async (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) { WB.step(1, dt); await tick(); } };
B.ready = async () => {
  const t0 = performance.now();
  while (typeof TERRAIN === 'undefined' && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 100));
  WB.settings.res = '1';
  await B.pump(10);
  const t1 = performance.now();
  while (!TERRAIN.materials && performance.now() - t1 < 20000) { await B.pump(3); await new Promise(r => setTimeout(r, 100)); }
  [...document.querySelectorAll('button')].find(b => /take flight/i.test(b.textContent))?.click();
  await B.pump(10);
  const ff = () => typeof FLORA !== 'undefined' && FLORA.stats().farForest;
  for (let i = 0; i < 900 && (i < 60 || (ff() && ff().queue > 0)); i++) await B.pump(1);
  await B.pump(30);
  return { materials: TERRAIN.materials, mode: document.body.dataset.mode, canvas: [GLX.canvas.width, GLX.canvas.height] };
};
// The GPU may be shared with other pages (other sessions' previews): timer queries then include time slices spent on
// their work, so each pass reports its 10th percentile over the last 60 frames (≈ its uncontended time), not the median.
const p10 = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * 0.1)] : 0; };
B.measure = async (n = 150) => {
  GLX.prof.on = true; GLX.prof.reset();
  await B.pump(n);
  const ms = Object.fromEntries(Object.entries(GLX.prof.samples).map(([k, v]) => [k, +p10(v).toFixed(3)]));
  ms.sum = +Object.values(ms).reduce((s, v) => s + v, 0).toFixed(3);
  const fl = typeof FLORA !== 'undefined' ? FLORA.stats() : null;
  return { total: +p10(GLX.prof.totals).toFixed(3), ms, nodes: TERRAIN.stats.nodes, shadowNodes: TERRAIN.stats.shadowNodes, cache: TERRAIN.cacheUsed,
    flora: fl, canvas: [GLX.canvas.width, GLX.canvas.height] };
};
// the few numbers worth comparing across builds
B.brief = m => ({ total: m.total, sum: m.ms.sum, terrain: m.ms.terrain, flora: m.ms.flora, shadows: m.ms.shadows, water: m.ms.waterDraw,
  nodes: m.nodes, shadowNodes: m.shadowNodes, cache: m.cache, canvas: m.canvas.join('x') });
B.shot = name => new Promise((res, rej) => {
  WB.step(1, 1 / 60);
  GLX.canvas.toBlob(b => b ? fetch(`http://127.0.0.1:${B.port}/shot?name=` + encodeURIComponent(name),
    { method: 'POST', body: b, headers: { 'Content-Type': 'image/png' } }).then(r => r.text()).then(res, rej) : rej('no frame'), 'image/png');
});
