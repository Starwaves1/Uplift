"""Measure the fjords of a glaciated landscape: the drowned parts of the preglacial land (land0), connected to the sea.

For each fjord: how far it reaches inland (along the water from the preglacial coast), its long profile (depth along
the deepest channel, every 500 m), the sill (the shallowest point that water from the deepest basin must cross to reach
the open sea), the width, and the walls (highest ground within 1 km of the water, and the steepest slope in the first
300 m above it).

usage: python fjordstats.py tag N [min_len_km]      (reads h_<tag>_<N>.npy and land0_<tag>_<N>.npy)
"""
import sys, heapq
import numpy as np
from scipy import ndimage
from paths import WORK

tag, N = sys.argv[1], int(sys.argv[2])
MINLEN = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
h = np.load(f'{WORK}/h_{tag}_{N}.npy').astype(np.float64)
n = h.shape[0]; dx = 64000 / n
land0 = np.load(f'{WORK}/land0_{tag}_{N}.npy')
if land0.shape[0] != n:
    land0 = ndimage.zoom(land0.astype(np.uint8), n / land0.shape[0], order=0) > 0
lab, _ = ndimage.label(h <= 0.0)
ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
sea = np.isin(lab, ids[ids > 0])
fj = sea & land0                                  # drowned preglacial land
flab, nf = ndimage.label(fj, structure=np.ones((3, 3)))
# distance inland along the water from the preglacial coast (open sea cells outside land0 are the source)
src = sea & ~land0
dist = np.full((n, n), np.inf)
pq = []
for y, x in zip(*np.nonzero(src & ndimage.binary_dilation(fj, iterations=1))):
    dist[y, x] = 0.0; pq.append((0.0, y, x))
heapq.heapify(pq)
nb = [(-1, -1, 1.414), (-1, 0, 1), (-1, 1, 1.414), (0, -1, 1), (0, 1, 1), (1, -1, 1.414), (1, 0, 1), (1, 1, 1.414)]
while pq:
    d, y, x = heapq.heappop(pq)
    if d > dist[y, x]:
        continue
    for dy, dx_, w in nb:
        yy, xx = y + dy, x + dx_
        if 0 <= yy < n and 0 <= xx < n and fj[yy, xx]:
            nd_ = d + w * dx
            if nd_ < dist[yy, xx]:
                dist[yy, xx] = nd_; heapq.heappush(pq, (nd_, yy, xx))
gy, gx = np.gradient(h, dx)
slope = np.degrees(np.arctan(np.hypot(gx, gy)))
out = []
for k in range(1, nf + 1):
    m = flab == k
    dm = np.where(m, dist, -1)
    L = dm.max()
    if not np.isfinite(L) or L < MINLEN * 1000:
        continue
    # spill level of every cell toward the sea (priority flood over the fjord water from its mouth)
    spill = np.full((n, n), np.inf)
    pq = []
    for y, x in zip(*np.nonzero(src & ndimage.binary_dilation(m, iterations=1))):
        spill[y, x] = h[y, x]; pq.append((h[y, x], y, x))
    heapq.heapify(pq)
    while pq:
        s, y, x = heapq.heappop(pq)
        if s > spill[y, x]:
            continue
        for dy, dx_, w in nb:
            yy, xx = y + dy, x + dx_
            if 0 <= yy < n and 0 <= xx < n and m[yy, xx]:
                ns = max(s, h[yy, xx])
                if ns < spill[yy, xx]:
                    spill[yy, xx] = ns; heapq.heappush(pq, (ns, yy, xx))
    deep = np.unravel_index(np.argmin(np.where(m, h, np.inf)), h.shape)
    sill = spill[deep]
    mouth = np.argwhere(m & (dist < 2 * dx))
    my, mx = mouth.mean(0)
    head = np.unravel_index(np.argmax(dm), h.shape)
    # long profile: bands of distance inland; per band the deepest bed, the width (area / band length), the walls
    shore = ndimage.binary_dilation(m, iterations=int(1000 / dx)) & ~sea & (h > 0)
    near = ndimage.binary_dilation(m, iterations=int(300 / dx)) & ~sea & (h > 0)
    dd, (iy, ix) = ndimage.distance_transform_edt(~m, return_indices=True)
    band_of = np.where(m, dist, dist[iy, ix])
    prof = []
    for b0 in np.arange(0, L, 500.0):
        bm = m & (dist >= b0) & (dist < b0 + 500)
        if not bm.any():
            continue
        wm = shore & (band_of >= b0) & (band_of < b0 + 500)
        nm = near & (band_of >= b0) & (band_of < b0 + 500)
        prof.append((b0 / 1000, h[bm].min(), bm.sum() * dx * dx / 500, h[wm].max() if wm.any() else 0,
                     np.percentile(slope[nm], 90) if nm.any() else 0))
    out.append((L, k, my, mx, head, deep, sill, prof, m.sum()))
out.sort(key=lambda t: -t[0])
print(f'{tag}: {len(out)} fjords reaching {MINLEN} km or more inland')
for L, k, my, mx, head, deep, sill, prof, area in out:
    print(f'\nfjord mouth ({mx * dx / 1000:5.1f},{my * dx / 1000:5.1f}) km  head ({head[1] * dx / 1000:5.1f},{head[0] * dx / 1000:5.1f})  '
          f'{L / 1000:4.1f} km inland  area {area * dx * dx / 1e6:5.1f} km²  deepest {h[deep]:6.0f} m at '
          f'({deep[1] * dx / 1000:5.1f},{deep[0] * dx / 1000:5.1f})  sill {sill:6.0f} m')
    print('   km   bed    width  wall  slope90')
    for p in prof:
        print(f'  {p[0]:4.1f} {p[1]:6.0f} {p[2]:6.0f} {p[3]:6.0f} {p[4]:5.0f}°')
