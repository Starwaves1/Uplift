// Esc / pause test for ticket 27. Runs inside the headless page (tools/headless.py --js). No real pointer lock: a
// simulated browser stands in for Chrome's pointer-lock rules, taken from Chromium's source:
//  - the user's Esc releases the lock on key DOWN and on key UP (browser_view.cc registers both Esc key states;
//    ExclusiveAccessManager::HandleUserKeyEvent → PointerLockController::HandleUserPressedEscape); an Esc the browser
//    uses for that never reaches the page
//  - a lock request needs transient user activation (a click or a non-Esc key in the last 5 s; Esc gives none —
//    keyboard_event_manager.cc) and is refused for 1.25 s after the user escaped a lock (kEffectiveUserEscapeDuration),
//    unless the page itself released the last lock (last_unlocked_by_target)
const MODE = window.__ESC_MODE || 'fp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FC = { locked: false, el: null, lastEsc: -1e9, act: -1e9, byTarget: false, ipc: 8, ev: [] };
const now = () => performance.now();
Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return FC.locked ? FC.el : null; } });
const setLock = el => { FC.locked = !!el; FC.el = el; document.dispatchEvent(new Event('pointerlockchange')); };
Element.prototype.requestPointerLock = function () {
  const el = this;
  return new Promise((res, rej) => setTimeout(() => {
    if (FC.locked) return res();
    let why = null;
    if (!FC.byTarget) {
      if (now() - FC.act > 5000) why = 'needs a click or key first';
      else if (now() - FC.lastEsc < 1250) why = 'Esc cooldown';
    }
    if (why) { FC.ev.push('lock refused (' + why + ')'); document.dispatchEvent(new Event('pointerlockerror')); return rej(new DOMException(why, 'NotAllowedError')); }
    FC.ev.push('lock granted'); FC.byTarget = false; setLock(el); res();
  }, FC.ipc));
};
Document.prototype.exitPointerLock = function () { if (FC.locked) setTimeout(() => { FC.byTarget = true; FC.ev.push('page released lock'); setLock(null); }, FC.ipc); };
const kev = (type, key, code, repeat = false) => document.body.dispatchEvent(new KeyboardEvent(type, { key, code, repeat, bubbles: true, cancelable: true }));
const escEdge = (type, repeat = false) => {
  if (FC.locked) { FC.lastEsc = now(); FC.byTarget = false; FC.ev.push('browser took Esc ' + (type === 'keydown' ? 'down' : 'up') + ': lock released'); setLock(null); return; }
  kev(type, 'Escape', 'Escape', repeat);
};
const esc = async (hold = 90) => {
  escEdge('keydown'); const t = now();
  if (hold > 500) { await sleep(500); while (now() - t < hold) { escEdge('keydown', true); await sleep(33); } } else await sleep(hold);
  escEdge('keyup');
};
const key = async (k, code) => { FC.act = now(); kev('keydown', k, code); await sleep(60); kev('keyup', k, code); };
const click = async el => {
  el = el || GLX.canvas; FC.act = now();
  const o = { bubbles: true, cancelable: true, button: 0, clientX: innerWidth / 2, clientY: innerHeight / 2 };
  el.dispatchEvent(new MouseEvent('mousedown', o)); await sleep(40);
  el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o));
};
const $ = id => document.getElementById(id);
// what the player sees: screen, mouse captured or not, does the cursor steer, the HUD note
const steer = () => {
  if (FC.locked) return 'captured';
  if (document.body.dataset.mode !== 'play' || location.search.includes('fly')) return 'uncaptured';
  const s0 = WB.stick[0];
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: innerWidth - 5, clientY: innerHeight / 2 }));
  const moved = WB.stick[0] !== s0;
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: innerWidth / 2, clientY: innerHeight / 2 }));
  return moved ? 'uncaptured, CURSOR STEERS' : 'uncaptured, stick held';
};
const state = () => {
  const n = $('hNote'), note = n && n.classList.contains('on') ? n.textContent : '';
  const scr = document.body.dataset.mode + ($('settings').hidden ? '' : '+settings');
  return { scr, steer: steer(), note };
};
const out = []; let fails = 0;
const settle = async ms => { const t = now(); while (now() - t < ms) { await R.pump(1); await sleep(16); } };
const check = async (label, want, ms = 700) => {
  await settle(ms);
  const s = state(), ev = FC.ev.splice(0);
  const ok = want(s); if (!ok) fails++;
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} → ${s.scr}; ${s.steer}${s.note ? '; note "' + s.note + '"' : ''}${ev.length ? '   [browser: ' + ev.join(', ') + ']' : ''}`);
};
const inFlight = s => s.scr === 'play' && s.steer === 'captured';
const paused = s => s.scr === 'pause';
const flightNoMouse = s => s.scr === 'play' && !/CURSOR/.test(s.steer) && (s.steer === 'captured' || /Click/.test(s.note));

// start: title → Take flight (a click), in the chosen camera
if (WB.mode !== 'title') { $('btnTitle') && (escEdge('keydown'), escEdge('keyup'), await sleep(50), await click($('btnTitle'))); }
await click($('fly'));
if (MODE === 'chase') await key('c', 'KeyC');
await check(`take flight (${MODE})`, inFlight);
for (let i = 1; i <= 3; i++) {
  await key('w', 'KeyW'); await sleep(1500);             // flying with the keys
  await esc(); await check(`#${i} Esc in flight`, paused);
  await sleep(1800);                                       // a moment in the menu (past the 1.25 s cooldown)
  await esc(); await check(`#${i} Esc in pause menu`, inFlight);
}
await key('w', 'KeyW'); await esc(); await check('Esc in flight', paused);
await sleep(300); await esc(); await check('Esc again at once (within 1.25 s cooldown)', flightNoMouse);
await click(); await check('  then a click', inFlight);
await esc(); await check('Esc in flight', paused);
await sleep(6000); await esc(); await check('Esc after 6 s in the menu (no recent input)', flightNoMouse);
await click(); await check('  then a click', inFlight);
await key('w', 'KeyW'); await esc(); await check('Esc in flight', paused);
await sleep(1500); await click($('btnResume')); await check('Resume button', inFlight);
await esc(900); await check('Esc HELD 0.9 s in flight', paused);
await sleep(1500); await key('w', 'KeyW'); await esc(900); await check('Esc HELD 0.9 s in pause menu', inFlight, 900);
await key('w', 'KeyW'); await esc(); await check('Esc in flight', paused);
await click($('btnSettings2')); await check('open Settings from the pause menu', s => s.scr === 'pause+settings');
await sleep(1500); await key('w', 'KeyW'); await esc(); await check('Esc with Settings open', s => s.scr === 'pause');
await sleep(300); await key('w', 'KeyW'); await esc(); await check('Esc in pause menu', inFlight);
out.push(`${fails ? fails + ' FAILED' : 'all passed'} (${MODE})`);
return out.join('\n');
