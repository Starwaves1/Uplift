// Video sim for ticket 27. Same simulated Chrome pointer-lock rules as esc-test.js (from Chromium's source):
//  - the user's Esc releases a lock on key DOWN and on key UP, and an Esc used for that never reaches the page
//  - a lock request needs a click or non-Esc key in the last 5 s, and is refused for 1.25 s after the user escaped
//    a lock (unless the page released the last lock itself)
// Plus an on-screen panel: screen, mouse state, last key, what the browser did, and a caption.
const LABEL = window.__SIM_LABEL || '', GOOD = !!window.__SIM_GOOD;
const now = () => performance.now();
const FC = { locked: false, el: null, lastEsc: -1e9, act: -1e9, byTarget: false, msg: '', msgT: -1e9, key: '', keyT: -1e9 };
const say = m => { FC.msg = m; FC.msgT = now(); };
Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return FC.locked ? FC.el : null; } });
const setLock = el => { FC.locked = !!el; FC.el = el; document.dispatchEvent(new Event('pointerlockchange')); };
Element.prototype.requestPointerLock = function () {
  const el = this;
  return new Promise((res, rej) => setTimeout(() => {
    if (FC.locked) return res();
    let why = null;
    if (!FC.byTarget) {
      if (now() - FC.act > 5000) why = 'no click or key in the last 5 s';
      else if (now() - FC.lastEsc < 1250) why = 'within 1.25 s of an Esc';
    }
    if (why) { say('refused the mouse (' + why + ')'); document.dispatchEvent(new Event('pointerlockerror')); return rej(new DOMException(why, 'NotAllowedError')); }
    say('game asked for the mouse: captured'); FC.byTarget = false; setLock(el); res();
  }, 8));
};
Document.prototype.exitPointerLock = function () { if (FC.locked) setTimeout(() => { FC.byTarget = true; setLock(null); }, 8); };
const kev = (type, key, code) => document.body.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
const escEdge = type => {
  const edge = type === 'keydown' ? 'down' : 'up';
  FC.key = 'Esc ' + (edge === 'down' ? '↓ pressed' : '↑ released'); FC.keyT = now();
  if (FC.locked) { FC.lastEsc = now(); FC.byTarget = false; say('took Esc ' + edge + ': released the mouse (game never sees this key)'); setLock(null); return; }
  kev(type, 'Escape', 'Escape');
};
const $ = id => document.getElementById(id);
const SIM = window.SIM = {
  esc() { escEdge('keydown'); setTimeout(() => escEdge('keyup'), 90); },
  key(k, code) { FC.act = now(); FC.key = k.toUpperCase(); FC.keyT = now(); kev('keydown', k, code); setTimeout(() => kev('keyup', k, code), 60); },
  click(el) {
    el = el || GLX.canvas; FC.act = now(); FC.key = 'mouse click'; FC.keyT = now();
    const o = { bubbles: true, cancelable: true, button: 0, clientX: innerWidth / 2, clientY: innerHeight / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    setTimeout(() => { el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); }, 40);
  },
  caption(t) { cap.textContent = t; },
  steer() {
    if (FC.locked) return ['captured', '#7ee07e'];
    if (document.body.dataset.mode !== 'play') return ['free', '#cfd8df'];
    const s0 = WB.stick[0];
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: innerWidth - 5, clientY: innerHeight / 2 }));
    const moved = WB.stick[0] !== s0;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: innerWidth / 2, clientY: innerHeight / 2 }));
    return moved ? ['free — the cursor steers the glider', '#ff9a4a'] : ['free — controls held until a click', '#ffd24a'];
  },
  update() {
    const m = document.body.dataset.mode, set = !$('settings').hidden;
    const scr = m === 'play' ? ['FLYING', '#7ee07e'] : m === 'pause' ? ['PAUSE MENU' + (set ? ' + SETTINGS' : ''), '#ff6b6b'] : [m.toUpperCase(), '#cfd8df'];
    const [ms, mc] = SIM.steer();
    rows.scr.innerHTML = `Screen: <b style="color:${scr[1]}">${scr[0]}</b>`;
    rows.mouse.innerHTML = `Mouse: <b style="color:${mc}">${ms}</b>`;
    rows.key.innerHTML = `Input: <b style="color:#fff">${now() - FC.keyT < 700 ? FC.key : ''}</b>`;
    rows.msg.innerHTML = `Browser: <span style="color:#bcd">${now() - FC.msgT < 2500 ? FC.msg : ''}</span>`;
  },
};
// the panel
const css = (el, s) => (el.style.cssText = s, el);
const panel = css(document.createElement('div'), 'position:fixed;left:6px;top:6px;z-index:2147483647;background:rgba(8,12,16,.78);' +
  'color:#cfd8df;font:600 13px/1.35 system-ui,Segoe UI,sans-serif;padding:7px 10px;border-radius:8px;width:236px;pointer-events:none');
const title = css(document.createElement('div'), `font:800 16px system-ui,Segoe UI,sans-serif;color:${GOOD ? '#7ee07e' : '#ff6b6b'};margin-bottom:3px`);
title.textContent = LABEL; panel.appendChild(title);
const rows = {};
for (const k of ['scr', 'mouse', 'key', 'msg']) panel.appendChild(rows[k] = document.createElement('div'));
const cap = css(document.createElement('div'), 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(8,12,16,.82);' +
  'color:#fff;font:700 17px system-ui,Segoe UI,sans-serif;text-align:center;padding:9px 8px;pointer-events:none');
document.body.append(panel, cap);
SIM.update();
