"""Stage B driver: load a stage-A landscape, apply the designed passes, save and preview.

usage: python post.py N tag_in tag_out
"""
import sys, os, time
import numpy as np
from scipy import ndimage
import fields as fx
import lem, passes, preview
import design as ds

N = int(sys.argv[1]); TIN = sys.argv[2]; TOUT = sys.argv[3]
from paths import WORK as OUT
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
dx = ds.L * 1000 / N
t0 = time.time()
h = np.load(f'{OUT}/h_{TIN}_{N}.npy').astype(np.float64)
D = ds.Design(N)
g = lambda t: t.double().cpu().numpy()
w_nord, w_med, w_volc, w_alp = g(D.w_nord), g(D.w_med), g(D.w_volc), g(D.w_alp)
rng = np.random.default_rng(3)
km = lambda pts: [(x * 1000, y * 1000) for x, y in pts]

# ── the great valley: a glacial trough between the two ranges ──
h, dv, Fv, Wv = passes.trough(h, dx, km(ds.VALLEY), ds.VALLEY_FLOOR, [w * 1000 for w in ds.VALLEY_WIDTH],
                               wall=0.022, power=1.5, soft=30.0, rough=g(fx.fbm(N, 40, 3, 71)) * 25, reach=4500)
floor_mask = (dv < Wv / 2) & (dv < 4500)
_sea = passes.open_sea_mask(h)
_fix = (_sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
Afl = lem.flow(h.ravel(), _fix, N, dx)[0].reshape(N, N)
h, fsites = passes.fans(h, dx, Afl, floor_mask, np.maximum(0, dv - Wv / 2), rng)
print('valley', len(fsites), 'fans', round(time.time() - t0, 1))

# ── fjords: the biggest rivers reaching the Nordic coast become drowned glacial troughs ──
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A, rec, dist, st, hf = lem.flow(h.ravel(), fixed, N, dx)
A2 = A.reshape(N, N)
coastal = ndimage.binary_dilation(sea, iterations=1) & ~sea
cand = np.argwhere(coastal & (w_nord > 0.4) & (A2 > 2.5e6))
cand = cand[np.argsort(-A2[cand[:, 0], cand[:, 1]])]
# donors: for tracing upstream along the biggest tributary
donors = [[] for _ in range(N * N)]
for i in np.nonzero(rec != np.arange(N * N))[0]:
    donors[rec[i]].append(i)
fjords = []
for cy, cx in cand:
    if len(fjords) >= 3:
        break
    if any((cy - fy) ** 2 + (cx - fx_) ** 2 < (5000 / dx) ** 2 for fy, fx_, _ in fjords):
        continue
    path = [cy * N + cx]; length = 0.0
    while length < 11000:
        ds_ = donors[path[-1]]
        if not ds_:
            break
        nxt = max(ds_, key=lambda j: A[j])
        if A[nxt] < 0.6e6:
            break
        length += dist[nxt]; path.append(nxt)
    if length < 4000:
        continue
    fjords.append((cy, cx, path))
for cy, cx, path in fjords:
    pts = [((p % N + 0.5) * dx, (p // N + 0.5) * dx) for p in path]
    # smooth the traced line (D8 paths zig-zag), and extend it a kilometre out to sea
    P = np.array(pts)
    P = ndimage.gaussian_filter1d(P, sigma=max(2, int(250 / dx)), axis=0, mode='nearest')
    out_dir = P[0] - P[min(len(P) - 1, int(1500 / dx))]
    out_dir /= np.linalg.norm(out_dir) + 1e-9
    P = np.vstack([P[0] + out_dir * 1200, P])
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]); u = s / s[-1]
    floor = np.interp(u, [0, 0.08, 0.2, 0.55, 0.85, 1.0], [-45, -40, -120, -150, -70, 4])     # a sill at the mouth, basins inside
    width = np.interp(u, [0, 0.5, 0.9, 1.0], [800, 650, 500, 380])
    h, _, _, _ = passes.trough(h, dx, [tuple(p) for p in P], floor, width, wall=0.03, power=1.45, soft=25.0, reach=3500)
print('fjords', len(fjords), [round(len(f[2]) * dx / 1000, 1) for f in fjords], round(time.time() - t0, 1))

# ── the caldera ──
vs = h[(g(D.volc_r) < 2.0)].max()
h = passes.caldera(h, dx, ds.VOLCANO[0] * 1000, ds.VOLCANO[1] * 1000, 1350, vs - 430)
print('volcano summit', round(vs), 'caldera floor', round(vs - 430))

# ── coasts: rock faces in the north-west, the south and around the volcano; beaches in between ──
cove = g(fx.fbm(N, 26, 4, 81))
style = np.clip(0.95 * w_nord + 0.8 * w_med + 0.75 * w_volc + 0.25 * w_alp, 0, 1) * np.clip(0.75 + 0.9 * cove, 0, 1)
retreat = 90 + 260 * np.clip(0.5 + 0.6 * g(fx.fbm(N, 60, 3, 82)), 0, 1)
h, dcoast, stacks = passes.coast(h, dx, style, retreat, rng, face=4.5, platform=-5.0, stacks=45)
print('coast stacks', len(stacks), round(time.time() - t0, 1))

# ── sea floor ──
h = passes.bathymetry(h, dx, g(fx.fbm(N, 20, 4, 91)))

np.save(f'{OUT}/h_{TOUT}_{N}.npy', h.astype(np.float32))
sea = passes.open_sea_mask(h)
fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
np.save(f'{OUT}/A_{TOUT}_{N}.npy', A.astype(np.float32))
preview.render(h, dx, f'{PRE}/{TOUT}_{N}_top.png', A=A, size=1400, river_min=3e6)
preview.oblique(h, dx, f'{PRE}/{TOUT}_{N}_obl_w.png', azim=75, elev=16, A=A)
# close-ups: down the great valley from its mouth, and along the Nordic coast
c = lambda x0, y0, x1, y1: h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
preview.oblique(c(2, 18, 34, 50), dx, f'{PRE}/{TOUT}_{N}_valley.png', azim=72, elev=12, dist=0.55, alt=0.06, A=None)
preview.oblique(c(2, 6, 30, 34), dx, f'{PRE}/{TOUT}_{N}_nordic.png', azim=140, elev=14, dist=0.6, alt=0.07, A=None)
print('done', round(time.time() - t0, 1))
