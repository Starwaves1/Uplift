"""Stage B passes: the dramatic, designed shaping on top of the eroded landscape — the great valley's glacial
trough, the caldera, wave-cut coasts with stacks, and the sea floor. All grids are numpy float arrays in metres
(row = y south, col = x east), cell size dx metres.
"""
import numpy as np
from scipy import ndimage


def softmin(a, b, k):
    """Smooth minimum (k metres of rounding where the two surfaces meet)."""
    hh = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * hh - k * hh * (1 - hh)


def polyline_raster(pts_m, dx, n, values):
    """Rasterise a polyline given in metres onto the grid; returns (mask, per-value grids interpolated along it)."""
    pts = np.asarray(pts_m, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    ss = np.arange(0, s[-1], dx * 0.4)
    xs = np.interp(ss, s, pts[:, 0]); ys = np.interp(ss, s, pts[:, 1])
    mask = np.zeros((n, n), bool)
    grids = [np.zeros((n, n)) for _ in values]
    ix = np.clip((xs / dx).astype(int), 0, n - 1); iy = np.clip((ys / dx).astype(int), 0, n - 1)
    mask[iy, ix] = True
    for g, v in zip(grids, values):
        g[iy, ix] = np.interp(ss, s, np.asarray(v, float))
    arc = np.zeros((n, n)); arc[iy, ix] = ss / s[-1]
    return mask, grids, arc


def trough(h, dx, pts_m, floor, width_m, wall=0.0225, power=1.5, soft=25.0, rough=None, reach=4000.0):
    """Carve a glacial trough along a thalweg: a flat floor `width_m` wide, walls rising as wall·e^power (e metres from
    the floor edge) — steep, U-shaped. The trough only removes rock (a smooth min with the terrain), so ridges it cuts
    through become truncated spurs and side valleys are left hanging above the floor."""
    n = h.shape[0]
    mask, (fl, wd), arc = polyline_raster(pts_m, dx, n, [floor, width_m])
    d, (iy, ix) = ndimage.distance_transform_edt(~mask, return_indices=True)
    d = d * dx
    F = fl[iy, ix]; W = wd[iy, ix]
    e = np.maximum(0, d - W / 2)
    z = F + 0.015 * np.minimum(d, W / 2) ** 1.2 / 10 + wall * e ** power
    if rough is not None:
        z = z + rough * np.clip(e / 300, 0, 1)
    out = softmin(h, z, soft)
    near = d < reach
    return np.where(near, out, h), d, F, W


def caldera(h, dx, cx_m, cy_m, r_m, floor, rim_soft=40.0):
    """A collapse caldera: near-vertical inner walls down to a flat floor (which will hold a lake)."""
    n = h.shape[0]
    y, x = np.mgrid[0:n, 0:n] * dx + dx / 2
    r = np.sqrt((x - cx_m) ** 2 + (y - cy_m) ** 2)
    z = floor + np.maximum(0, r - r_m) * 2.2 + np.maximum(0, r_m - r) * 0.02
    return softmin(h, z, rim_soft)


def open_sea_mask(h):
    n = h.shape[0]
    lab, _ = ndimage.label(h <= 0.0)
    ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return np.isin(lab, ids[ids > 0])


def coast(h, dx, style, retreat, rng, face=5.0, platform=-4.0, stacks=60, stack_style=None):
    """Wave-cut coast. style ∈ [0, 1] per cell (0: soft, beaches; 1: rock faces); retreat: how far (m) the sea has cut
    back into the land (per cell). Land within `retreat` of the old shore is planed to a platform below sea level; behind
    it the ground may rise no faster than `face` (a near-vertical rock face), so high ground meets the sea in cliffs
    while low valley mouths keep their beaches. Stacks: pillars of the old headlands left standing on the platform."""
    n = h.shape[0]
    sea = open_sea_mask(h)
    d = ndimage.distance_transform_edt(~sea) * dx                    # metres inland from the old shore
    R = retreat * style
    allowed = platform + face * np.maximum(0, d - R)
    cut = softmin(h, allowed, 6.0)
    out = np.where(style > 0.02, h + (cut - h) * np.clip(style * 3, 0, 1), h)
    # stacks
    sites = []
    if stacks:
        ss = style if stack_style is None else stack_style
        cand = np.argwhere((d > 20) & (d < np.maximum(R - 20, 0)) & (ss > 0.5) & (h > 25))
        if len(cand):
            pick = cand[rng.choice(len(cand), size=min(stacks * 8, len(cand)), replace=False)]
            y, x = np.mgrid[0:n, 0:n]
            for cy, cx in pick:
                if len(sites) >= stacks:
                    break
                if any((cy - sy) ** 2 + (cx - sx) ** 2 < (400 / dx) ** 2 for sy, sx in sites):
                    continue
                sites.append((cy, cx))
                rad = rng.uniform(35, 110) / dx
                top = h[cy, cx] * rng.uniform(0.45, 0.95)
                r0 = max(1, int(rad * 2.5))
                y0, y1, x0, x1 = max(cy - r0, 0), min(cy + r0 + 1, n), max(cx - r0, 0), min(cx + r0 + 1, n)
                rr = np.sqrt((y[y0:y1, x0:x1] - cy) ** 2 + (x[y0:y1, x0:x1] - cx) ** 2) / rad
                prof = platform + (top - platform) * np.clip(1 - rr ** 6, 0, 1)
                out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], prof)
    return out, d, sites


def bathymetry(h, dx, rng_noise, shelf=1500.0):
    """Sea floor: a shallow shelf that deepens offshore (a few metres at the shore, ~25 m at the shelf edge, then down
    toward 200 m), with some texture. Land and inland hollows are untouched."""
    sea = open_sea_mask(h)
    d = ndimage.distance_transform_edt(sea) * dx                     # metres offshore
    depth = 2.5 + 22 * np.clip(d / shelf, 0, 1) ** 0.8 + 180 * np.clip((d - shelf) / 7000, 0, 1) ** 1.3
    floor = -depth * (1 + 0.25 * rng_noise)
    return np.where(sea, floor, h)


def fans(h, dx, A, floor_mask, d_floor, rng, amin=2.5e5, spacing=500.0, maxn=80):
    """Alluvial fans where side streams leave their valleys onto a flat floor: a low cone of gravel from the stream's
    mouth, its radius and height growing with the catchment. Only ever adds material, and only on the floor."""
    n = h.shape[0]
    # stream cells just outside the floor, draining toward it
    band = (~floor_mask) & (d_floor < 250) & (A > amin)
    cand = np.argwhere(band)
    if not len(cand):
        return h, []
    order = np.argsort(-A[cand[:, 0], cand[:, 1]])
    sites = []
    y, x = np.mgrid[0:n, 0:n]
    out = h.copy()
    for k in order:
        cy, cx = cand[k]
        if len(sites) >= maxn:
            break
        if any((cy - sy) ** 2 + (cx - sx) ** 2 < (spacing / dx) ** 2 for sy, sx, _ in sites):
            continue
        a = A[cy, cx]
        R = np.clip(90 * np.sqrt(a / 1e6) * 3.2, 180, 900)             # m
        H = np.clip(R * 0.07, 12, 60)
        slope = H / R
        r0 = int(R / dx) + 2
        y0, y1, x0, x1 = max(cy - r0, 0), min(cy + r0 + 1, n), max(cx - r0, 0), min(cx + r0 + 1, n)
        rr = np.sqrt((y[y0:y1, x0:x1] - cy) ** 2 + (x[y0:y1, x0:x1] - cx) ** 2) * dx
        fl = h[y0:y1, x0:x1][floor_mask[y0:y1, x0:x1]]
        if not fl.size:
            continue
        apex = min(h[cy, cx], np.median(fl) + H)
        cone = apex - rr * slope * (1 + 0.6 * (rr / R) ** 2)
        m = floor_mask[y0:y1, x0:x1] | (rr < R * 0.35)
        blk = out[y0:y1, x0:x1]
        out[y0:y1, x0:x1] = np.where(m & (rr < R), np.maximum(blk, cone), blk)
        sites.append((cy, cx, R))
    return out, sites


def beds(h, dx, weight, warp, step=30.0, cliff=0.32):
    """Flat-lying sedimentary beds: each `step` metres of rock is a soft layer (eroded back into a bench) under a hard
    cap (standing as a cliff), so slopes become staircases of ledges and walls while flat tops stay flat. warp (m):
    gentle undulation of the beds; weight: where to apply (0..1)."""
    b = h + warp
    t = b / step
    f = t - np.floor(t)
    # soft rock: benches (the profile rises only a little); hard cap: the last `cliff` of each bed rises steeply
    g = 0.18 * np.clip(f / (1 - cliff), 0, 1) + 0.82 * np.clip((f - (1 - cliff)) / cliff, 0, 1) ** 0.7
    ht = (np.floor(t) + g) * step - warp
    gy, gx = np.gradient(h, dx)
    slope = np.sqrt(gx * gx + gy * gy)
    w = weight * np.clip((slope - 0.06) / 0.2, 0, 1)
    return h + (ht - h) * w


def lakes(h, dx, lem, min_depth=1.2, min_area=4e4):
    """Water in the closed basins of the finished land (not the sea): fill every depression to its spill level
    (priority-flood), keep those deep and large enough to be lakes. Returns a label grid (0 = none) and a table of
    (label, level m, area m², bbox (y0, x0, y1, x1) in cells)."""
    n = h.shape[0]
    sea = open_sea_mask(h)
    fixed = (sea | np.pad(np.zeros((n - 2, n - 2), bool), 1, constant_values=True)).ravel()
    hf = lem.priority_flood(h.ravel().astype(np.float64), fixed, n, 0.0).reshape(n, n)
    depth = hf - h
    wet = (depth > 0.05) & ~sea & (h > -1.0)
    lab, nlab = ndimage.label(wet)
    out = np.zeros((n, n), np.int32)
    table = []
    if nlab == 0:
        return out, table
    objs = ndimage.find_objects(lab)
    for k, sl in enumerate(objs, start=1):
        m = lab[sl] == k
        area = m.sum() * dx * dx
        dmax = depth[sl][m].max()
        if area < min_area or dmax < min_depth:
            continue
        level = float(np.median(hf[sl][m]))
        lid = len(table) + 1
        out[sl][m] = lid
        table.append((lid, level, float(area), (sl[0].start, sl[1].start, sl[0].stop, sl[1].stop)))
    return out, table
