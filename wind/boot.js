'use strict';
// ───────────────────────── Boot: load the island, then start the game ─────────────────────────
// The game's code sits in a <script type="text/plain" id="wb-game"> block; this loader fetches and decodes the island
// heightfield (island.bin, next to the page) first, so every module can sample the terrain synchronously.
// island.bin: 'WBIS', u32 version, u32 n, f32 size, f32 origin, f32 step (m), f32 offset (m). Version 2 goes on with
// u32 parts, u32 body bytes, then one zlib stream cut into parts (island.bin, island-1.bin, … : the artifact takes files
// up to 15 MB): one byte per zig-zag coded residual of a planar predictor (west + north − north-west) over the heights in
// steps, row by row; 255 escapes to two more bytes (low, high). It's decoded as it downloads, straight into 16 bits a
// sample — no float copy of the island. Version 1 (older exports): median-edge predictor, low bytes then high bytes.
// → ISLAND_DATA { n, size, origin, dx, step, offset, q: Uint16Array (height = q·step + offset) }
(async () => {
  const msg = document.getElementById('bootmsg');
  const say = t => { if (msg) msg.textContent = t; };
  const get = async url => { const res = await fetch(url); if (!res.ok) throw new Error(url + ': ' + res.status); return res; };
  const inflate = (stream) => stream.pipeThrough(new DecompressionStream('deflate')).getReader();
  async function loadIsland(dir) {
    const reader = (await get(dir + 'island.bin')).body.getReader();
    let head = new Uint8Array(0);
    while (head.length < 36) { // the header, and whatever came with it
      const { done, value } = await reader.read();
      if (done) break;
      const t = new Uint8Array(head.length + value.length); t.set(head); t.set(value, head.length); head = t;
    }
    const dv = new DataView(head.buffer);
    if (head.length < 28 || String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'WBIS') throw new Error('not an island file');
    const ver = dv.getUint32(4, true), n = dv.getUint32(8, true), size = dv.getFloat32(12, true), origin = dv.getFloat32(16, true);
    const step = dv.getFloat32(20, true), offset = dv.getFloat32(24, true);
    const N = n * n, q = new Uint16Array(N);
    const out = { n, size, origin, dx: size / n, step, offset, q };
    if (ver === 1) {
      const rest = [head.subarray(28)];
      for (;;) { const { done, value } = await reader.read(); if (done) break; rest.push(value); }
      say('Unpacking the island…');
      const lo = new Uint8Array(await new Response(new Blob(rest).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
      for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
        const z = lo[i] | (lo[N + i] << 8), r = (z & 1) ? -((z + 1) >> 1) : (z >> 1);
        let p;
        if (y === 0) p = x === 0 ? 0 : q[i - 1];
        else if (x === 0) p = q[i - n];
        else { const a = q[i - 1], b = q[i - n], c = q[i - n - 1], mx = a > b ? a : b, mn = a > b ? b : a; p = c >= mx ? mn : c <= mn ? mx : a + b - c; }
        q[i] = p + r;
      }
      return out;
    }
    if (ver !== 2) throw new Error('island format ' + ver + ' is newer than this game');
    const parts = dv.getUint32(28, true);
    const more = []; // the continuation files download alongside the first
    for (let k = 1; k < parts; k++) { const p = get(dir + `island-${k}.bin`); p.catch(() => {}); more.push(p); } // (a failure surfaces when its turn comes)
    const body = new ReadableStream({
      async start(ctl) {
        if (head.length > 36) ctl.enqueue(head.subarray(36));
        let rd = reader;
        for (let k = 0; ; ) {
          const { done, value } = await rd.read();
          if (!done) { ctl.enqueue(value); continue; }
          if (k >= more.length) break;
          rd = (await more[k++]).body.getReader();
        }
        ctl.close();
      },
    });
    const src = inflate(body);
    let i = 0, x = 0, esc = 0, lo = 0, shown = -1;
    for (;;) {
      const { done, value } = await src.read();
      if (done) break;
      for (let k = 0, L = value.length; k < L; k++) {
        let z = value[k];
        if (esc) { if (esc === 1) { lo = z; esc = 2; continue; } z = lo | (z << 8); esc = 0; }
        else if (z === 255) { esc = 1; continue; }
        const r = (z & 1) ? -((z + 1) >> 1) : (z >> 1);
        q[i] = (i >= n ? (x ? q[i - 1] + q[i - n] - q[i - n - 1] : q[i - n]) : (x ? q[i - 1] : 0)) + r;
        i++; if (++x === n) x = 0;
      }
      const pc = Math.floor(i * 20 / N) * 5;
      if (pc !== shown) { shown = pc; say(`Unpacking the island… ${pc}%`); }
    }
    if (i !== N || esc) throw new Error(`island data ends early (${i} of ${N} samples)`);
    return out;
  }
  async function loadMaps(url) {
    const res = await get(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'WBIM') throw new Error('not an island map file');
    const dv = new DataView(buf.buffer);
    const ver = dv.getUint32(4, true), nm = dv.getUint32(8, true), nr = dv.getUint32(12, true);
    const nl = ver >= 2 ? dv.getUint32(16, true) : 0, jl = ver >= 2 ? dv.getUint32(20, true) : 0;
    const all = new Uint8Array(await new Response(new Blob([buf.subarray(ver >= 2 ? 24 : 16)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    let o = 0;
    const maps = all.subarray(o, o += nm * nm * 4), regions = all.subarray(o, o += nr * nr * 4);
    const lakeMask = nl ? all.subarray(o, o += nl * nl) : null;
    const lakes = jl ? JSON.parse(new TextDecoder().decode(all.subarray(o, o + jl))) : [];
    return { nm, maps, nr, regions, nl, lakeMask, lakes };
  }
  // island_light.bin (optional; island/bake_light.py): the baked sky visibility. 'WBIL', u32 version, u32 n, u32 channels,
  // f32 size, f32 origin, then deflate: each channel's n² bytes in turn (rows south, columns east), each stored as
  // (value − its median-edge prediction) mod 256. → ISLAND_LIGHT { n, ch, size, origin, data: n²·ch bytes, channels
  // interleaved }. Missing or unreadable → the terrain keeps its unbaked sky light.
  async function loadLight(url) {
    const buf = new Uint8Array(await (await get(url)).arrayBuffer());
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'WBIL') throw new Error('not an island light file');
    const dv = new DataView(buf.buffer);
    const ver = dv.getUint32(4, true), n = dv.getUint32(8, true), ch = dv.getUint32(12, true);
    if (ver !== 1 || ch < 1 || ch > 2) throw new Error(`island light v${ver} with ${ch} channels: not understood`);
    const size = dv.getFloat32(16, true), origin = dv.getFloat32(20, true), N = n * n;
    const r = new Uint8Array(await new Response(new Blob([buf.subarray(24)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    if (r.length !== N * ch) throw new Error('island light: truncated');
    const q = new Uint8Array(N), data = ch === 1 ? q : new Uint8Array(N * ch);
    for (let k = 0; k < ch; k++) {
      const o = k * N;
      for (let x = 0, p = 0; x < n; x++) { q[x] = (p + r[o + x]) & 255; p = q[x]; }
      for (let y = 1, i = n; y < n; y++) {
        q[i] = (q[i - n] + r[o + i]) & 255; i++;
        for (let x = 1; x < n; x++, i++) {
          const a = q[i - 1], b = q[i - n], c = q[i - n - 1];
          const mx = a > b ? a : b, mn = a > b ? b : a;
          q[i] = ((c >= mx ? mn : c <= mn ? mx : a + b - c) + r[o + i]) & 255;
        }
      }
      if (ch > 1) for (let i = 0, j = k; i < N; i++, j += ch) data[j] = q[i];
    }
    return { n, ch, size, origin, data };
  }
  try {
    say('Loading the island…');
    const t0 = performance.now();
    // ?island=NAME loads an alternative island from islands/NAME/ (for comparing versions); default: next to the page
    const name = new URLSearchParams(location.search).get('island'), dir = name && /^[\w-]+$/.test(name) ? `islands/${name}/` : '';
    const lightP = loadLight(dir + 'island_light.bin').then(L => { console.log('island light', L.n + '²', Math.round(performance.now() - t0) + ' ms'); return L; },
      e => { console.warn('island light unavailable, the terrain keeps its unbaked sky light:', e); return null; });
    const [isl, maps] = await Promise.all([loadIsland(dir),
      loadMaps(dir + 'island_maps.bin').catch(() => loadMaps('island_maps.bin')).catch(e => { console.warn('island maps unavailable:', e); return null; })]);
    window.ISLAND_DATA = isl; window.ISLAND_MAPS = maps;
    console.log('island', isl.n + '² (' + isl.dx.toFixed(2) + ' m)', Math.round(performance.now() - t0) + ' ms');
    // the baked light belongs to its own island: no falling back to the default island's (its valleys are elsewhere)
    window.ISLAND_LIGHT = await lightP;
  } catch (e) {
    console.warn('island data unavailable, using the procedural world:', e);
  }
  if (msg) msg.remove();
  const s = document.createElement('script');
  s.textContent = document.getElementById('wb-game').textContent;
  document.body.appendChild(s);
})();
