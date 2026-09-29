"""Iterate on the south-east causse and its gorge: apply plateau.plateau to a finished island and render design views —
a grid map of the region, a top-down, and obliques from the sea into the calanque, along the gorge from its head (above
and below the rims), and over the causse toward the escarpment. Prints gorge cross-sections (depth, rim-to-rim, floor,
wall slope) along the thalweg. With --post it also runs the pipeline's rain droplets and talus over the region, with the
masks the pass hands on, to see what survives them.

usage: python test_plateau.py h.npy tag [--post | --post-default] [--vox] [--views a,b,...]
  --post          droplets + talus as finalize would run them with the pass's masks, then plateau.drain()
  --post-default  the same droplets + talus without the masks (today's plateau talus tan 0.9), for comparison
"""
import sys, os, time
import numpy as np
import torch
from scipy import ndimage
import fields as fx
import passes, preview, detail
import plateau as pl
from paths import WORK

src, tag = sys.argv[1], sys.argv[2]
post = '--post' in sys.argv or '--post-default' in sys.argv
masked = '--post' in sys.argv
only = set(sys.argv[sys.argv.index('--views') + 1].split(',')) if '--views' in sys.argv else None
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
t0 = time.time()
lap = lambda s: print(f'{s:28s} {time.time() - t0:7.1f}s', flush=True)

# oblique() and gridmap render through fixed /tmp paths: keep ours apart from other runs sharing the machine
_render = preview.render
preview.render = lambda h, dx, path, **kw: _render(h, dx, path.replace('/tmp/_', f'/tmp/_pl{os.getpid()}_'), **kw)

h = np.load(src).astype(np.float64)
N = h.shape[0]; dx = 64000 / N
h, info = pl.plateau(h, dx)
lap(f'plateau (min bend radius {info["min_radius"]:.0f} m)')
i0, i1, j0, j1 = info['window']
if post:
    # the pipeline's rain and talus over the window, with the masks the pass hands on (as finalize would use them)
    Hc = torch.tensor(h[i0:i1, j0:j1], device=fx.dev, dtype=torch.float32)
    crop = lambda a: torch.tensor(np.asarray(a[i0:i1, j0:j1], np.float32), device=fx.dev)
    land = (Hc > 2).float()
    karst, hard = crop(info['karst']), crop(info['hard'])
    if not masked:
        karst, hard = karst * 0, hard * 0
    detail.droplets(Hc, dx, int(Hc.numel() * 0.8), spawn=land * (1 - 0.7 * karst) + 1e-4, life=64, inertia=0.3,
                    capacity=2.0, erode=0.08, deposit=0.03, evaporate=0.02, radius=3, hardness=(0.85 * hard).clamp(0, 0.9))
    detail.talus(Hc, dx, crop(info['talus_tan']) if masked else 0.9, iters=30)
    h[i0:i1, j0:j1] = Hc.double().cpu().numpy()
    if masked:
        h = pl.drain(h, dx, info)
    lap('droplets + talus')
np.save(f'{WORK}/h_{tag}.npy', h.astype(np.float32))

# ── gorge cross-sections along the thalweg ──
P, s, fl, wd, kap = pl.gorge_line(dx)
t = np.gradient(P, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
nrm = np.stack([-t[:, 1], t[:, 0]], 1)
print(' km along  x     y     floor  level  depth  rim-rim  floorW  W@+200  maxslope  radius')
off = np.arange(-1800, 1801, 5.0)
for k in np.searchsorted(s, np.arange(1500, s[-1] - 300, 700)):
    q = P[k][None] + off[:, None] * nrm[k][None]
    prof = ndimage.map_coordinates(h, [q[:, 1] / dx - 0.5, q[:, 0] / dx - 0.5], order=1)
    c = len(off) // 2
    zf = prof[c - 20:c + 21].min()
    level = np.median(np.concatenate([prof[:60], prof[-60:]]))
    def reach(side):
        seq = prof[c::side]
        idx = np.nonzero(seq > level - 25)[0]
        return idx[0] * 5.0 if len(idx) else np.nan
    fw = (prof < zf + 6).sum() * 5.0
    w200 = (prof[c - 300:c + 301] < zf + 200).sum() * 5.0
    sl = np.abs(np.diff(prof)).max() / 5.0
    r = 1 / max(abs(kap[k]), 1e-6)
    print(f'{s[k] / 1000:7.1f}  {P[k][0] / 1000:5.1f} {P[k][1] / 1000:5.1f}  {zf:6.0f} {level:6.0f} {level - zf:6.0f}'
          f'  {reach(1) + reach(-1):7.0f}  {fw:6.0f}  {w200:6.0f}  {sl:7.1f}  {min(r, 9999):6.0f}')

# ── the east coast: the causse's sea cliffs (face = highest point within 250 m of the shore; top within 1.2 km) ──
sea_ = h <= 0
print(' east coast   y    shore x   face(250 m)  top(1.2 km)')
for yk in np.arange(34.0, 41.6, 0.5):
    row = int(yk * 1000 / dx)
    js = np.nonzero(sea_[row, int(50000 / dx):int(57000 / dx)])[0]    # the first sea cell going east from the causse
    if not len(js):
        continue
    jx = int(50000 / dx) + js[0] - 1
    print(f'           {yk:5.1f}   {jx * dx / 1000:6.2f}   {h[row, jx - int(250 / dx):jx + 1].max():8.0f}   {h[row, jx - int(1200 / dx):jx + 1].max():9.0f}')

# ── would-be lakes: closed basins the pipeline's lakes pass would fill, outside the dolines ──
import lem
Hc = h[i0:i1, j0:j1].astype(np.float64); m = Hc.shape[0]
fixedc = ((Hc <= 0) | np.pad(np.zeros((m - 2, m - 2), bool), 1, constant_values=True)).ravel()
dep = lem.priority_flood(Hc.ravel(), fixedc, m, 0.0).reshape(m, m) - Hc
wet = (dep > 0.05) & (Hc > -1)
labw, nw = ndimage.label(wet)
lakes = np.zeros_like(wet)
rows = []
for k, sl in enumerate(ndimage.find_objects(labw), start=1):
    mk = labw[sl] == k
    area = mk.sum() * dx * dx; dmax = dep[sl][mk].max()
    if area >= 4e4 and dmax >= 1.2:
        lakes[sl] |= mk
        cy_, cx_ = [int(np.mean(a)) for a in np.nonzero(mk)]
        kz = float(info['karst'][i0 + sl[0].start + cy_, j0 + sl[1].start + cx_])
        rows.append(((j0 + sl[1].start + cx_) * dx / 1000, (i0 + sl[0].start + cy_) * dx / 1000, area / 1e4, dmax, kz))
print(f'would-be lakes in the window: {len(rows)}')
for r_ in sorted(rows, key=lambda r_: -r_[2])[:12]:
    print(f'   at ({r_[0]:5.1f},{r_[1]:5.1f})  {r_[2]:6.1f} ha  depth {r_[3]:5.1f} m  karst {r_[4]:.2f}')

# ── design map and top-down ──
def gridmap(x0, y0, x1, y1, out, ppk=80, cstep=50, wet=None):
    from PIL import Image, ImageDraw
    c = h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
    img = Image.open(preview.render(c, dx, '/tmp/_gm.png')).convert('RGB')
    W, Hh = int((x1 - x0) * ppk), int((y1 - y0) * ppk)
    img = img.resize((W, Hh), Image.LANCZOS)
    cz = ndimage.zoom(c, (Hh / c.shape[0], W / c.shape[1]), order=1)
    band = np.floor(cz / cstep)
    edge = (band != np.roll(band, 1, 0)) | (band != np.roll(band, 1, 1))
    a = np.asarray(img).copy()
    a[edge & (cz > 0)] = (a[edge & (cz > 0)] * 0.55).astype(np.uint8)
    if wet is not None:                                            # would-be lakes in magenta
        wz = ndimage.zoom(wet[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)].astype(float),
                          (Hh / c.shape[0], W / c.shape[1]), order=0) > 0.5
        a[wz] = (a[wz] * 0.4 + np.array([220, 40, 200]) * 0.6).astype(np.uint8)
    img = Image.fromarray(a); d = ImageDraw.Draw(img)
    for k in range(int(np.ceil(x0)), int(x1) + 1):
        X = (k - x0) * ppk; d.line([(X, 0), (X, Hh)], fill=(255, 255, 255) if k % 2 == 0 else (190, 190, 190), width=1)
        if k % 2 == 0: d.text((X + 2, 2), str(k), fill=(255, 255, 0))
    for k in range(int(np.ceil(y0)), int(y1) + 1):
        Y = (k - y0) * ppk; d.line([(0, Y), (W, Y)], fill=(255, 255, 255) if k % 2 == 0 else (190, 190, 190), width=1)
        if k % 2 == 0: d.text((2, Y + 2), str(k), fill=(255, 255, 0))
    px, py = pl.PILLARS['c']; r = pl.PILLARS['r'] * ppk
    d.ellipse([((px - x0) * ppk - r, (py - y0) * ppk - r), ((px - x0) * ppk + r, (py - y0) * ppk + r)], outline=(255, 80, 200), width=2)
    img.save(out)


if only is None or 'masks' in only:                               # the masks handed to the pipeline, as colours
    from PIL import Image
    sl = (slice(int(33 * 1000 / dx), int(44 * 1000 / dx)), slice(int(42 * 1000 / dx), int(56 * 1000 / dx)))
    base = np.asarray(Image.open(preview.render(h[sl], dx, '/tmp/_mk.png'))).astype(float) / 255 * 0.55
    col = base.copy()
    shore = ndimage.distance_transform_edt(h[sl] > 0) * dx < 700     # the coast mask only matters along the shore
    for m_, c_ in (((info['coast'][sl] < 0.5) & shore & (h[sl] > 0), (0.9, 0.2, 0.2)), (info['karst'][sl] > 0.5, (0.2, 0.7, 0.2)),
                   (info['hard'][sl] > 0.5, (0.95, 0.9, 0.75)), (info['floor'][sl], (0.2, 0.5, 1.0)),
                   (info['keep'][sl] < 1e8, (0.0, 0.9, 0.9))):
        col[m_] = col[m_] * 0.35 + np.array(c_) * 0.65
    Image.fromarray((col * 255).astype(np.uint8)).resize((1120, 880), Image.LANCZOS).save(f'{PRE}/{tag}_masks.png')

if only is None or 'grid' in only:
    wetf = np.zeros(h.shape, bool); wetf[i0:i1, j0:j1] = lakes
    gridmap(42, 33, 56, 44, f'{PRE}/{tag}_grid.png', wet=wetf)
    gridmap(42.5, 32.5, 48.5, 44.5, f'{PRE}/{tag}_west.png', ppk=100, cstep=25, wet=wetf)
    c = lambda x0, y0, x1, y1: h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
    preview.render(c(40, 31, 58, 47), dx, f'{PRE}/{tag}_top.png', size=1600)
    lap('maps')


def view(name, cam_km, cam_h, azim, elev, size_km=14.0, dist=0.5, fov=55):
    """Oblique from a camera at cam_km (x, y km) and cam_h metres, looking along azim (0 = north, 90 = east)."""
    if only is not None and name not in only:
        return
    a = np.radians(azim)
    fwd = np.array([np.sin(a), -np.cos(a)])
    cx, cy = np.array(cam_km) + fwd * size_km * dist                 # centre of the crop the renderer marches over
    x0, y0 = cx - size_km / 2, cy - size_km / 2
    k = int(size_km * 1000 / dx)
    ii, jj = int(round(y0 * 1000 / dx)), int(round(x0 * 1000 / dx))
    blk = np.full((k, k), -40.0)
    a0, a1, b0, b1 = max(ii, 0), min(ii + k, N), max(jj, 0), min(jj + k, N)
    blk[a0 - ii:a1 - ii, b0 - jj:b1 - jj] = h[a0:a1, b0:b1]
    alt = (cam_h / dx - max(blk.max(), 0) / dx) / k
    preview.oblique(blk, dx, f'{PRE}/{tag}_{name}.png', azim=azim, elev=elev, dist=dist, alt=alt, fov=fov)


_G = {}


def look(name, cam_km, cam_h, azim, elev, fov=62, W=1600, Hp=900, far=26000.0, sun=(215, 36)):
    """A proper perspective render for judging the walls up close: per-pixel ray march over the bilinear heightfield,
    sun shadows, pale limestone where it's steep, dry garrigue on the flats, water below sea level, haze.
    cam_km (x, y km), cam_h m; azim: view direction (0 = north, 90 = east); elev: degrees below the horizon."""
    if only is not None and name not in only:
        return
    dev = fx.dev
    if not _G:
        Ht = torch.tensor(h, device=dev, dtype=torch.float32)
        gy, gx = torch.gradient(Ht, spacing=dx)
        _G.update(H=Ht, gx=gx, gy=gy, var=fx.fbm(N, 260, 3, 991), var2=fx.fbm(N, 40, 3, 992))
    H, GX, GY = _G['H'], _G['gx'], _G['gy']

    def samp(A, x, y, fill=0.0):
        fxp = (x / dx - 0.5).clamp(0, N - 1.001); fyp = (y / dx - 0.5).clamp(0, N - 1.001)
        ix = fxp.floor().long(); iy = fyp.floor().long(); ax = fxp - ix; ay = fyp - iy
        v = (A[iy, ix] * (1 - ax) * (1 - ay) + A[iy, ix + 1] * ax * (1 - ay) + A[iy + 1, ix] * (1 - ax) * ay
             + A[iy + 1, ix + 1] * ax * ay)
        out = (x < 0) | (x > N * dx) | (y < 0) | (y > N * dx)
        return torch.where(out, torch.full_like(v, fill), v)

    a, p = np.radians(azim), -np.radians(elev)
    fwd = torch.tensor([np.sin(a) * np.cos(p), -np.cos(a) * np.cos(p), np.sin(p)], device=dev, dtype=torch.float32)
    right = torch.tensor([np.cos(a), np.sin(a), 0.0], device=dev, dtype=torch.float32)
    up = torch.linalg.cross(fwd, right)
    tx = np.tan(np.radians(fov) / 2); ty = tx * Hp / W
    u = ((torch.arange(W, device=dev) + 0.5) / W * 2 - 1) * tx
    v = ((torch.arange(Hp, device=dev) + 0.5) / Hp * 2 - 1) * ty
    d = fwd[None, None] + right[None, None] * u[None, :, None] - up[None, None] * v[:, None, None]
    d = (d / d.norm(dim=-1, keepdim=True)).reshape(-1, 3)
    o = torch.tensor([cam_km[0] * 1000, cam_km[1] * 1000, cam_h], device=dev, dtype=torch.float32)
    n = d.shape[0]
    t = torch.full((n,), 2.0, device=dev); hit = torch.zeros(n, dtype=torch.bool, device=dev)
    tlo = t.clone(); thi = t.clone()
    Hs = H.clamp(min=0)
    while True:
        act = ~hit & (t < far)
        if not bool(act.any()):
            break
        step = torch.clamp(t * 0.003, min=0.4 * dx)
        tn = t + step
        q = o[None] + d * tn[:, None]
        below = act & (q[:, 2] < samp(Hs, q[:, 0], q[:, 1]))
        tlo = torch.where(below, t, tlo); thi = torch.where(below, tn, thi)
        hit |= below
        t = torch.where(act & ~below, tn, t)
    for _ in range(10):                                            # refine the crossing
        tm = (tlo + thi) / 2
        q = o[None] + d * tm[:, None]
        b = q[:, 2] < samp(Hs, q[:, 0], q[:, 1])
        thi = torch.where(b, tm, thi); tlo = torch.where(b, tlo, tm)
    t = thi
    q = o[None] + d * t[:, None]
    hz = samp(H, q[:, 0], q[:, 1], -40.0)
    gx, gy = samp(GX, q[:, 0], q[:, 1]), samp(GY, q[:, 0], q[:, 1])
    nrm = torch.stack([-gx, -gy, torch.ones_like(gx)], 1); nrm = nrm / nrm.norm(dim=1, keepdim=True)
    sa, se = np.radians(sun[0]), np.radians(sun[1])
    L = torch.tensor([np.sin(sa) * np.cos(se), -np.cos(sa) * np.cos(se), np.sin(se)], device=dev, dtype=torch.float32)
    # shadows: march toward the sun
    lit = torch.ones(n, device=dev)
    s = torch.full((n,), 4.0, device=dev)
    q0 = q + nrm * 1.5
    for _ in range(90):
        qs = q0 + L[None] * s[:, None]
        blk = qs[:, 2] < samp(Hs, qs[:, 0], qs[:, 1]) - 0.5
        lit = torch.where(blk, torch.zeros_like(lit), lit)
        s = s + torch.clamp(s * 0.06, min=6.0)
    water = hz < 0.0
    slope = torch.sqrt(gx * gx + gy * gy)
    rock = ((slope - 0.65) / 0.6).clamp(0, 1)
    var = samp(_G['var'], q[:, 0], q[:, 1]); var2 = samp(_G['var2'], q[:, 0], q[:, 1])
    dry = torch.tensor([0.64, 0.59, 0.43], device=dev); scrub = torch.tensor([0.36, 0.41, 0.25], device=dev)
    lime = torch.tensor([0.86, 0.83, 0.75], device=dev)
    veg = dry[None] + (scrub - dry)[None] * (0.5 + 0.35 * var + 0.2 * var2).clamp(0, 1)[:, None]
    band = (0.96 + 0.04 * torch.sin(hz / 11.0 + 2 * var))[:, None]
    alb = veg * (1 - rock[:, None]) + lime[None] * band * rock[:, None]
    diff = (nrm @ L).clamp(min=0) * lit
    sky = 0.32 + 0.18 * nrm[:, 2]
    col = alb * (1.05 * diff + sky)[:, None] * torch.tensor([1.0, 0.98, 0.93], device=dev)[None]
    depth = (-hz).clamp(min=0)
    wcol = torch.tensor([0.07, 0.26, 0.33], device=dev)[None] + torch.tensor([0.12, 0.26, 0.22], device=dev)[None] * torch.exp(-depth / 9)[:, None]
    fres = (0.15 + 0.6 * (1 + d[:, 2]).clamp(0, 1) ** 5)[:, None]
    wcol = wcol * (0.6 + 0.5 * lit[:, None]) * (1 - fres) + torch.tensor([0.70, 0.79, 0.90], device=dev)[None] * fres
    col = torch.where(water[:, None], wcol, col)
    skyc = torch.tensor([0.58, 0.70, 0.86], device=dev)[None] + torch.tensor([0.20, 0.14, 0.06], device=dev)[None] * (1 - d[:, 2].clamp(0, 1))[:, None] ** 4
    fog = (1 - torch.exp(-t / 32000.0))[:, None]
    col = col * (1 - fog) + skyc * fog
    col = torch.where(hit[:, None], col, skyc)
    img = (col.clamp(0, 1) ** (1 / 1.15)).reshape(Hp, W, 3).cpu().numpy()
    from PIL import Image
    Image.fromarray((img * 255).astype(np.uint8)).save(f'{PRE}/{tag}_{name}.png')


look('calanque', (55.9, 39.85), 90, 299, 1)                      # (a) from the sea, into the calanque
look('gorge_hi', (45.4, 37.2), 760, 95, 12)                       # (b) along the gorge from its head, above the rims
look('gorge_lo', (46.4, 37.75), 380, 80, 1, fov=70)               # ... and down in it, below the rims
look('causse', (49.3, 41.8), 820, 350, 6)                         # (c) over the causse top toward the north escarpment
look('overview', (58.5, 47.8), 3800, 314, 16, fov=58)             # the whole region from the south-east
look('north', (48.6, 29.8), 600, 172, 5)                          # the escarpment from the lowland to the north
look('south', (49.0, 46.8), 260, 352, 2)                          # the south coast cliffs and calanques from the sea
look('cirque', (44.2, 39.6), 900, 50, 16)                         # the cirque (pillar site) from over the ridge foot
lap('looks')
if '--vox' in sys.argv:                                            # the pipeline's voxel obliques, for comparison
    view('vox_calanque', (57.0, 39.45), 230, 268, 3, size_km=9)
    view('vox_gorge', (44.2, 39.6), 950, 68, 13, size_km=11)
    view('vox_causse', (49.0, 41.6), 850, 345, 8, size_km=12)
    view('vox_overview', (57.5, 46.5), 2800, 308, 24, size_km=20)
    lap('obliques')
