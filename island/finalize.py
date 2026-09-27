"""Stage C: the shipping heightfield. Takes the stage-A landscape (N0², ~31 m), refines it to N² (8192²: 7.8 m) and applies
everything that needs the fine grid: micro-relief, the glacial trough and its fans, the caldera, rain-droplet gullies
and talus, the wave-cut coast and its stacks (sparing the fjord walls), the sea floor (keeping the fjords' glacial
depth). Saves the heights, the data maps and previews.

usage: python finalize.py tag N0 N outtag
"""
import sys, os, time
import numpy as np
from scipy import ndimage
import torch
import torch.nn.functional as F
import fields as fx
import lem, passes, detail, preview
import design as ds

tag, N0, N, TOUT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
from paths import WORK as OUT
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
os.makedirs(PRE, exist_ok=True)
dx0 = ds.L * 1000 / N0; dx = ds.L * 1000 / N
t0 = time.time()
PEAK = [0.0]
def lap(s):    # time; RAM now and the stage's peak (the high-water mark is reset after each stage); GPU peak so far
    rss = [int(l.split()[1]) / 1e6 for l in open('/proc/self/status') if l.startswith(('VmRSS', 'VmHWM'))] if os.path.exists('/proc/self/status') else []
    gpu = torch.cuda.max_memory_allocated() / 1e9 if torch.cuda.is_available() else 0
    if len(rss) == 2:
        PEAK[0] = max(PEAK[0], rss[0])
        try: open('/proc/self/clear_refs', 'w').write('5')
        except OSError: pass
    print(f'{s:28s} {time.time() - t0:7.1f}s' + (f'   RAM {rss[1]:4.1f} GB, stage peak {rss[0]:4.1f}, run peak {PEAK[0]:4.1f}  GPU peak {gpu:4.1f} GB' if len(rss) == 2 else ''), flush=True)
g = lambda t: t.double().cpu().numpy()
rng = np.random.default_rng(5)
km = lambda pts: [(x * 1000, y * 1000) for x, y in pts]

h0 = np.load(f'{OUT}/h_{tag}_{N0}.npy').astype(np.float64)
# where the land stood before the ice ages (glaciate.py): the glaciers' drowned troughs there keep their depth
l0 = f'{OUT}/land0_{tag}_{N0}.npy'
land0 = (F.interpolate(torch.tensor(np.load(l0).astype(np.float32))[None, None], size=(N, N), mode='nearest')[0, 0].numpy() > 0.5) if os.path.exists(l0) else None

# ── refine: a cubic B-spline through the landscape's samples (torch's bicubic kernel, a = −0.75, leaves a waffle of slope
# ripples at the landscape's grid spacing — plain in the shading once the step is 4× or more) ──
from scipy import ndimage
Ht = torch.tensor(ndimage.zoom(h0, N / N0, order=3, mode='reflect', grid_mode=True), device=fx.dev, dtype=torch.float32)
assert Ht.shape == (N, N)
# the design's region weights vary over kilometres: past 4096² build them there and upsample (the design itself at
# 8192² held ~7 GB of GPU memory for the whole run)
D = ds.Design(min(N, 4096))
up = (lambda t: t) if D.N == N else (lambda t: F.interpolate(t[None, None], size=(N, N), mode='bilinear', align_corners=False)[0, 0])
Wn = up(D.w_nord)
g32 = lambda t: t.float().cpu().numpy()        # the weights only scale things: float32 halves them (2.7 → 1.3 GB at 8192²)
w_nord, w_med, w_volc, w_alp, w_plat = g32(Wn), g32(up(D.w_med)), g32(up(D.w_volc)), g32(up(D.w_alp)), g32(up(D.w_plateau))
Xc, Yc = fx.coords(N, ds.L)
volc_near = g(torch.sqrt((Xc - ds.VOLCANO[0]) ** 2 + (Yc - ds.VOLCANO[1]) ** 2)) < 2.0   # = Design's volc_r < 2 km
del D, Xc, Yc
# micro-relief: roughness where it's steep, calm on flats; Nordic ground gets glacially scoured knolls and hollows
gy, gx = torch.gradient(Ht, spacing=dx)
steep = torch.sqrt(gx * gx + gy * gy).clamp(0, 1.5)
micro = fx.fbm(N, ds.L * 1000 / 300, 4, 7, gain=0.5)
knolls = fx.fbm(N, ds.L * 1000 / 400, 3, 8, gain=0.55) * Wn * (Ht > 60) * (1 - steep.clamp(0, 0.6) / 0.6) * 9
Ht = Ht + (micro * (0.6 + 3.0 * steep) + knolls) * (Ht > 1)
h = g(Ht)
del Ht, Wn, gx, gy, steep, micro, knolls
torch.cuda.empty_cache()
lap('refined + micro-relief')

# ── glacial: the great valley and its fans (the fjords come cut from glaciate.py) ──
h, dv, Fv, Wv = passes.trough(h, dx, km(ds.VALLEY), ds.VALLEY_FLOOR, [w * 1000 for w in ds.VALLEY_WIDTH],
                              wall=0.022, power=1.5, soft=30.0, rough=g(fx.fbm(N, 40, 3, 71)) * 25, reach=4500)
floor_mask = (dv < Wv / 2) & (dv < 4500)
d_floor = np.maximum(0, dv - Wv / 2)
del dv, Fv, Wv                                    # (8192²: every float64 grid is 0.5 GB — free them as soon as done)
lap('valley trough')
vs = h[volc_near].max()
h = passes.caldera(h, dx, ds.VOLCANO[0] * 1000, ds.VOLCANO[1] * 1000, 1350, vs - 430)
lap(f'caldera (summit {vs:.0f})')

# ── the plateau: flat-lying beds of hard and soft rock, stepped into ledges and walls ──
h = passes.beds(h, dx, w_plat * (h > 5), g(fx.fbm(N, 6, 3, 72)) * 18, step=30.0)
lap('plateau beds')

# ── rain: gullies and rills, then talus ──
H = torch.tensor(h, device=fx.dev, dtype=torch.float32)
before = H.clone()
land = (H > 2).float()
hard = torch.tensor(np.clip(0.55 * w_nord + 0.5 * w_volc, 0, 0.8), device=fx.dev, dtype=torch.float32)
sN = max(1, N // 4096)          # finer than 4096²: droplets live as far in metres (their brush stays 3 cells: finer rills)
detail.droplets(H, dx, int(N * N * 0.8), spawn=land * (1 + 0.5 * torch.tensor(w_nord, device=fx.dev)) + 1e-4, life=64 * sN,
                inertia=0.3, capacity=2.0, erode=0.08, deposit=0.03, evaporate=0.02, radius=3, hardness=hard)
lap('droplets')
dep = (H - before).clamp(min=0)
talus_tan = torch.tensor(0.9 + 0.35 * w_nord + 0.3 * w_volc, device=fx.dev, dtype=torch.float32)
pre_t = H.clone()
detail.talus(H, dx, talus_tan, iters=30)
scree = (H - pre_t).clamp(min=0)
h = g(H)
del H, before, pre_t, land, hard, talus_tan
torch.cuda.empty_cache()
lap('talus')

# ── fans onto the valley floor (after the rain, so they sit on top) ──
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
h_before_fans = h.astype(np.float32)             # (only for the sediment map)
h, fs = passes.fans(h, dx, A, floor_mask, d_floor, rng)
del A, sea, fixed, d_floor
lap(f'fans: {len(fs)}')

# ── the coast: rock faces, coves, stacks; then the sea floor ──
cove = g(fx.fbm(N, 26, 4, 81))
style = np.clip(0.95 * w_nord + 0.8 * w_med + 0.75 * w_volc + 0.25 * w_alp, 0, 1) * np.clip(0.75 + 0.9 * cove, 0, 1)
del cove
retreat = 90 + 260 * np.clip(0.5 + 0.6 * g(fx.fbm(N, 60, 3, 82)), 0, 1)
if land0 is not None:
    # the fjords are sheltered from the waves: where the nearest sea is a drowned glacial trough (land before the ice
    # ages), the walls plunge straight into the water — no wave-cut platform, no cutting back
    _, (sy, sx) = ndimage.distance_transform_edt(~passes.open_sea_mask(h), return_indices=True)
    style = style * (1 - np.clip(ndimage.gaussian_filter(land0[sy, sx].astype(np.float32), 150 / dx) * 1.5, 0, 1))
    del sy, sx
h_pre_coast = h.astype(np.float32)               # (only for the rock-exposure map)
h, dcoast, stacks = passes.coast(h, dx, style, retreat, rng, face=4.5, platform=-5.0, stacks=45)
del style, retreat, dcoast
lap(f'coast: {len(stacks)} stacks')
h_carved = h
h = passes.bathymetry(h, dx, g(fx.fbm(N, 20, 4, 91)))
if land0 is not None:
    # the glaciers' drowned troughs keep their depth; blended across the preglacial coast over ~200 m, so the fjords'
    # sills ramp up into the shelf instead of stepping at a line
    kw = np.clip(ndimage.gaussian_filter(land0.astype(np.float32), 120 / dx) * 2.0 - 0.5, 0, 1)
    h = h + kw * (np.minimum(h_carved, h) - h)
    del kw
del h_carved
lap('sea floor')

# ── lakes: water in the closed basins (the caldera, tarns, hollows in the valley floors) ──
lake_lab, lake_tab = passes.lakes(h, dx, lem)
np.save(f'{OUT}/lakes_{TOUT}_{N}.npy', lake_lab.astype(np.uint16))
import json
json.dump([{'id': i, 'level': round(lv, 2), 'area': round(a), 'bbox': [int(v) for v in bb]} for i, lv, a, bb in lake_tab],
          open(f'{OUT}/lakes_{TOUT}_{N}.json', 'w'))
lap(f'lakes: {len(lake_tab)} (largest {max([a for _, _, a, _ in lake_tab], default=0) / 1e6:.2f} km²)')

np.save(f'{OUT}/h_{TOUT}_{N}.npy', h.astype(np.float32))
if land0 is not None:
    np.save(f'{OUT}/land0_{TOUT}_{N}.npy', land0)          # for fjordstats.py / fjordviews.py on the finished grid

# ── data maps (for materials): river flow, sediment, scree, bare rock ──
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
del sea, fixed
def u8(chans):                                    # = (np.stack(chans, -1) * 255).astype(np.uint8), a channel at a time
    out = np.empty((N, N, len(chans)), np.uint8)
    for k, c in enumerate(chans):
        out[..., k] = (c() * 255).astype(np.uint8)
    return out
def cliff():
    gyy, gxx = np.gradient(h, dx)
    return np.clip(np.clip((np.sqrt(gxx ** 2 + gyy ** 2) - 0.9) / 0.8, 0, 1) + np.clip((h_pre_coast - h) / 30, 0, 1) * (h > 0), 0, 1)
np.save(f'{OUT}/maps_{TOUT}_{N}.npy', u8([
    lambda: np.clip((np.log10(np.maximum(A, 1)) - 4.0) / 4.0, 0, 1),
    lambda: np.clip(np.clip(g(dep) / 6.0, 0, 1) * 0.6 + np.clip((h - h_before_fans) / 20, 0, 1) + floor_mask * 0.5, 0, 1),
    lambda: np.clip(g(scree) / 3.0, 0, 1), cliff]))
np.save(f'{OUT}/regions_{TOUT}_{N}.npy', u8([lambda: w_nord, lambda: w_med, lambda: w_plat, lambda: w_volc]))
lap('maps')

# ── previews (from at most 4096²: they're downsized anyway, and full-size float64 temporaries at 8192² run to GBs) ──
ps = max(1, N // 4096); hp = h[::ps, ::ps]; dp = dx * ps
preview.render(hp, dp, f'{PRE}/{TOUT}_{N}_top.png', A=A[::ps, ::ps], size=1600, river_min=3e6)
c = lambda x0, y0, x1, y1: hp[int(y0 * 1000 / dp):int(y1 * 1000 / dp), int(x0 * 1000 / dp):int(x1 * 1000 / dp)]
preview.oblique(hp[::2, ::2], dp * 2, f'{PRE}/{TOUT}_{N}_obl_w.png', azim=75, elev=16)
preview.oblique(c(2, 18, 34, 50)[::2, ::2], dp * 2, f'{PRE}/{TOUT}_{N}_valley.png', azim=72, elev=12, dist=0.55, alt=0.06)
preview.oblique(c(2, 6, 30, 34)[::2, ::2], dp * 2, f'{PRE}/{TOUT}_{N}_nordic.png', azim=140, elev=14, dist=0.6, alt=0.07)
preview.oblique(c(14, 40, 40, 58)[::2, ::2], dp * 2, f'{PRE}/{TOUT}_{N}_south.png', azim=0, elev=14, dist=0.6, alt=0.06)
preview.oblique(c(40, 6, 62, 28)[::2, ::2], dp * 2, f'{PRE}/{TOUT}_{N}_volcano.png', azim=300, elev=14, dist=0.6, alt=0.06)
lap('done')
