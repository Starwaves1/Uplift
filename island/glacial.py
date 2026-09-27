"""Glacial erosion for the landscape model: where ice flows, how wide and thick it is, and how fast it grinds its bed.

Ice discharge Q (m³/yr) comes from routing the surface mass balance down the drainage network (lem.ice_flux). From it,
empirical glacier geometry: width W = cw·Q^0.4 (a large outlet glacier moving 4.5·10⁷ m³/yr is ~1.5 km wide), flux per
unit width q = Q/W, thickness H = ch·q^0.4 (~300 m for that glacier) and mean sliding speed u = q/H (~100 m/yr). The
bed erodes at E = Kg·u (abrasion and quarrying scale with sliding speed), spread across the glacier's width with a
plug-flow profile — fast and even over the floor, dying away at the margins — so valleys turn into flat-floored troughs
with steep walls, big glaciers cut deeper than their tributaries (hanging valleys), and thin ice on uplands barely
scours while the outlet glaciers cut down, below sea level where they reach the coast (fjords).
"""
import numpy as np
from scipy import ndimage


def geometry(Q, cw=1.3, ch=4.9, Wmin=40.0, Wmax=3500.0):
    """Width, thickness and mean speed of a glacier carrying Q m³/yr."""
    Q = np.maximum(Q, 0)
    W = np.clip(cw * Q ** 0.4, Wmin, Wmax)
    q = Q / W
    H = ch * q ** 0.4
    u = np.where(H > 0, q / np.maximum(H, 1e-6), 0.0)
    return W, H, u


def erosion(Q, dx, Kg, Qmin=2e3, **geo):
    """Q: n×n ice discharge on the flow lines. Returns (E: bed erosion rate m/yr, Hi: ice thickness m), both spread over
    each glacier's full width; where glaciers overlap the bigger one wins."""
    W, H, u = geometry(Q, **geo)
    ice = Q > Qmin
    E = np.where(ice, Kg * u, 0.0)
    Hi = np.where(ice, H, 0.0)
    # spread by width class: each class gets one exact distance transform from its flow-line cells
    edges = [3 * dx, 150, 300, 600, 1200, 2400, 1e9]
    for lo, hi in zip(edges[:-1], edges[1:]):
        c = ice & (W >= lo) & (W < hi)
        if not c.any():
            continue
        d, (iy, ix) = ndimage.distance_transform_edt(~c, return_indices=True)
        d = d * dx
        Wn = W[iy, ix]
        prof = np.where(d < Wn / 2, 1 - (2 * d / Wn) ** 4, 0.0)
        E = np.maximum(E, Kg * u[iy, ix] * prof)
        Hi = np.maximum(Hi, H[iy, ix] * np.sqrt(prof))
    return E, Hi
