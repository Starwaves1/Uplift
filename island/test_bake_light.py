"""Checks for bake_light.py against cases with known answers.  usage: python test_bake_light.py"""
import math
import numpy as np
import torch
import bake_light as bl

dev = bl.dev
T = lambda v: torch.tensor(float(v))


def slices(nx, ny, nz, e=0.0, half=32, w=None):
    """Mean slice visibility for one normal under a uniform horizon elevation e (rad); w: a sky profile (None: uniform)."""
    v = 0.0
    for s in range(half):
        phi = math.pi * (s + 0.5) / half
        nd = T(nx * math.cos(phi) + nz * math.sin(phi))
        v += float(bl.slice_vis(T(e), T(e), nd, T(ny)) if w is None else bl.slice_int(T(e), T(e), nd, T(ny), w))
    return v / half


# 1. open flat ground sees the whole sky
assert abs(slices(0.0, 1.0, 0.0) - 1.0) < 1e-4, slices(0.0, 1.0, 0.0)
# 2. a patch tilted by a on open flat ground: (1 + cos a)/2 — the game's open-ground model, so Au = 1 there
for deg in (10, 30, 50, 70):
    a = math.radians(deg)
    v = slices(math.sin(a) * 0.6, math.cos(a), math.sin(a) * 0.8)
    assert abs(v - (1 + math.cos(a)) / 2) < 2e-3, (deg, v, (1 + math.cos(a)) / 2)
# 3. under a uniform horizon at elevation e, a level spot sees cos²(e) of the sky
for deg in (10, 25, 45):
    e = math.radians(deg)
    v = slices(0.0, 1.0, 0.0, e)
    assert abs(v - math.cos(e) ** 2) < 1e-4, (deg, v)
# 4. the quadrature: with an even sky it matches the closed form, for tilted normals and raised horizons too
one = lambda e: torch.ones_like(e)
for deg, hz in ((0, 0), (35, 0), (60, 20), (20, 40)):
    a = math.radians(deg)
    args = (math.sin(a) * 0.6, math.cos(a), math.sin(a) * 0.8, math.radians(hz))
    v0, v1 = slices(*args), slices(*args, w=one)
    assert abs(v0 - v1) < 1e-4, (deg, hz, v0, v1)

n = 512; dx = bl.SIZE / n
x = (np.arange(n) - n // 2) * dx
X, Z = np.meshgrid(x, x)
run = lambda h, d=64: bl.bake(torch.tensor(h, dtype=torch.float32, device=dev), dx, dirs=d, reach=20000, band_rows=96, log=lambda *a: None)
# 5. flat ground and a uniform slope: nothing beyond the open-ground model (both channels 1)
for h in (np.zeros((n, n)), X * 0.4 + Z * 0.2):
    Au, Ab, V = run(h, 32)
    for A in (Au, Ab):
        c = A[n // 4:3 * n // 4, n // 4:3 * n // 4]
        assert float(np.abs(c - 1).max()) < 2e-3, float(np.abs(c - 1).max())
# 6. the floor of a long V valley with sides at b: cos b of the even sky (∫ dφ/(1 + tan²b sin²φ) / 2π), and of the
#    horizon band what a brute-force integral over the hemisphere gives
e = np.linspace(0, math.pi / 2, 4001)[1:]
wb = bl.band(torch.tensor(e), 0.1).numpy() * np.sin(e) * np.cos(e)
phis = np.linspace(0, 2 * math.pi, 2049)[:-1]
for deg in (15, 30, 45):
    b = math.radians(deg)
    h = np.abs(X) * math.tan(b)
    Au, Ab, V = run(h)
    v, vb = float(V[n // 2, n // 2]), float(Ab[n // 2, n // 2])
    hor = np.arctan(math.tan(b) * np.abs(np.cos(phis)))
    ref = np.mean([wb[e > hh].sum() for hh in hor]) / wb.sum()
    assert abs(v - math.cos(b)) < 0.01, (deg, v, math.cos(b))
    assert abs(vb - ref) < 0.02, (deg, vb, ref)
    j = n // 2 + 40
    print(f'V valley {deg}°: floor even sky {v:.4f} (exact {math.cos(b):.4f}), band {vb:.4f} (brute force {ref:.4f});'
          f' side Au {float(Au[n // 2, j]):.4f} Ab {float(Ab[n // 2, j]):.4f}')
print('all checks passed')
