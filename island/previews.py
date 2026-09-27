"""Render the standard design previews of a saved island: top-down with rivers, and obliques of each region.

usage: python previews.py tag N [only,these,views]
"""
import sys, os
import numpy as np
import lem, passes, preview
from paths import WORK

tag, N = sys.argv[1], int(sys.argv[2])
only = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
h = np.load(f'{WORK}/h_{tag}_{N}.npy').astype(np.float64)
dx = 64000 / N
c = lambda x0, y0, x1, y1: h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
views = {
    'obl_w': lambda p: preview.oblique(h[::2, ::2], dx * 2, p, azim=75, elev=16),
    'valley': lambda p: preview.oblique(c(2, 18, 34, 50)[::2, ::2], dx * 2, p, azim=72, elev=12, dist=0.55, alt=0.06),
    'nordic': lambda p: preview.oblique(c(2, 6, 30, 34)[::2, ::2], dx * 2, p, azim=140, elev=14, dist=0.6, alt=0.07),
    'south': lambda p: preview.oblique(c(14, 40, 40, 58)[::2, ::2], dx * 2, p, azim=0, elev=14, dist=0.6, alt=0.06),
    'volcano': lambda p: preview.oblique(c(40, 6, 62, 28)[::2, ::2], dx * 2, p, azim=300, elev=14, dist=0.6, alt=0.06),
    # the fjords: along the Vestfjord from its mouth, down the Nordfjord from the north, up the Austfjord
    'vest': lambda p: preview.oblique(c(6, 12, 26, 32), dx, p, azim=118, elev=10, dist=0.55, alt=0.05),
    'nord': lambda p: preview.oblique(c(8, 8, 26, 26), dx, p, azim=175, elev=10, dist=0.55, alt=0.05),
    'aust': lambda p: preview.oblique(c(18, 8, 36, 28), dx, p, azim=200, elev=10, dist=0.55, alt=0.05),
}
if only is None or 'top' in only:
    sea = passes.open_sea_mask(h)
    fixed = (sea | np.pad(np.zeros((N - 2, N - 2), bool), 1, constant_values=True)).ravel()
    A = lem.flow(h.ravel(), fixed, N, dx)[0].reshape(N, N)
    preview.render(h, dx, f'{PRE}/{tag}_{N}_top.png', A=A, size=1600, river_min=3e6)
    print('top', flush=True)
for k, f in views.items():
    if only is None or k in only:
        f(f'{PRE}/{tag}_{N}_{k}.png')
        print(k, flush=True)
