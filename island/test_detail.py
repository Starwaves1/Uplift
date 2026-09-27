"""Tune the detail stage on a crop: upsample a stage-B result 8×, add micro-relief, erode with droplets + talus, and
render before/after obliques.  usage: python test_detail.py tag N x0 y0 size_km [drops_per_cell]"""
import sys, time, os
import numpy as np
import torch
import torch.nn.functional as F
import fields as fx
import detail, preview
from paths import WORK

tag, N = sys.argv[1], int(sys.argv[2])
x0, y0, sz = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
dpc = float(sys.argv[6]) if len(sys.argv) > 6 else 1.5
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
h = np.load(f'{WORK}/h_{tag}_{N}.npy')
dx0 = 64000 / N
c = h[int(y0 * 1000 / dx0):int((y0 + sz) * 1000 / dx0), int(x0 * 1000 / dx0):int((x0 + sz) * 1000 / dx0)]
up = 8 if N <= 1024 else 4
dx = dx0 / up
H = F.interpolate(torch.tensor(c, device=detail.dev)[None, None], scale_factor=up, mode='bicubic', align_corners=False)[0, 0]
n = H.shape[0]
print('crop', c.shape, '->', H.shape, 'dx', dx)
# micro-relief: fbm scaled by local steepness, so slopes get rough and flats stay flat
gy, gx = torch.gradient(H, spacing=dx)
steep = torch.sqrt(gx * gx + gy * gy).clamp(0, 1.5)
micro = fx.fbm(n, n * dx / 300, 4, 7, gain=0.5)             # ~300 m down to ~40 m
H = H + micro * (0.6 + 3.0 * steep) * (H > 1)
before = H.clone()
t0 = time.time()
land = (H > 2).float()
detail.droplets(H, dx, int(n * n * dpc), spawn=land + 1e-4, life=64, inertia=0.3, capacity=2.0, erode=0.08, deposit=0.03, evaporate=0.02, radius=3)
torch.cuda.synchronize(); t1 = time.time()
print('after droplets finite:', bool(torch.isfinite(H).all()), float(H.min()), float(H.max()), 'before', float(before.min()), float(before.max()))
detail.talus(H, dx, torch.full_like(H, 0.9), iters=30)
torch.cuda.synchronize()
print(f'droplets {t1 - t0:.1f}s  talus {time.time() - t1:.1f}s  change rms {float(((H - before) ** 2).mean().sqrt()):.2f} m')
b = before.cpu().numpy(); a = H.cpu().numpy()
preview.oblique(b, dx, f'{PRE}/dt_{tag}_before.png', azim=20, elev=18, dist=0.55, alt=0.05)
preview.oblique(a, dx, f'{PRE}/dt_{tag}_after.png', azim=20, elev=18, dist=0.55, alt=0.05)
preview.render(a, dx, f'{PRE}/dt_{tag}_after_top.png', size=1200)
