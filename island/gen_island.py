"""Stage A: the island's landforms from the designed layout (design.py) — tectonic uplift and rock strength, then a few
million years of fluvial erosion (stream power) with soil creep and landsliding. The volcano is built partway through,
so it keeps a young cone with radial gullies.

usage: python gen_island.py N [steps] [tag]
"""
import sys, time, os
import numpy as np
from scipy import ndimage
import torch
import fields as fx
import lem
import preview
from design import Design, VOLCANO, L

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
STEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 300
TAG = sys.argv[3] if len(sys.argv) > 3 else 'a'
dx = L * 1000 / N
from paths import WORK as OUT
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
os.makedirs(OUT, exist_ok=True); os.makedirs(PRE, exist_ok=True)

D = Design(N)
land = D.np(D.land)
h = D.np(D.h0) + D.np(fx.fbm(N, 16, 4, 51)) * 4
# relief grows as the grid refines (the smallest channels start steeper): keep the designed heights at any resolution
RES = (1024 / N) ** 0.5
Un, Kn0, Scn0 = D.np(D.U) * RES, D.np(D.K), D.np(D.Sc)
Ulate = D.np(D.U_late) * RES
late_from = D.np(D.late_from)                  # when the late block uplift starts (share of the run), per cell
plat, strat = D.np(D.w_plateau), D.np(D.strata)
edge = np.zeros((N, N), bool); edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
edge = edge.ravel()
rain = D.np(D.rain)
# soil creep: rounded, soil-mantled hills in the lowlands and the Mediterranean south, crisp rock in the mountains;
# frost creep and solifluction round the Nordic fell (and space its valleys wider apart)
kappa = 0.004 + 0.03 * D.np(D.w_med) * (1 - D.np(D.w_plateau)) + 0.02 * np.clip(1 - D.np(D.U) / 1.2e-3, 0, 1) * (1 - D.np(D.w_nord)) + 0.03 * D.np(D.w_nord)

# the volcano: a stratovolcano cone (concave flanks, steepening to the summit), built of resistant lava
vr = D.np(D.volc_r)
cone = 2650.0 * np.clip(1 - vr / 8.2, 0, None) ** 2.1 * (1 + 0.05 * D.np(fx.fbm(N, 20, 3, 61)))
w_volc = D.np(D.w_volc)


def rock(hc):
    """Plateau beds: hard sandstone caps (low K, cliff-forming) alternating with soft shales, 110 m cycles."""
    ph = ((hc + strat) / 110.0) % 1.0
    hard = ((ph > 0.0) & (ph < 0.3)).astype(float) * (plat > 0.3)
    Kn = Kn0 * (1 - 0.85 * hard) * (1 + 0.6 * plat * (1 - hard))
    Kn = Kn * (1 - 0.8 * w_volc)                 # porous young lava: little runoff, slow to erode
    Scn = np.where(hard > 0, 3.0, np.where(plat > 0.3, 0.6, Scn0))
    return Kn, Scn


def open_sea(h):
    """Base level: the domain edge and all sea connected to it (land below sea level inland is just a hollow)."""
    lab, _ = ndimage.label((h <= 0.0).reshape(N, N))
    ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    ids = ids[ids > 0]
    return edge | np.isin(lab, ids).ravel()


dt = 2.0e4
rng = np.random.default_rng(7)
t0 = time.time()
built = False
for s in range(STEPS):
    if not built and s >= int(STEPS * 0.86):
        h = np.where(h > 0, np.maximum(h, cone + 0.25 * h), h + cone)   # the eruption: the cone buries the old land and builds up from the sea floor
        built = True
    fixed = open_sea(h)
    Kn, Scn = rock(h)
    Ut = Un + np.where(s >= late_from * STEPS, Ulate, 0.0)
    A, rec = lem.step(h, fixed, N, dx, Kn, Ut, rain, dt, 0.5, Scn, 1e-3, rng.random(N * N), kappa, 10, 1.0)
    if s % 50 == 0 or s == STEPS - 1:
        print(f'step {s:4d}  t={s * dt / 1e6:5.2f} Myr  max {h.max():7.1f} m  land {100 * (h > 0).mean():4.1f}%  {time.time() - t0:6.1f}s', flush=True)

H = h.reshape(N, N)
for nm, w in (('nordic', D.w_nord), ('alpine', D.w_alp), ('med', D.w_med), ('plateau', D.w_plateau), ('volcano', D.w_volc)):
    m = D.np(w).reshape(N, N) > 0.6
    if m.any():
        print(f'{nm:8s} max {H[m].max():6.0f}  p50 {np.median(H[m & (H > 0)]):6.0f}  p90 {np.percentile(H[m & (H > 0)], 90):6.0f}')
np.save(f'{OUT}/h_{TAG}_{N}.npy', H.astype(np.float32))
A, rec, dist, st, hf = lem.flow(h, open_sea(h), N, dx)
A = A.reshape(N, N)
np.save(f'{OUT}/A_{TAG}_{N}.npy', A.astype(np.float32))
preview.render(H, dx, f'{PRE}/{TAG}_{N}_top.png', A=A, size=1400, river_min=3e6)
preview.oblique(H, dx, f'{PRE}/{TAG}_{N}_obl_w.png', azim=75, elev=16, A=A)
preview.oblique(H, dx, f'{PRE}/{TAG}_{N}_obl_s.png', azim=340, elev=16, A=A)
print('done', time.time() - t0)
