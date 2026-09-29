"""Iterate on the south-east causse and its gorge (causse.py): apply the pass to a finished island and render design
views — a grid map and a top-down of the region; obliques from the sea into the calanque, along the gorge from its head
(above and below the rims), over the causse toward the north escarpment, onto the escarpment from the lowland, and the
region from the south-east. Prints gorge cross-sections along the thalweg and any closed basins the pass has made.
With --post it also runs the pipeline's rain droplets and talus over the window, using the masks the pass hands on.

usage: python test_causse.py h.npy tag [--post] [--views a,b,...]
"""
import sys, os, time
import numpy as np
import torch
from scipy import ndimage
from PIL import Image, ImageDraw
import fields as fx
import passes, preview, detail, lem
import causse as cs
from paths import WORK

src, tag = sys.argv[1], sys.argv[2]
post = '--post' in sys.argv
only = set(sys.argv[sys.argv.index('--views') + 1].split(',')) if '--views' in sys.argv else None
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
t0 = time.time()
lap = lambda s: print(f'{s:34s} {time.time() - t0:7.1f}s', flush=True)
# preview renders through fixed /tmp paths: keep ours apart from other runs sharing the machine
_render = preview.render
TMP = f'/tmp/_cs{os.getpid()}_'
preview.render = lambda h, dx, path, **kw: _render(h, dx, path.replace('/tmp/_', TMP), **kw)

h_in = np.load(src).astype(np.float64)
N = h_in.shape[0]; dx = 64000 / N
h, info = cs.causse(h_in, dx)
lap(f'causse (bend radius ≥ {info["min_radius"]:.0f} m, {info["dolines"]} dolines)')
print('  tightest bends (m):', ', '.join(f'{k} {v:.0f}' for k, v in info['radii'].items()))
i0, i1, j0, j1 = info['window']
if post:
    q = max(i1 - i0, j1 - j0)                                       # the rain works on a square
    a0, b0 = min(i0, N - q), min(j0, N - q)
    Hc = torch.tensor(h[a0:a0 + q, b0:b0 + q], device=fx.dev, dtype=torch.float32)
    crop = lambda a: torch.tensor(np.asarray(a[a0:a0 + q, b0:b0 + q], np.float32), device=fx.dev)
    land = (Hc > 2).float()
    karst, hard, zone = crop(info['karst']), crop(info['hard']), crop(info['zone'])
    detail.droplets(Hc, dx, int(Hc.numel() * 0.8), spawn=land * (1 - 0.7 * karst) + 1e-4, life=64, inertia=0.3,
                    capacity=2.0, erode=0.08, deposit=0.03, evaporate=0.02, radius=3,
                    hardness=(0.5 * zone + 0.4 * hard).clamp(0, 0.9))
    detail.talus(Hc, dx, crop(info['talus_tan']), iters=30)
    h[a0:a0 + q, b0:b0 + q] = Hc.double().cpu().numpy()
    lap('droplets + talus')
    # then as finalize would: the inlets back to their designed floor, a gentle wave-cut coast on the tableland's
    # cliffs (no retreat in the inlets), the sea floor keeping the inlets and the plunge at the cliff foot
    cal = info['calanque'] > 0.5
    h = np.where(cal, np.minimum(h, info['keep']), h)
    rng = np.random.default_rng(5)
    style = 0.3 * info['coast_style'] * (1 - info['calanque'])
    h, _, stacks = passes.coast(h, dx, style, np.full_like(h, 250.0), rng, face=4.5, platform=-5.0, stacks=0)
    sea = passes.open_sea_mask(h)
    hb = passes.bathymetry(h, dx, fx.fbm(N, 20, 4, 91).double().cpu().numpy())
    h = np.where(sea, passes.softmin(hb, info['keep'], 4.0), hb)       # bathymetry(keep=...) as finalize will have it
    lap('calanque, coast, sea floor')
    lab, tab = passes.lakes(h, dx, lem)
    for lid, lv, area, (ya, xa, yb, xb) in tab:
        if ya < i1 and yb > i0 and xa < j1 and xb > j0:
            kf = info['karst'][ya:yb, xa:xb][lab[ya:yb, xa:xb] == lid].mean()
            print(f'  lake at ({(xa + xb) / 2 * dx / 1000:.1f}, {(ya + yb) / 2 * dx / 1000:.1f}) km: level {lv:.0f} m, '
                  f'{area / 1e6:.3f} km², karst {kf:.2f}')
np.save(f'{WORK}/h_{tag}.npy', h.astype(np.float32))

# ── gorge cross-sections along the thalweg ──
P, _ = passes.spline([(x * 1000, y * 1000) for x, y in cs.GORGE['pts']], (), step=5.0)
s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
t = np.gradient(P, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
nrm = np.stack([-t[:, 1], t[:, 0]], 1)
print('  km    x     y    floor  rimN  rimS  depth rim-rim  mid-w floorW  slope>2  maxslope')
off = np.arange(-1600, 1601, 5.0)
for k in np.searchsorted(s, np.arange(1200, s[-1] - 200, 600)):
    q = P[k][None] + off[:, None] * nrm[k][None]
    prof = ndimage.map_coordinates(h, [q[:, 1] / dx - 0.5, q[:, 0] / dx - 0.5], order=1)
    c = len(off) // 2
    zf = prof[c - 15:c + 16].min()
    ra, rb = prof[:c].max(), prof[c:].max()                     # rims: the highest ground within 1.6 km each side
    rim = min(ra, rb)

    def reach(z, side):
        seq = prof[c::side]; idx = np.nonzero(seq > z)[0]
        return idx[0] * 5.0 if len(idx) else np.nan
    rr = reach(rim - 30, 1) + reach(rim - 30, -1)
    mid = reach(zf + (rim - zf) / 2, 1) + reach(zf + (rim - zf) / 2, -1)
    fw = reach(zf + 8, 1) + reach(zf + 8, -1)
    sl = np.abs(np.diff(prof)) / 5.0
    inner = (np.abs(off[1:]) < rr / 2 + 50)
    print(f'{s[k] / 1000:5.1f} {P[k][0] / 1000:5.1f} {P[k][1] / 1000:5.1f} {zf:6.0f} {ra:5.0f} {rb:5.0f} {rim - zf:6.0f}'
          f' {rr:7.0f} {mid:6.0f} {fw:6.0f} {(sl[inner] > 2).mean() * 100:6.0f}% {sl[inner].max():7.1f}')

# ── closed basins the pass has made (would become lakes): priority-flood depth on the window, 4× coarser ──
def depth(hh):
    f4 = 4
    Hw = hh[i0:i1, j0:j1]; Hw = Hw[:Hw.shape[0] // f4 * f4, :Hw.shape[1] // f4 * f4]
    Hs = Hw.reshape(Hw.shape[0] // f4, f4, Hw.shape[1] // f4, f4).min((1, 3))
    m = Hs.shape; nq = max(m)
    Hq = np.full((nq, nq), 1e4); Hq[:m[0], :m[1]] = Hs
    fixed = np.ones((nq, nq), bool); fixed[1:m[0] - 1, 1:m[1] - 1] = False
    hf = lem.priority_flood(Hq.ravel().copy(), (fixed | (Hq <= 0)).ravel(), nq, 0.0).reshape(nq, nq)[:m[0], :m[1]]
    return hf - Hs, f4
dep, f4 = depth(h)
dep0, _ = depth(h_in)
kw = info['karst'][i0:i1, j0:j1][:dep.shape[0] * f4:f4, :dep.shape[1] * f4:f4]
lab, nl = ndimage.label((dep > 2) & (dep > dep0 + 2) & (kw < 0.5))
for k, sl_ in enumerate(ndimage.find_objects(lab), 1):
    msk = lab[sl_] == k
    area = msk.sum() * (dx * f4) ** 2
    if area > 2e4:
        yc, xc = [(a_.start + a_.stop) / 2 for a_ in sl_]
        print(f'  new closed basin at ({(j0 + xc * f4) * dx / 1000:.1f}, {(i0 + yc * f4) * dx / 1000:.1f}) km: '
              f'{area / 1e6:.2f} km², {dep[sl_][msk].max():.0f} m deep')
print(f'  filled by the pass: {info["filled"]:.2f} km²')
lap('checks')


# ── design map and top-down ──
def gridmap(x0, y0, x1, y1, out, ppk=80, cstep=50):
    c = h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
    img = Image.open(preview.render(c, dx, '/tmp/_gm.png')).convert('RGB')
    W, Hh = int((x1 - x0) * ppk), int((y1 - y0) * ppk)
    img = img.resize((W, Hh), Image.LANCZOS)
    cz = ndimage.zoom(c, (Hh / c.shape[0], W / c.shape[1]), order=1)
    band = np.floor(cz / cstep)
    edge = (band != np.roll(band, 1, 0)) | (band != np.roll(band, 1, 1))
    a = np.asarray(img).copy()
    a[edge & (cz > 0)] = (a[edge & (cz > 0)] * 0.6).astype(np.uint8)
    img = Image.fromarray(a); d = ImageDraw.Draw(img)
    for k in range(int(np.ceil(x0)), int(x1) + 1):
        X = (k - x0) * ppk; d.line([(X, 0), (X, Hh)], fill=(255, 255, 255) if k % 2 == 0 else (190, 190, 190), width=1)
        if k % 2 == 0:
            d.text((X + 2, 2), str(k), fill=(255, 255, 0))
    for k in range(int(np.ceil(y0)), int(y1) + 1):
        Y = (k - y0) * ppk; d.line([(0, Y), (W, Y)], fill=(255, 255, 255) if k % 2 == 0 else (190, 190, 190), width=1)
        if k % 2 == 0:
            d.text((2, Y + 2), str(k), fill=(255, 255, 0))
    px, py, pr = cs.PILLARS
    d.ellipse([((px - pr - x0) * ppk, (py - pr - y0) * ppk), ((px + pr - x0) * ppk, (py + pr - y0) * ppk)], outline=(255, 80, 200), width=2)
    img.save(out)


if only is None or 'grid' in only:
    gridmap(42, 33, 56, 43.5, f'{PRE}/{tag}_grid.png')
    # the masks handed on: zone (red), karst (blue), alluvial fill (yellow), calanque (cyan), floors (white), coast style (magenta)
    sl = (slice(int(33 * 1000 / dx), int(43.5 * 1000 / dx)), slice(int(42 * 1000 / dx), int(56 * 1000 / dx)))
    base = np.asarray(Image.open(preview.render(h[sl], dx, '/tmp/_mk.png')).convert('RGB')).astype(float) / 255 * 0.55
    for key, colr in [('karst', (0.2, 0.4, 1)), ('zone', (1, 0.15, 0.1)), ('coast_style', (1, 0.2, 1)),
                      ('calanque', (0, 1, 1)), ('fill', (1, 0.9, 0)), ('floor', (1, 1, 1))]:
        m_ = np.asarray(info[key][sl], float)[..., None] * 0.6
        base = base * (1 - m_) + np.array(colr) * m_
    Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8)).resize((1120, 840), Image.LANCZOS).save(f'{PRE}/{tag}_masks.png')
    c = h[int(31 * 1000 / dx):int(47 * 1000 / dx), int(40 * 1000 / dx):int(58 * 1000 / dx)]
    preview.render(c, dx, f'{PRE}/{tag}_top.png', size=1600)
    lap('maps')


def view(name, cam_km, cam_h, azim, elev, size_km=14.0, dist=0.5, fov=55):
    """Oblique from a camera at cam_km (x, y km), cam_h metres up, looking along azim (0 = north, 90 = east)."""
    if only is not None and name not in only:
        return
    a = np.radians(azim)
    fwd = np.array([np.sin(a), -np.cos(a)])
    cx, cy = np.array(cam_km) + fwd * size_km * dist               # the renderer's camera sits dist·size behind the centre
    k = int(size_km * 1000 / dx)
    ii, jj = int(round((cy - size_km / 2) * 1000 / dx)), int(round((cx - size_km / 2) * 1000 / dx))
    blk = np.full((k, k), -40.0)
    a0, a1, b0, b1 = max(ii, 0), min(ii + k, N), max(jj, 0), min(jj + k, N)
    blk[a0 - ii:a1 - ii, b0 - jj:b1 - jj] = h[a0:a1, b0:b1]
    alt = (cam_h - max(blk.max(), 0)) / (k * dx)
    preview.oblique(blk, dx, f'{PRE}/{tag}_{name}.png', azim=azim, elev=elev, dist=dist, alt=alt, fov=fov)


view('calanque', (56.6, 39.15), 220, 268, 3, size_km=9)          # (a) from the sea, into the calanque
view('gorge_hi', (44.0, 40.25), 950, 82, 13, size_km=11)         # (b) along the gorge from its head, above the rims
view('gorge_lo', (44.5, 40.05), 420, 80, 2, size_km=6)           # ... from the head basin, below the rims
view('causse', (49.0, 41.9), 900, 350, 9, size_km=12)            # (c) over the causse toward the north escarpment
view('basin', (46.6, 39.2), 720, 250, 9, size_km=6)              # the head basin (ticket 04's pillars) from its portal
view('loop', (49.2, 41.6), 1150, 355, 28, size_km=5)             # the abandoned meander and its core
view('cove', (49.6, 45.0), 240, 348, 3, size_km=8)              # the small calanque on the south coast, from the sea
view('inside', (50.9, 38.05), 330, 95, 2, size_km=5)            # down in the lower gorge, looking toward the sea
view('north', (48.5, 30.8), 650, 175, 5, size_km=12)             # the north escarpment from the lowland
view('overview', (57.5, 46.5), 2800, 308, 24, size_km=20)        # the region from the south-east
view('peak', (50.0, 30.2), 1100, 150, 8, size_km=9)             # where the causse meets the coastal peak
lap('obliques')
