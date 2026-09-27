"""Stage C: the shipping heightfield. Takes the stage-A landscape (N0², ~31 m), refines it to N² (~15.6 m) and applies
everything that needs the fine grid: micro-relief, the glacial trough and its fans, the fjords, the caldera, rain-droplet
gullies and talus, the wave-cut coast and its stacks, the sea floor. Saves the heights, the data maps and previews.

usage: python finalize.py tag N0 N outtag
"""
import sys, os, time
import numpy as np
import torch
import torch.nn.functional as F
import fields as fx
import lem, passes, detail, preview
import design as ds

tag, N0, N, TOUT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
from paths import WORK as OUT
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
dx0 = ds.L * 1000 / N0; dx = ds.L * 1000 / N
t0 = time.time()
lap = lambda s: print(f'{s:28s} {time.time() - t0:7.1f}s', flush=True)
g = lambda t: t.double().cpu().numpy()
rng = np.random.default_rng(5)
km = lambda pts: [(x * 1000, y * 1000) for x, y in pts]

h0 = np.load(f'{OUT}/h_{tag}_{N0}.npy').astype(np.float64)
# where the land stood before the ice ages (glaciate.py): the glaciers' drowned troughs there keep their depth
l0 = f'{OUT}/land0_{tag}_{N0}.npy'
land0 = (F.interpolate(torch.tensor(np.load(l0).astype(np.float32))[None, None], size=(N, N), mode='nearest')[0, 0].numpy() > 0.5) if os.path.exists(l0) else None

# ── refine ──
Ht = F.interpolate(torch.tensor(h0, device=fx.dev, dtype=torch.float32)[None, None], size=(N, N), mode='bicubic', align_corners=False)[0, 0]
D = ds.Design(N)
w_nord, w_med, w_volc, w_alp, w_plat = g(D.w_nord), g(D.w_med), g(D.w_volc), g(D.w_alp), g(D.w_plateau)
# micro-relief: roughness where it's steep, calm on flats; Nordic ground gets glacially scoured knolls and hollows
gy, gx = torch.gradient(Ht, spacing=dx)
steep = torch.sqrt(gx * gx + gy * gy).clamp(0, 1.5)
micro = fx.fbm(N, ds.L * 1000 / 300, 4, 7, gain=0.5)
knolls = fx.fbm(N, ds.L * 1000 / 400, 3, 8, gain=0.55) * D.w_nord * (Ht > 60) * (1 - steep.clamp(0, 0.6) / 0.6) * 9
Ht = Ht + (micro * (0.6 + 3.0 * steep) + knolls) * (Ht > 1)
h = g(Ht)
lap('refined + micro-relief')

# ── glacial: the great valley and its fans; the fjords ──
h, dv, Fv, Wv = passes.trough(h, dx, km(ds.VALLEY), ds.VALLEY_FLOOR, [w * 1000 for w in ds.VALLEY_WIDTH],
                              wall=0.022, power=1.5, soft=30.0, rough=g(fx.fbm(N, 40, 3, 71)) * 25, reach=4500)
floor_mask = (dv < Wv / 2) & (dv < 4500)
lap('valley trough')
vs = h[g(D.volc_r) < 2.0].max()
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
detail.droplets(H, dx, int(N * N * 0.8), spawn=land * (1 + 0.5 * torch.tensor(w_nord, device=fx.dev)) + 1e-4, life=64,
                inertia=0.3, capacity=2.0, erode=0.08, deposit=0.03, evaporate=0.02, radius=3, hardness=hard)
lap('droplets')
dep = (H - before).clamp(min=0)
talus_tan = torch.tensor(0.9 + 0.35 * w_nord + 0.3 * w_volc, device=fx.dev, dtype=torch.float32)
pre_t = H.clone()
detail.talus(H, dx, talus_tan, iters=30)
scree = (H - pre_t).clamp(min=0)
h = g(H)
lap('talus')

# ── fans onto the valley floor (after the rain, so they sit on top) ──
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
h_before_fans = h.copy()
h, fs = passes.fans(h, dx, A, floor_mask, np.maximum(0, dv - Wv / 2), rng)
lap(f'fans: {len(fs)}')

# ── the coast: rock faces, coves, stacks; then the sea floor ──
cove = g(fx.fbm(N, 26, 4, 81))
style = np.clip(0.95 * w_nord + 0.8 * w_med + 0.75 * w_volc + 0.25 * w_alp, 0, 1) * np.clip(0.75 + 0.9 * cove, 0, 1)
retreat = 90 + 260 * np.clip(0.5 + 0.6 * g(fx.fbm(N, 60, 3, 82)), 0, 1)
h_pre_coast = h.copy()
h, dcoast, stacks = passes.coast(h, dx, style, retreat, rng, face=4.5, platform=-5.0, stacks=45)
lap(f'coast: {len(stacks)} stacks')
h_carved = h
h = passes.bathymetry(h, dx, g(fx.fbm(N, 20, 4, 91)))
if land0 is not None:
    h = np.where(land0 & (h_carved < h), h_carved, h)
lap('sea floor')

# ── lakes: water in the closed basins (the caldera, tarns, hollows in the valley floors) ──
lake_lab, lake_tab = passes.lakes(h, dx, lem)
np.save(f'{OUT}/lakes_{TOUT}_{N}.npy', lake_lab.astype(np.uint16))
import json
json.dump([{'id': i, 'level': round(lv, 2), 'area': round(a), 'bbox': [int(v) for v in bb]} for i, lv, a, bb in lake_tab],
          open(f'{OUT}/lakes_{TOUT}_{N}.json', 'w'))
lap(f'lakes: {len(lake_tab)} (largest {max([a for _, _, a, _ in lake_tab], default=0) / 1e6:.2f} km²)')

np.save(f'{OUT}/h_{TOUT}_{N}.npy', h.astype(np.float32))

# ── data maps (for materials): river flow, sediment, scree, bare rock ──
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
sed = np.clip(g(dep) / 6.0, 0, 1) * 0.6 + np.clip((h - h_before_fans) / 20, 0, 1) + floor_mask * 0.5
gyy, gxx = np.gradient(h, dx)
slope = np.sqrt(gxx ** 2 + gyy ** 2)
cliff = np.clip((slope - 0.9) / 0.8, 0, 1) + np.clip((h_pre_coast - h) / 30, 0, 1) * (h > 0)
maps = np.stack([np.clip((np.log10(np.maximum(A, 1)) - 4.0) / 4.0, 0, 1), np.clip(sed, 0, 1),
                 np.clip(g(scree) / 3.0, 0, 1), np.clip(cliff, 0, 1)], -1)
np.save(f'{OUT}/maps_{TOUT}_{N}.npy', (maps * 255).astype(np.uint8))
np.save(f'{OUT}/regions_{TOUT}_{N}.npy', (np.stack([w_nord, w_med, w_plat, w_volc], -1) * 255).astype(np.uint8))
lap('maps')

# ── previews ──
preview.render(h, dx, f'{PRE}/{TOUT}_{N}_top.png', A=A, size=1600, river_min=3e6)
c = lambda x0, y0, x1, y1: h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
preview.oblique(h[::2, ::2], dx * 2, f'{PRE}/{TOUT}_{N}_obl_w.png', azim=75, elev=16)
preview.oblique(c(2, 18, 34, 50)[::2, ::2], dx * 2, f'{PRE}/{TOUT}_{N}_valley.png', azim=72, elev=12, dist=0.55, alt=0.06)
preview.oblique(c(2, 6, 30, 34)[::2, ::2], dx * 2, f'{PRE}/{TOUT}_{N}_nordic.png', azim=140, elev=14, dist=0.6, alt=0.07)
preview.oblique(c(14, 40, 40, 58)[::2, ::2], dx * 2, f'{PRE}/{TOUT}_{N}_south.png', azim=0, elev=14, dist=0.6, alt=0.06)
preview.oblique(c(40, 6, 62, 28)[::2, ::2], dx * 2, f'{PRE}/{TOUT}_{N}_volcano.png', azim=300, elev=14, dist=0.6, alt=0.06)
lap('done')
