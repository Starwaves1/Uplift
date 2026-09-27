"""Low-angle design views along each fjord of a glaciated landscape (as fjordstats.py finds them): one from the mouth
looking in, one from above the head looking back out. Writes island/preview/<tag>_fjord<k>_{in,out}.png and prints each
fjord's mouth and head with a spectator-mode bookmark (?fly&at=x,y,heading,alt).

usage: python fjordviews.py tag N [min_len_km] [count]
"""
import sys, os
import numpy as np
from scipy import ndimage
import preview
from paths import WORK

tag, N = sys.argv[1], int(sys.argv[2])
MINLEN = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
COUNT = int(sys.argv[4]) if len(sys.argv) > 4 else 4
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
h = np.load(f'{WORK}/h_{tag}_{N}.npy').astype(np.float64)
n = h.shape[0]; dx = 64000 / n
land0 = np.load(f'{WORK}/land0_{tag}_{N}.npy')
if land0.shape[0] != n:
    land0 = ndimage.zoom(land0.astype(np.uint8), n / land0.shape[0], order=0) > 0
lab, _ = ndimage.label(h <= 0.0)
ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
sea = np.isin(lab, ids[ids > 0])
fj = sea & land0
flab, nf = ndimage.label(fj, structure=np.ones((3, 3)))
# distance inland along the water from the preglacial coast
src = sea & ~land0
dist = ndimage.distance_transform_edt(~src) * dx          # straight-line stand-in for the along-water distance
found = []
for k in range(1, nf + 1):
    m = flab == k
    d = np.where(m, dist, -1)
    if d.max() < MINLEN * 1000:
        continue
    head = np.unravel_index(np.argmax(d), d.shape)
    mouth = np.argwhere(m & (dist < 3 * dx)).mean(0)
    found.append((d.max(), mouth, head))
found.sort(key=lambda t: -t[0])
for i, (L, (my, mx), (hy, hx)) in enumerate(found[:COUNT]):
    mxk, myk, hxk, hyk = mx * dx / 1000, my * dx / 1000, hx * dx / 1000, hy * dx / 1000
    az_in = np.degrees(np.arctan2(hxk - mxk, -(hyk - myk))) % 360          # compass bearing mouth -> head
    # the camera: 1.5 km out beyond the mouth looking in; 1 km beyond the head looking out
    ux, uy = (hxk - mxk) / (L / 1000 + 1e-9), (hyk - myk) / (L / 1000 + 1e-9)
    for nm, (cx, cy, az) in (('in', (mxk - 1.5 * ux, myk - 1.5 * uy, az_in)), ('out', (hxk + 1.0 * ux, hyk + 1.0 * uy, (az_in + 180) % 360))):
        r = 7.0
        # preview.oblique puts the camera `dist`·size behind the crop centre along the view: centre the crop so the
        # camera lands at (cx, cy)
        a = np.radians(az)
        ccx, ccy = cx + np.sin(a) * 2 * r * 0.55, cy - np.cos(a) * 2 * r * 0.55
        x0, y0 = max(ccx - r, 0), max(ccy - r, 0)
        crop = h[int(y0 * 1000 / dx):int((ccy + r) * 1000 / dx), int(x0 * 1000 / dx):int((ccx + r) * 1000 / dx)]
        s = min(crop.shape)
        preview.oblique(crop[:s, :s], dx, f'{PRE}/{tag}_fjord{i + 1}_{nm}.png', azim=az, elev=8, dist=0.55, alt=0.03, fov=60)
    print(f'fjord {i + 1}: {L / 1000:4.1f} km  mouth ({mxk:5.1f},{myk:5.1f})  head ({hxk:5.1f},{hyk:5.1f})  '
          f'mouth view ?fly&at={mxk - 1.5 * ux:.1f},{myk - 1.5 * uy:.1f},{az_in:.0f},250  '
          f'head view ?fly&at={hxk + 0.6 * ux:.1f},{hyk + 0.6 * uy:.1f},{(az_in + 180) % 360:.0f},300', flush=True)
