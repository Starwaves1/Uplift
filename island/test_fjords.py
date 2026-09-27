"""Iterate on the designed fjords: carve them into a finished island and render design views.

usage: python test_fjords.py h.npy outtag [wall] [power]
"""
import sys, os
import numpy as np
import fields as fx
import passes, preview
import design as ds
from paths import WORK

src, tag = sys.argv[1], sys.argv[2]
wall = float(sys.argv[3]) if len(sys.argv) > 3 else 0.06
power = float(sys.argv[4]) if len(sys.argv) > 4 else 1.4
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
h = np.load(src).astype(np.float64)
N = h.shape[0]; dx = 64000 / N
rough = fx.fbm(N, 40, 3, 73).double().cpu().numpy() * 30
for f in ds.FJORDS:
    pts = [(x * 1000, y * 1000) for x, y in f['pts']]
    h, d, F, W = passes.fjord(h, dx, pts, f['floor'], f['width'], wall=wall, power=power, rough=rough)
    print(f['name'], 'carved', flush=True)
np.save(f'{WORK}/h_{tag}.npy', h.astype(np.float32))
c = lambda x0, y0, x1, y1: h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
# along the Vestfjord from its mouth; down the Nordfjord from the north; up the Austfjord
preview.oblique(c(6, 12, 26, 32), dx, f'{PRE}/{tag}_vest.png', azim=118, elev=10, dist=0.55, alt=0.05)
preview.oblique(c(8, 8, 26, 26), dx, f'{PRE}/{tag}_nord.png', azim=175, elev=10, dist=0.55, alt=0.05)
preview.oblique(c(18, 8, 36, 28), dx, f'{PRE}/{tag}_aust.png', azim=200, elev=10, dist=0.55, alt=0.05)
print('done')
