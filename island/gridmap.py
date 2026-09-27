"""A design map: shaded relief of a crop with a km grid, labels and 100 m contours — for placing designed features.

usage: python gridmap.py h.npy x0 y0 x1 y1 out.png [px_per_km] [contour_m]
"""
import sys
import numpy as np
from PIL import Image, ImageDraw
import preview

path, x0, y0, x1, y1, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
ppk = float(sys.argv[7]) if len(sys.argv) > 7 else 50
cstep = float(sys.argv[8]) if len(sys.argv) > 8 else 100
h = np.load(path).astype(np.float64)
n = h.shape[0]; dx = 64000 / n
c = h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
preview.render(c, dx, '/tmp/_gm.png')
img = Image.open('/tmp/_gm.png').convert('RGB')
W, H = int((x1 - x0) * ppk), int((y1 - y0) * ppk)
img = img.resize((W, H), Image.LANCZOS)
# contours
from scipy import ndimage
cz = ndimage.zoom(c, (H / c.shape[0], W / c.shape[1]), order=1)
band = np.floor(cz / cstep)
edge = (band != np.roll(band, 1, 0)) | (band != np.roll(band, 1, 1))
a = np.asarray(img).copy()
a[edge & (cz > 0)] = (a[edge & (cz > 0)] * 0.55).astype(np.uint8)
coast = edge & (np.abs(cz) < cstep)
img = Image.fromarray(a)
d = ImageDraw.Draw(img)
for k in range(int(np.ceil(x0)), int(x1) + 1):
    X = (k - x0) * ppk
    d.line([(X, 0), (X, H)], fill=(255, 255, 255) if k % 2 == 0 else (200, 200, 200), width=1)
    if k % 2 == 0:
        d.text((X + 2, 2), str(k), fill=(255, 255, 0))
for k in range(int(np.ceil(y0)), int(y1) + 1):
    Y = (k - y0) * ppk
    d.line([(0, Y), (W, Y)], fill=(255, 255, 255) if k % 2 == 0 else (200, 200, 200), width=1)
    if k % 2 == 0:
        d.text((2, Y + 2), str(k), fill=(255, 255, 0))
img.save(out)
print(out, W, H, 'max', c.max().round(), 'land p50', np.median(c[c > 0]).round() if (c > 0).any() else 0)
