import sys, numpy as np
from scipy import ndimage
from paths import WORK
h = np.load(f'{WORK}/h_{sys.argv[1]}.npy').astype(np.float64)
mx = ndimage.maximum_filter(h, footprint=np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]]), mode='nearest')
mn = ndimage.minimum_filter(h, footprint=np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]]), mode='nearest')
up = h - mx; dn = mn - h
for t in (5, 10, 20, 50):
    print(f'spikes > {t:3d} m: {(up > t).sum():7d}   pits > {t:3d} m: {(dn > t).sum():7d}')
idx = np.argsort(-up.ravel())[:8]
n = h.shape[0]
for i in idx:
    y, x = divmod(i, n)
    print('spike at km (%.2f, %.2f) h %.0f  +%.0f over neighbours' % (x * 64 / n, y * 64 / n, h[y, x], up[y, x]))
gy, gx = np.gradient(h, 64000 / n)
s = np.sqrt(gx * gx + gy * gy)[h > 5]
print('land slope pct 50/90/99:', np.percentile(s, [50, 90, 99]).round(2), ' >1.0:', (s > 1).mean().round(3))
