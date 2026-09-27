"""Print terrain heights along designed polylines: at each vertex the height, and the max/min within r km.

usage: python probe.py h.npy r_km "x,y x,y ..." ["x,y ..."]
"""
import sys
import numpy as np

h = np.load(sys.argv[1]).astype(np.float64)
n = h.shape[0]; dx = 64000 / n
r = float(sys.argv[2])
for line in sys.argv[3:]:
    pts = [tuple(map(float, p.split(','))) for p in line.split()]
    print('line', len(pts), 'pts')
    for x, y in pts:
        i, j = int(y * 1000 / dx), int(x * 1000 / dx)
        k = int(r * 1000 / dx)
        blk = h[max(i - k, 0):i + k + 1, max(j - k, 0):j + k + 1]
        print(f'  ({x:5.1f},{y:5.1f})  h {h[i, j]:7.1f}   within {r} km: min {blk.min():7.1f}  p50 {np.median(blk):7.1f}  max {blk.max():7.1f}')
