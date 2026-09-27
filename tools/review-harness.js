// Review harness for the muted test build, when the page is hidden (no requestAnimationFrame) — e.g. an agent's
// background browser tab. Import it right after the page loads, before the game starts:
//   await import('/tools/review-harness.js?v=' + Date.now())
// It takes over requestAnimationFrame so frames run when pumped, and can save full-resolution frames through
// tools/shot_server.py (127.0.0.1:8791 → shots/<name>.png). tools/headless.py injects it into a headless Chrome for you
// (no window, no cursor) and saves R.shot frames itself: that is the way to use it (see tools/README.md).
//   await R.ready()                         wait for the game and its ground materials, take flight
//   await R.view(xkm, ykm, deg, agl)        spawn there (design-grid km, compass heading, m above ground) and settle
//   R.frame(dt) / await R.pump(n, dt)       run one frame now / n frames (dt in ms, default 16.7)
//   await R.shot(name)                      render one frame and save it
//   await R.pair(name, xkm, ykm, deg, agl)  the same view with the photo materials on and off (<name>_on / _off)
const R = window.R = {};
// never take the user's mouse: the game asks for pointer lock when it starts flying (takeFlight) — refuse it outright,
// so it falls back to steering by the (synthetic, in-page) mouse position; release any lock this page already holds.
// Nothing here moves the real cursor: R.centre() only dispatches a DOM event inside the page.
Element.prototype.requestPointerLock = function () { return Promise.reject(new Error('review harness: no pointer lock')); };
try { document.exitPointerLock(); } catch (e) {}
let q = [], t = performance.now();
window.requestAnimationFrame = cb => { q.push(cb); return q.length; };
const tick = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
// R.frame(dt): run one frame now, synchronously (a WebGL canvas can only be read back in the task that drew it)
R.frame = (dt = 16.7) => { const a = q; q = []; t += dt; for (const cb of a) cb(t); };
R.pump = async (n, dt = 16.7) => { for (let i = 0; i < n; i++) { R.frame(dt); await tick(); } };
R.ready = async () => {
  const t0 = performance.now();
  while (typeof TERRAIN === 'undefined' && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 100));
  await R.pump(20);
  const t1 = performance.now();
  while (!TERRAIN.materials && performance.now() - t1 < 20000) { await R.pump(3); await new Promise(r => setTimeout(r, 100)); }
  [...document.querySelectorAll('button')].find(b => /take flight/i.test(b.textContent))?.click();
  await R.pump(10);
  return { materials: TERRAIN.materials, mode: document.body.dataset.mode, stalled: q.length === 0 };
};
// without pointer lock (a hidden page never gets it) the game steers by the mouse's position: centre it = hands off
R.centre = () => window.dispatchEvent(new MouseEvent('mousemove', { clientX: innerWidth / 2, clientY: innerHeight / 2 }));
R.view = async (xk, yk, deg, agl, frames = 120) => {
  R.centre();
  FLIGHT.spawn(xk * 1000 - 32000, yk * 1000 - 32000, deg * Math.PI / 180, agl);
  FLIGHT.g.invuln = 99;
  await R.pump(frames);
  return Array.from(FLIGHT.g.pos).map(Math.round);
};
R.shot = name => new Promise((res, rej) => {
  R.frame(0.2);
  GLX.canvas.toBlob(b => b ? fetch('http://127.0.0.1:8791/shot?name=' + encodeURIComponent(name),
    { method: 'POST', body: b, headers: { 'Content-Type': 'image/png' } }).then(r => r.text()).then(res, rej) : rej('no frame'), 'image/png');
});
R.pair = async (name, xk, yk, deg, agl) => {
  await R.view(xk, yk, deg, agl);
  TERRAIN.materials = true; await R.pump(2, 0.2); const on = await R.shot(name + '_on');
  TERRAIN.materials = false; await R.pump(2, 0.2); const off = await R.shot(name + '_off');
  TERRAIN.materials = true;
  return [on, off];
};
