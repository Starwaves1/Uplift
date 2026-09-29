"""The south-east causse (ticket 03): a limestone tableland (~530–650 m) cut by a Verdon-style gorge that winds across it
and reaches the east coast as a calanque. Grids are numpy float arrays in metres (row = y south, col = x east), cells dx
metres; designed lines are in km on the design grid (x east, y south, origin at the island's north-west corner).

The landform (after the Causses Méjean and de Sauveterre, the Gorges du Verdon and du Tarn, the Cirque de Navacelles,
Cap Canaille and the Calanques)
  tableland   the causse top is the surface of a resistant bed, tilted gently from ~650 m against the western hills to
              ~530 m at the east coast and rising a little onto the flank of the coastal peak, which stands out of it
              like Mont Ventoux over the Vaucluse plateau. Karst has left it low swells and rounded hills (puechs),
              pocked it with dolines, and drained it underground: no streams, only dry valleys (combes) that end hanging
              at the canyon rims.
  strata      flat-lying beds parallel to the top (STRATA): a thin upper wall, a thin ledge (the vire), the great main
              wall, a second ledge, a lower wall, then marl slopes and benches around a basal wall, and massive rock at
              the bottom. Every wall — gorge, side canyons, escarpment, sea cliffs — is cut through the same column, so
              the ledges run at the same depth everywhere; their thickness wanders over kilometres, the ledges widen and
              pinch out, and couloirs (gullies) notch the walls from rim to foot.
  walls       are built sideways: each band retreats r metres horizontally per metre of height (~0.2 for a wall, ~3 for
              a ledge, ~1 for marl), so a wall's offset from its foot is the running sum C(d) of r down through the beds
              it cuts (d = depth below the top bed); inverting that sum gives the height at any distance from a canyon
              floor, or from the tableland's rim.
  gorge       a winding thalweg (GORGE) with per-vertex floor, floor width and openness (a scale on every band's
              retreat: the narrows vs the open reaches); on bends the outer bank is undercut and the inner bank opens
              into a slip-off spur (ingrown meanders). The river comes out of the western hills into a cliff-ringed
              basin (the site for ticket 04's pillars), runs through the narrows, cuts through the neck of an abandoned
              meander loop (LOOP, after Navacelles: a dry ring canyon round a lower rock core), and reaches the sea as a
              calanque — the floor is below sea level for its last ~1.3 km, a narrow inlet between ~500 m walls.
  side canyons dry valleys on the causse that deepen downstream through the beds and join the gorge, some hanging.
  escarpment  the tableland's edge is the same column run outward from the rim: a stepped wall over a talus apron where it
              meets the hills inland, sheer where it meets the sea (east and south-east).
"""
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw
import fields as fx
import lem
from passes import softmin, spline

# ── the design (km; heights m) ── (to move to design.py)
WINDOW = (39.0, 30.0, 58.0, 47.0)          # x0, y0, x1, y1: the pass only touches this box
# the tableland's rim, clockwise from the north-west: where the causse top breaks into the escarpment. North it stands on
# the divide over the lowland and climbs onto the coastal peak's flank; east and south-east it runs ~0.4 km inside the
# old coast so the wall reaches the sea; west it wraps the head basin, leaving a gap where the river comes in.
RIM = [(45.3, 35.4), (46.4, 34.6), (47.6, 34.35), (48.8, 34.3), (49.8, 34.25), (50.7, 34.2), (51.5, 34.0), (52.3, 34.0),
       (53.1, 34.4), (53.9, 35.1), (54.3, 35.9), (54.2, 36.8), (53.8, 37.6), (53.4, 38.4), (53.2, 39.3), (53.3, 40.2),
       (53.3, 41.1), (52.9, 41.9), (52.1, 42.6), (51.4, 42.8), (50.8, 42.4), (50.0, 41.95), (49.0, 41.85), (48.0, 42.0),
       (47.0, 42.1), (46.1, 41.8), (45.3, 41.35), (44.5, 41.05), (43.8, 40.5), (43.85, 39.6), (44.4, 39.0), (45.0, 38.5),
       (45.3, 37.6), (45.2, 36.8), (45.2, 36.0)]
TOP = (650.0, 530.0, 44.5, 54.0)           # the top bed: m at the west, m at the east coast, x (km) where the tilt runs
PEAK = (52.9, 33.3, 2.4, 70.0)             # the top rises onto the coastal peak's flank: centre (km), radius (km), m
# the gorge thalweg: from the river's valley in the western hills, through the head basin, the narrows and the cutoff
# neck, to ~0.7 km out at sea. Per vertex: floor (m), floor width (m), openness (× every band's retreat)
GORGE = dict(
    pts=[(42.6, 40.8), (43.5, 40.4), (44.8, 40.0), (45.9, 39.75), (46.6, 39.3), (47.1, 38.8), (47.7, 38.55),
         (48.3, 38.75), (48.75, 39.0), (49.4, 39.05), (50.0, 38.8), (50.5, 38.35), (51.1, 38.1), (51.8, 38.25),
         (52.4, 38.65), (53.0, 38.9), (53.7, 39.0), (54.4, 39.05)],
    floor=[290, 255, 225, 205, 188, 172, 157, 142, 130, 114, 98, 81, 62, 40, 6, -10, -22, -30],
    width=[140, 150, 1000, 90, 60, 65, 75, 85, 75, 55, 85, 95, 105, 115, 130, 150, 170, 200],
    open=[2.4, 1.8, 1.7, 1.3, 1.05, 1.1, 1.3, 1.5, 1.4, 1.1, 1.4, 1.6, 1.5, 1.3, 1.1, 1.0, 0.95, 1.0])
# the abandoned meander (Navacelles): a dry ring canyon, its floor perched above today's river, round a rock core
LOOP = dict(pts=[(48.6, 38.95), (48.4, 39.45), (48.6, 39.95), (49.1, 40.2), (49.6, 40.0), (49.8, 39.5), (49.55, 39.05)],
            floor=[153, 155, 156, 156, 155, 153, 150], width=[160] * 7, open=[1.3] * 7)
CORE = (49.1, 39.55, 0.45, 200.0, 80.0)    # the meander core: centre (km), radius (km), its foot and dome below the causse (m)
# side canyons: dry valleys on the causse that deepen downstream through the beds and join the gorge; the west one is a
# tributary gorge that brings a valley of the western hills in (the Artuby of this Verdon), the south-west ravine drains
# the hills behind the head basin into it
SIDES = [
    dict(name='north', pts=[(50.6, 34.9), (50.5, 35.7), (50.3, 36.3), (50.15, 36.8), (49.75, 37.3), (49.85, 37.9), (50.25, 38.55)],
         floor=[600, 575, 520, 440, 320, 200, 100], width=[30, 30, 35, 40, 45, 55, 65], open=[2.2, 1.8, 1.4, 1.2, 1.1, 1.1, 1.1]),
    dict(name='west', pts=[(43.5, 37.55), (44.2, 37.7), (44.9, 37.95), (45.6, 38.1), (46.2, 38.4), (46.75, 38.95)],
         floor=[310, 262, 238, 222, 205, 182], width=[70, 60, 55, 50, 50, 55], open=[1.6, 1.3, 1.15, 1.05, 1.05, 1.1]),
    dict(name='southeast', pts=[(52.2, 41.9), (51.7, 41.2), (51.85, 40.4), (51.5, 39.7), (51.55, 39.1), (51.4, 38.3)],
         floor=[545, 520, 450, 330, 185, 68], width=[25, 30, 35, 45, 55, 65], open=[2.2, 1.7, 1.3, 1.15, 1.1, 1.1]),
    dict(name='ravine', pts=[(44.0, 41.95), (44.35, 41.45), (44.5, 40.9), (44.8, 40.35)],
         floor=[300, 270, 248, 228], width=[70, 60, 55, 60], open=[1.8, 1.5, 1.25, 1.2]),
]
# blind canyons cut back into the tableland from its edge: a reculée in the north escarpment, and a small calanque on
# the south coast (the Calanques are a string of such inlets), fed by a dry valley
RECULEES = [
    dict(name='reculee', pts=[(47.15, 33.7), (47.3, 34.3), (47.45, 34.9), (47.5, 35.3)],
         floor=[350, 395, 450, 500], width=[170, 190, 220, 240], open=[1.9, 1.6, 1.35, 1.25]),
    dict(name='cove', pts=[(48.9, 43.0), (48.85, 42.4), (48.75, 41.9), (48.6, 41.4)],
         floor=[-22, -12, 2, 70], width=[150, 120, 90, 70], open=[0.95, 0.9, 1.0, 1.2]),
]
# dry valleys on the top (smooth, no beds): per vertex depth below the causse (m) and half-width (m); they hang at the rims
COMBES = [
    dict(pts=[(46.8, 35.3), (46.9, 36.3), (46.6, 37.3), (46.3, 37.95)], depth=[4, 16, 26, 34], width=[140, 190, 210, 190]),
    dict(pts=[(48.0, 35.0), (48.2, 36.2), (48.7, 37.2), (48.45, 38.0)], depth=[4, 18, 28, 36], width=[150, 200, 220, 200]),
    dict(pts=[(53.1, 35.5), (52.6, 36.6), (52.35, 37.6)], depth=[4, 20, 34], width=[150, 200, 200]),
    dict(pts=[(50.1, 41.35), (49.75, 40.85)], depth=[4, 26], width=[160, 180]),
    dict(pts=[(47.9, 41.6), (48.1, 40.8), (47.75, 39.35)], depth=[4, 18, 30], width=[140, 180, 190]),
    dict(pts=[(45.9, 41.4), (46.4, 40.8), (46.4, 40.1)], depth=[4, 16, 28], width=[140, 170, 180]),
    dict(pts=[(49.4, 40.5), (49.0, 41.0), (48.65, 41.3)], depth=[4, 18, 30], width=[140, 180, 190]),
]
PILLARS = (44.8, 40.0, 0.45)               # ticket 04: the head basin's floor — centre (km), free radius (km)
# the column, from high above the top bed down: (thickness m, retreat r m/m, hardness 0..1, thickness wander ±)
STRATA = [
    (3000, 1.5, 0.2, 0.0),   # above the top bed: swells, puechs and any higher hills — hillslopes (~34°)
    (10, 3.0, 0.3, 0.3),     # soil and the rounded lip of the rim
    (70, 0.2, 1.0, 0.35),    # the rim cliff
    (12, 4.0, 0.4, 0.5),     # the vire: a ledge you could walk along
    (150, 0.17, 1.0, 0.3),   # the main wall: massive limestone
    (25, 3.5, 0.4, 0.5),     # ledge
    (60, 0.8, 0.5, 0.4),     # steep marly limestone
    (60, 0.26, 1.0, 0.35),   # lower wall
    (100, 1.2, 0.35, 0.3),   # marl slope
    (50, 0.3, 1.0, 0.35),    # basal wall
    (60, 1.3, 0.35, 0.3),    # marl
    (3000, 0.38, 0.9, 0.0),  # massive basement: the sea cliffs
]
D0 = -STRATA[0][0]                         # depth (below the top bed) where the column starts
APRON = (6, 1.3)                           # inland escarpments: bands from this index down spread × (1 + this) into talus


class Column:
    """The strata at every cell: band thicknesses t_i and retreats r_i (arrays). C(d) is the horizontal distance a wall
    covers from the top of the column down to depth d; inv(c) the depth where it has covered c; band(d) the band index."""

    def __init__(self, t, r):
        self.t, self.r = t, [np.maximum(ri, 0.05) for ri in r]

    def C(self, d):
        s, top = 0.0, D0
        for t, r in zip(self.t, self.r):
            s = s + r * np.clip(d - top, 0, t)
            top = top + t
        return s

    def inv(self, c):
        rem = np.maximum(np.asarray(c, float), 0.0)
        d = np.full(rem.shape, np.nan); top = D0
        for t, r in zip(self.t, self.r):
            cap = r * t
            m = np.isnan(d) & (rem <= cap)
            d = np.where(m, top + rem / r, d)
            rem = rem - cap; top = top + t
        return np.where(np.isnan(d), top + rem / self.r[-1], d)

    def band(self, d):
        top = D0 + np.zeros_like(d); b = np.zeros(d.shape, int)
        for i, t in enumerate(self.t):
            top = top + t
            b = np.where(d > top, i + 1, b)
        return np.clip(b, 0, len(self.t) - 1)


def _line(pts_km, values, X, Y, reach, step=6.0, smooth_m=250.0):
    """The nearest point of a thalweg (Catmull-Rom through the vertices) for every cell: distance (m), side (±1), the
    thalweg's signed curvature there (1/m, smoothed along it), and the per-vertex values interpolated there."""
    P, vals = spline([(x * 1000, y * 1000) for x, y in pts_km], values, step=step)
    T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    kap = ndimage.gaussian_filter1d(np.gradient(np.unwrap(np.arctan2(T[:, 1], T[:, 0])), s + 1e-6 * np.arange(len(s))),
                                    smooth_m / step, mode='nearest')
    q = np.stack([X.ravel(), Y.ravel()], -1)
    d, i = cKDTree(P).query(q, distance_upper_bound=reach)
    ok = np.isfinite(d); i = np.where(ok, i, 0)
    v = q - P[i]
    side = np.sign(T[i, 0] * v[:, 1] - T[i, 1] * v[:, 0])
    sh = X.shape
    return dict(d=np.where(ok, d, 1e5).reshape(sh), side=side.reshape(sh), kap=kap[i].reshape(sh), ok=ok.reshape(sh),
                vals=[a[i].reshape(sh) for a in vals], P=P, s=s, kap_line=kap)


def _closed_spline(pts, step):
    P = np.asarray(pts, float); m = len(P)
    out = []
    for i in range(m):
        p0, p1, p2, p3 = P[i - 1], P[i], P[(i + 1) % m], P[(i + 2) % m]
        for t in np.linspace(0, 1, max(2, int(np.linalg.norm(p2 - p1) / step)), endpoint=False):
            out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    return np.array(out)


def gorge_radius(line=None):
    """Smallest bend radius (m) of a designed thalweg (default: the gorge) — a glider needs ≥ ~400 m."""
    c = line or GORGE
    P, _ = spline([(x * 1000, y * 1000) for x, y in c['pts']], (), step=5.0)
    T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    k = ndimage.gaussian_filter1d(np.gradient(np.unwrap(np.arctan2(T[:, 1], T[:, 0])), s), 20)
    m = min(40, len(k) // 4)
    return float(1 / np.abs(k[m:len(k) - m]).max())


def causse(h, dx, seed=0):
    """Raise the south-east tableland and cut the gorge, its loop, side canyons and calanque into it (see the module
    docstring). h: the finished island (m). Returns (h, info); info holds what the later passes need (full-size grids):
      zone        0..1  the designed walls and ledges: talus must leave them (talus_tan ≈ 5 there)
      hard        0..1  rock hardness of the surface band (1 = a massive wall) → droplet hardness
      talus_tan         suggested talus angle (tan) per cell (0.9 elsewhere)
      karst       0..1  the causse top: water sinks (no lakes in its dolines, few droplets)
      floor       bool  the gorge, loop and side-canyon floors above the sea (the river goes here)
      calanque    0..1  the drowned gorge and its walls: no wave-cut retreat, no stacks
      coast_style 0..1  the tableland's sea cliffs: rock-face coast
      keep        m     designed sea floor to keep (bathymetry keep; 1e9 elsewhere): the drowned inlets, and the plunge
                        at the foot of the sea cliffs
      fill        bool  closed basins the tableland dammed, filled with alluvium to their spill level
      region      0..1  the tableland with its walls (for materials: white limestone)
      thalwegs          [(name, (k, 2) km)] the gorge, loop and side canyons
      pillars           (x, y, r km, floor m) the head basin, for ticket 04
    """
    n = h.shape[0]
    L = n * dx
    x0k, y0k, x1k, y1k = WINDOW
    j0, j1, i0, i1 = int(x0k * 1000 / dx), int(x1k * 1000 / dx), int(y0k * 1000 / dx), int(y1k * 1000 / dx)
    H0 = h[i0:i1, j0:j1].astype(np.float64)
    sh = H0.shape
    X, Y = np.meshgrid((np.arange(j0, j1) + 0.5) * dx, (np.arange(i0, i1) + 0.5) * dx)
    Xk, Yk = X / 1000, Y / 1000
    nz = lambda feat_m, octv, sd, gain=0.5: fx.fbm(n, L / feat_m, octv, 900 + 37 * sd + seed, gain=gain)[i0:i1, j0:j1].double().cpu().numpy()
    ridged = lambda a, w: np.clip(1 - np.abs(a) / w, 0, 1) ** 2         # thin lines along the noise's zero crossings
    rng = np.random.default_rng(1234 + seed)

    # ── the column, wandering from place to place ──
    n_t = [nz(2600, 2, 10 + k) for k in range(4)]
    n_ledge, n_wall = nz(900, 3, 4), nz(1300, 3, 5)
    th, rr = [], []
    for k, (t, r, hd, var) in enumerate(STRATA):
        th.append(t * np.clip(1 + var * n_t[k % 4] * (-1) ** k, 0.25, 2.0))
        if r >= 2.0:
            rr.append(r * np.clip(1 + 0.6 * n_ledge * (-1) ** k, 0.3, 2.2))        # ledges widen and pinch out
        elif hd >= 0.9:
            rr.append(r * np.clip(1 + 0.3 * n_wall, 0.6, 1.5))
        else:
            rr.append(r * np.clip(1 + 0.3 * n_ledge, 0.5, 1.6))
    # by the sea the waves strip the talus: the soft beds stand as steep as the walls (sheer sea cliffs and calanque)
    inland = np.clip((ndimage.distance_transform_edt(H0 >= 0) * dx - 500) / 1500, 0, 1)
    soft = [k for k, st in enumerate(STRATA) if 0.5 <= st[1] < 2.0]
    rr = [r * (0.3 + 0.7 * inland) if k in soft else r for k, r in enumerate(rr)]
    col = Column(th, rr)
    hard_b = np.array([s[2] for s in STRATA])

    # ── the top bed and the causse surface ──
    tw, te, xa, xb = TOP
    T0 = tw + (te - tw) * np.clip((Xk - xa) / (xb - xa), 0, 1) ** 1.2
    px, py, pr, pa = PEAK
    T0 = T0 + pa * np.exp(-((Xk - px) ** 2 + (Yk - py) ** 2) / pr ** 2)
    S = T0 + 9 * nz(4000, 2, 3)                                   # the strata reference: the top bed, gently warped
    T = S + 22 * nz(2600, 3, 1) + 9 * nz(900, 2, 2) + 5 * nz(350, 2, 9) + 2 * nz(130, 2, 16)
    for _ in range(9):                                            # puechs: low rounded hills
        cx, cy = rng.uniform(45.5, 53.0) * 1000, rng.uniform(35.5, 41.5) * 1000
        R = rng.uniform(400, 850)
        T += rng.uniform(18, 45) * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / R ** 2)
    for cb in COMBES:                                             # dry valleys, smooth-sided
        f = _line(cb['pts'], (cb['depth'], cb['width']), X, Y, reach=900.0)
        D, W = f['vals']
        T -= np.where(f['ok'], D * np.exp(-(f['d'] / W) ** 2), 0)

    # ── the rim: a wandering line with promontories, bays and couloirs ──
    n_butt = nz(450, 4, 6, gain=0.6)                             # buttresses: pushes every wall in and out
    cou = ridged(nz(380, 3, 12), 0.35)                            # couloirs: gullies notched into the walls
    rim = _closed_spline([(x * 1000, y * 1000) for x, y in RIM], 40.0)
    img = Image.new('L', (sh[1], sh[0]), 0)
    ImageDraw.Draw(img).polygon([((x - j0 * dx) / dx, (y - i0 * dx) / dx) for x, y in rim], fill=1)
    inside = np.asarray(img).astype(bool)
    s_rim = (ndimage.distance_transform_edt(inside) - ndimage.distance_transform_edt(~inside)) * dx
    s_rim = s_rim + 230 * nz(1600, 3, 7, gain=0.55) + 60 * nz(420, 2, 8) + 55 * n_butt - 130 * cou

    # ── the canyons (their geometry first: dolines keep clear of them) ──
    lines = [('gorge', GORGE), ('loop', LOOP)] + [(c['name'], c) for c in SIDES + RECULEES]
    frames = [(nm, _line(c['pts'], (c['floor'], c['width'], c['open']), X, Y, reach=3000.0)) for nm, c in lines]
    dcan = np.min([np.maximum(f['d'] - f['vals'][1] / 2, 0) for _, f in frames], axis=0)

    # the meander core: a rounded rock hill well below the causse (the slip-off spur the river swung round)
    cx, cy, cr, cfoot, cdome = CORE
    rc = np.hypot(Xk - cx, Yk - cy) / cr
    dome = S - cfoot + cdome * np.clip(1 - rc * rc, 0, 1) + 6 * nz(300, 2, 13)
    wc = np.clip((1.4 - rc) / 0.4, 0, 1)
    T = T * (1 - wc) + np.minimum(T, dome) * wc

    # dolines: bowls 25–110 m across, scattered over the top clear of rims and canyons
    ok = (s_rim > 200) & (dcan > 300) & (rc > 1.5)
    cand = np.argwhere(ok)
    ndol = int(ok.sum() * dx * dx / 1e6 * 3.0)
    placed = []
    if len(cand):
        yy, xx = np.mgrid[0:sh[0], 0:sh[1]]
        for cy_, cx_ in cand[rng.choice(len(cand), size=min(ndol * 4, len(cand)), replace=False)]:
            if len(placed) >= ndol:
                break
            R = float(np.clip(rng.lognormal(np.log(50), 0.45), 22, 110))
            if any((cy_ - a) ** 2 + (cx_ - b) ** 2 < ((R + c) * 1.15 / dx) ** 2 for a, b, c in placed):
                continue
            placed.append((cy_, cx_, R))
            r0 = int(R / dx) + 2
            ya, yb, xa_, xb_ = max(cy_ - r0, 0), min(cy_ + r0 + 1, sh[0]), max(cx_ - r0, 0), min(cx_ + r0 + 1, sh[1])
            q = np.hypot(yy[ya:yb, xa_:xb_] - cy_, xx[ya:yb, xa_:xb_] - cx_) * dx / R
            T[ya:yb, xa_:xb_] -= R * rng.uniform(0.08, 0.2) * np.clip(1 - q * q, 0, 1) ** 2

    # ── the escarpment: the column run outward from the rim; inland its lower beds spread into a talus apron ──
    ce = Column(th, [r * (1 + APRON[1] * inland) if k >= APRON[0] else r for k, r in enumerate(rr)])
    k_esc = np.clip(1.3 + 0.35 * nz(2000, 2, 14), 0.9, 1.8) * (1 - 0.25 * (1 - inland))
    z_esc = S - ce.inv(ce.C(0.0) - s_rim / k_esc)
    block = softmin(T, z_esc, 6.0)
    # where the tableland meets the sea the old coastal hills in front of it are gone (the cliff is the coast): cut them
    # to a wave-cut platform; inland the old hills stay wherever they stand higher than the escarpment (a smooth max)
    wsea = np.clip(1 - inland / 0.3, 0, 1) * np.clip((s_rim + 600) / 200, 0, 1)
    Hc = H0 + (np.minimum(H0, -5.0) - H0) * wsea
    H1 = -softmin(-Hc, -block, 10.0)

    # ── carve the canyons ──
    BIG = 1e6
    Z = np.full(sh, BIG)
    floor = np.zeros(sh, bool)
    n_open = nz(2000, 2, 15)
    for name, f in frames:
        F, W, K = f['vals']
        asym = np.clip(f['side'] * f['kap'] * 480.0, -1, 1)       # + on the inside of a bend
        K = K * np.exp(0.5 * asym) * np.clip(1 + 0.2 * n_open, 0.75, 1.3)
        e = f['d']
        beyond = np.clip((e - W / 2) / 60, 0, 1)
        e = e + (60 * n_butt + 110 * cou) * beyond
        z = S - col.inv(col.C(S - F) - np.maximum(0.0, e - W / 2) / K)
        z = np.where(e < W / 2, F + 0.02 * e, z)
        z = np.where(f['ok'], np.minimum(z, BIG), BIG)
        floor |= f['ok'] & (e < W / 2) & (F > 0)
        Z = softmin(Z, z, 3.0)
    H2 = softmin(H1, Z, 4.0)
    gy, gx = np.gradient(H2, dx)
    slope = np.hypot(gx, gy)
    karst = np.clip((s_rim - 60) / 200, 0, 1) * np.clip((dcan - 150) / 250, 0, 1) * (slope < 0.3)
    karst = ndimage.gaussian_filter(karst.astype(float), 2.0)

    # ── drain what the tableland dams: new closed basins (outside the karst) fill with alluvium to their spill level ──
    def flood(a):
        lab, _ = ndimage.label(a <= 0)                            # the open sea: below 0 and reaching the window's edge
        ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        m = max(a.shape)
        q = np.full((m, m), 1e4); q[:a.shape[0], :a.shape[1]] = a
        fix = np.ones((m, m), bool); fix[1:a.shape[0] - 1, 1:a.shape[1] - 1] = False
        fix[:a.shape[0], :a.shape[1]] |= np.isin(lab, ids[ids > 0])
        return lem.priority_flood(q.ravel(), fix.ravel(), m, 0.01).reshape(m, m)[:a.shape[0], :a.shape[1]]
    hf = flood(H2)
    fill = (hf - H2 > 0.3) & (karst < 0.3) & (hf - H2 > flood(H0) - H0 + 0.3)
    H2 = np.where(fill, hf, H2)

    # ── what the later passes need ──
    b = col.band(S - H2)
    changed = np.abs(H2 - H0) > 3.0
    walls = changed & ((S - H2 > 8) | (s_rim < 0)) & ((slope > 0.35) | (hard_b[b] < 0.5) & (slope > 0.12))
    zone = np.clip(ndimage.gaussian_filter(walls.astype(float), 2.0) * 3, 0, 1)
    # the drowned reaches (the calanque and the cove) and their walls
    calanque = np.max([np.clip((40 - f['vals'][0]) / 40, 0, 1) * np.clip(1 - (f['d'] - 800) / 300, 0, 1) * f['ok']
                       for _, f in frames], axis=0)
    coast_style = ((s_rim < 300) & (s_rim > -1500) & (inland < 0.5)).astype(float)
    coast_style = ndimage.gaussian_filter(coast_style, 4.0) * (1 - calanque)
    near_land = ndimage.distance_transform_edt(H0 < 0) * dx < 300          # the inlets, not a trench across the shelf
    keep = np.where((Z < 0) & (calanque > 0.5) & near_land, Z, 1e9)
    # deep water at the foot of the sea cliffs (Cap Canaille drops into ~30 m): off the tableland's cliffs the floor falls
    # to −30 m within 250 m of the shore and stays there until the shelf is as deep (~2 km out); it fades out along the
    # coast where the cliffs end
    sea = H2 <= 0
    dsh = ndimage.distance_transform_edt(sea) * dx
    inlet = (calanque > 0.2) & (H0 > -3)                          # the inlets cut into the old land keep their own floor
    cliffs = ~sea & ndimage.binary_dilation(sea) & (coast_style > 0.5) & ~inlet
    dfront = ndimage.distance_transform_edt(~cliffs) * dx
    wf = ndimage.gaussian_filter(np.clip(1 - (dfront - dsh) / 300, 0, 1), 12) * ~inlet
    keep = np.minimum(keep, np.where(sea & (dsh < 2200), -8 - 22 * np.clip(dsh / 250, 0, 1) * wf, 1e9))
    region = np.clip((s_rim + 900) / 600, 0, 1)                                 # the tableland and its walls (materials)

    out = h.copy()
    out[i0:i1, j0:j1] = H2

    def full(a, pad=0.0, dtype=np.float32):
        o = np.full((n, n), pad, dtype=dtype)
        o[i0:i1, j0:j1] = a
        return o
    info = dict(zone=full(zone), hard=full(hard_b[b] * zone), talus_tan=full(0.9 + 4.1 * zone, 0.9), karst=full(karst),
                floor=full(floor, False, bool), fill=full(fill, False, bool), region=full(region),
                calanque=full(calanque), coast_style=full(coast_style), keep=full(keep, 1e9),
                thalwegs=[(nm, np.array(c['pts'])) for nm, c in lines],
                pillars=(PILLARS[0], PILLARS[1], PILLARS[2], float(GORGE['floor'][2])),
                window=(i0, i1, j0, j1), min_radius=gorge_radius(), radii={nm: gorge_radius(c) for nm, c in lines},
                dolines=len(placed), filled=float(fill.sum() * dx * dx / 1e6))
    return out, info
