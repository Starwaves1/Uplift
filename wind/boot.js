'use strict';
// ───────────────────────── Boot: load the island, then start the game ─────────────────────────
// The game's code sits in a <script type="text/plain" id="wb-game"> block; this loader fetches and decodes the island
// heightfield (island.bin, next to the page) first, so every module can sample the terrain synchronously.
// island.bin: 'WBIS', u32 version, u32 n, f32 size, f32 origin, f32 step (m), f32 offset (m), then zlib data: the
// low bytes then the high bytes of zig-zag coded residuals of a median-edge (LOCO-I) predictor over 0.1 m steps.
(async () => {
  const msg = document.getElementById('bootmsg');
  const say = t => { if (msg) msg.textContent = t; };
  async function loadIsland(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ': ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'WBIS') throw new Error('not an island file');
    const n = dv.getUint32(8, true), size = dv.getFloat32(12, true), origin = dv.getFloat32(16, true);
    const step = dv.getFloat32(20, true), offset = dv.getFloat32(24, true);
    say('Unpacking the island…');
    const planes = new Uint8Array(await new Response(new Blob([buf.subarray(28)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const N = n * n, q = new Int32Array(N), h = new Float32Array(N);
    const lo = planes, hiOff = N;
    for (let y = 0, i = 0; y < n; y++) {
      for (let x = 0; x < n; x++, i++) {
        const z = lo[i] | (lo[hiOff + i] << 8);
        const r = (z & 1) ? -((z + 1) >> 1) : (z >> 1);
        let p;
        if (y === 0) p = x === 0 ? 0 : q[i - 1];
        else if (x === 0) p = q[i - n];
        else {
          const a = q[i - 1], b = q[i - n], c = q[i - n - 1];
          const mx = a > b ? a : b, mn = a > b ? b : a;
          p = c >= mx ? mn : c <= mn ? mx : a + b - c;
        }
        q[i] = p + r;
        h[i] = q[i] * step + offset;
      }
    }
    return { n, size, origin, dx: size / n, h };
  }
  async function loadMaps(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ': ' + res.status);
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
  try {
    say('Loading the island…');
    const t0 = performance.now();
    // ?island=NAME loads an alternative island from islands/NAME/ (for comparing versions); default: next to the page
    const name = new URLSearchParams(location.search).get('island'), dir = name && /^[\w-]+$/.test(name) ? `islands/${name}/` : '';
    const [isl, maps] = await Promise.all([loadIsland(dir + 'island.bin'),
      loadMaps(dir + 'island_maps.bin').catch(() => loadMaps('island_maps.bin')).catch(e => { console.warn('island maps unavailable:', e); return null; })]);
    window.ISLAND_DATA = isl; window.ISLAND_MAPS = maps;
    console.log('island', window.ISLAND_DATA.n + '²', Math.round(performance.now() - t0) + ' ms');
  } catch (e) {
    console.warn('island data unavailable, using the procedural world:', e);
  }
  if (msg) msg.remove();
  const s = document.createElement('script');
  s.textContent = document.getElementById('wb-game').textContent;
  document.body.appendChild(s);
})();
