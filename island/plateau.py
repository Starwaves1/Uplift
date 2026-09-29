"""The south-east causse and its gorge (ticket 03): Mediterranean canyon country built as one designed pass.

The landform, after the Causses (Méjean, Sauveterre), the Gorges du Verdon and du Tarn, the Cirque de Navacelles and the
Calanques (Cap Canaille, Sormiou, En-Vau):
  causse      a limestone tableland filling the south-east between the ridge and the sea, ~645 m against the mountains
              and ~500 m at the coast (a 1.5% tilt you cannot see but the water can), with coastal domes (capes) the sea
              cliffs cut through; its top broad and calm: low swells, scattered rounded hills (puechs), doline pits, and
              shallow dry valleys (valats) that wander to the rims and hang there as notches above the gorge
  strata      the whole block is flat-lying beds, and every wall — gorge, escarpment, sea cliff — is cut through the same
              column: a massive cap (the white rim cliff), thin-bedded ledges, a second massive wall, more ledges, a
              massive inner-gorge band at the bottom. A wall's shape is a function of absolute elevation, so ledges line
              up across the gorge, along it, and around the whole plateau
  gorge       a designed incised-meander thalweg from the cirque to the east coast, 420–520 m deep, its floor a
              narrow flat (the future river), the walls asymmetric on the bends (undercut cliffs outside, stepped
              slip-off slopes inside), buttresses and couloirs along them
  cirque      where the streams off the ridge enter the limestone the gorge opens into a Navacelles-style amphitheatre —
              the site kept free for ticket 04's rock pillars
  strike valley  the causse stops short of the ridge: a valley along the ridge foot, north and south of the cirque,
              gathers the mountain streams into it (the river's upper course)
  canyons     dry box canyons (reculées) feeding the gorge from the causse and biting into the north escarpment, headed
              by cliff amphitheatres
  calanques   the gorge's last 1.5 km is drowned: a narrow inlet between the rim cliffs, a pebble beach at its head; two
              short calanques notch the south coast
  escarpment  where the causse meets lower country (the north, and the strike valley) it breaks off in a lobate
              staircase of the same beds
  sea cliffs  where it meets the sea (east and south) the same column plunges into deep water: a sheer face 250–420 m
              high, then broad ledges and scree slopes stepping back to the causse's edge (the Calanques' profile)

The pass only builds the ground; droplets, talus, coast and sea floor run after it in finalize — the returned info tells
them where to hold back (see plateau()). Coordinates: km on the design grid (x east, y south); heights m; grids numpy
float arrays (row = y south, col = x east), cell size dx m.
"""
import numpy as np
from scipy import ndimage
import fields as fx
import lem
from passes import softmin, spline

BOX = (37.0, 28.0, 61.0, 52.0)          # km (x0, y0, x1, y1): the square crop the pass works in

# ── the causse ──
# footprint (km), clockwise from the north-west; the east and south vertices lie out at sea (the coast is the edge
# there). West: the causse stops short of the ridge, leaving a strike valley along the ridge foot (see UPPER).
CAUSSE = [(45.55, 34.45), (46.3, 33.85), (47.6, 33.45), (49.6, 33.5), (51.2, 33.8), (52.6, 34.1), (56.5, 33.8),
          (56.5, 46.5), (46.5, 46.5), (45.6, 44.2), (45.75, 42.3), (45.9, 40.6), (46.0, 39.35), (45.55, 36.9),
          (45.95, 36.05), (45.7, 35.2)]
TOP_X, TOP_Z = [44.0, 54.0], [645.0, 500.0]       # top surface along x (m): high against the ridge, lower at the coast
CAPES = [(53.25, 41.55, 1.4, 170.0),               # domes on the coast that the sea cliffs cut through, so the
         (48.5, 42.95, 1.2, 150.0),                 # cliffs peak there (Cap Canaille, Grande Tête): x, y, r km, m
         (53.45, 35.5, 1.1, 140.0)]
COASTAL = 90.0                                      # m: elsewhere the coast sags (~3 km), so the cliff line rises
                                                    # and falls instead of running as one even wall
SWELL = 30.0                                        # m: amplitude of the low karst swells (~2.5 km)
PUECH = 70.0                                        # m: height of the scattered rounded hills
ROUGH = 3.0                                         # m: fine unevenness of the top (~150 m)
DOLINES = 520                                       # doline pits over the causse (radius 35–95 m, 4–16 m deep)
VALAT = 38.0                                        # m: depth of the largest dry valleys
LOBES = 450.0                                       # m: how far the escarpment's promontories and re-entrants wander
ESC_SPREAD = 2.4                                    # bench run on the escarpment, relative to the gorge walls

# ── the strata: one column for every wall ── (base m, top m, bed thickness m, cliff fraction, soft slope at the top)
# within a bed, going up: a sloping ledge (slope BENCH) steepening through the soft layer to `soft` (scree), then the
# hard layer's cliff (slope CLIFF). The massive units are almost all cliff.
STRATA = [(-400, 60, 30, 0.92, 1.4),      # inner gorge: massive, near-vertical (the calanque's walls, the narrows)
          (60, 200, 47, 0.62, 1.3),       # lower ledges
          (200, 340, 70, 0.88, 1.2),      # middle wall
          (340, 480, 47, 0.60, 1.3),      # upper ledges
          (480, 1600, 80, 0.94, 1.2)]     # the cap: the white rim cliff
CLIFF, BENCH = 5.0, 0.2

# ── the gorge ── thalweg (km) from the ridge foot through the cirque to 1 km out to sea; per vertex: floor (m), floor
# width (m), bench spread (×). The floor crosses sea level ~1.6 km from the coast: the calanque.
GORGE = [(45.3, 38.15), (45.75, 37.95), (46.7, 37.6),
         (47.5, 37.05), (48.4, 36.85), (49.2, 37.45), (49.55, 38.4), (50.3, 39.05), (51.2, 38.85), (51.75, 38.05),
         (52.5, 37.72), (53.25, 38.12), (54.0, 38.72), (55.0, 39.2)]
GORGE_FLOOR = [190, 188, 176, 160, 142, 122, 102, 82, 60, 36, 3, -12, -22, -32]
GORGE_WIDTH = [200, 240, 110, 80, 70, 80, 100, 80, 70, 90, 110, 140, 180, 220]
GORGE_SPREAD = [1.8, 1.6, 1.35, 1.55, 1.4, 1.45, 1.55, 1.35, 1.25, 1.4, 1.0, 0.8, 0.7, 0.7]
BEND = 0.55              # asymmetry on bends: bench spread × e^(±BEND) on the inside / outside of a 450 m-radius bend
BUTTRESS = (55.0, 22.0)  # m: how far the walls advance and retreat (buttresses and bays ~400 m; couloirs ~120 m)

# the cirque: an elliptical amphitheatre floor where the gorge leaves the ridge foot (cx, cy km; rx, ry km; rot °)
CIRQUE = dict(c=(45.75, 37.95), r=(1.05, 0.72), rot=-25, floor=186, spread=1.7)
PILLARS = dict(c=(45.55, 38.1), r=0.75)     # ticket 04: a cluster of Meteora towers on the cirque floor (not built here)

# canyons cut with the same walls: side canyons (head → junction; the last vertex snaps onto the gorge's thalweg and
# floor), a reculée in the north escarpment (head → out onto the lowland) and two south-coast calanques (head → out to
# sea). Per vertex: floor (m), floor width (m), spread.
SIDE = [
    dict(name='north', pts=[(49.75, 34.7), (50.05, 35.6), (49.7, 36.5), (49.3, 37.35)], join=True,
         floor=[530, 420, 270, 150], width=[30, 35, 45, 60], spread=[0.9, 0.8, 0.8, 0.8]),
    dict(name='south', pts=[(51.9, 41.7), (51.35, 41.0), (51.2, 40.1), (50.85, 39.2)], join=True,
         floor=[470, 330, 190, 100], width=[30, 35, 45, 60], spread=[0.9, 0.8, 0.8, 0.8]),
    dict(name='west', pts=[(47.3, 40.6), (47.55, 39.7), (47.35, 38.7), (47.15, 37.45)], join=True,
         floor=[520, 400, 280, 170], width=[25, 30, 40, 50], spread=[0.8, 0.8, 0.8, 0.9]),
    dict(name='reculee', pts=[(48.45, 35.1), (48.3, 34.2), (48.2, 33.2), (48.1, 32.3)],
         floor=[500, 360, 220, 150], width=[30, 45, 70, 90], spread=[0.9, 1.0, 1.4, 1.8]),
    dict(name='sormiou', pts=[(47.05, 42.2), (47.25, 42.95), (47.35, 43.7), (47.45, 44.5)],
         floor=[90, 4, -14, -24], width=[60, 90, 120, 150], spread=[0.8, 0.7, 0.65, 0.6]),
    dict(name='morgiou', pts=[(49.7, 41.2), (49.9, 41.9), (50.05, 42.6), (50.1, 43.4)],
         floor=[80, 4, -14, -24], width=[60, 90, 120, 150], spread=[0.8, 0.7, 0.65, 0.6]),
]

# the strike valley along the ridge foot: two stream channels (head → cirque) collect the ridge's streams from the
# north and the south and bring them into the cirque — the river's upper course, a V-cut valley between the mountains
# and the causse's west escarpment. Per vertex: floor (m), floor width (m).
UPPER = [
    dict(name='upper north', pts=[(46.35, 33.8), (45.85, 34.5), (45.35, 35.1), (45.5, 35.8), (45.2, 36.5), (45.3, 37.3)],
         floor=[400, 335, 285, 250, 214, 194], width=[25, 35, 40, 50, 60, 80]),
    dict(name='upper south', pts=[(44.3, 43.5), (44.75, 42.4), (45.1, 41.4), (45.2, 40.3), (45.15, 39.3), (45.25, 38.6)],
         floor=[330, 262, 222, 206, 196, 190], width=[25, 35, 50, 60, 70, 80]),
]
V_WALL = 0.42             # slope of the stream valleys' sides

# the sea cliffs
SEA_FOOT = -22.0          # m: the sea cliffs plunge to this depth
SEA_SPREAD = 0.5          # the sheer face from the sea (× e^(±0.6) along the coast) ...
SEA_TIER = 310.0          # ... up to about this height (± 70 m along the coast; never below 240) ...
SEA_UPPER = 3.2           # ... above which the beds step back in broad ledges and scree slopes to the causse's edge
PLUNGE = 350.0            # m offshore of the designed cliffs where the sea floor stays near the foot depth


# ── the stratigraphic column ──
_DZ = 0.5
Z = np.arange(-400.0, 1600.0, _DZ)


def _column():
    """Cumulative horizontal run (m) climbing the column from its base: soft (ledges and scree slopes, scaled by a
    wall's spread) and hard (cliffs, always steep)."""
    rs = np.zeros_like(Z); rh = np.zeros_like(Z)
    for base, top, t, c, s1 in STRATA:
        m = (Z >= base) & (Z < top)
        u = ((Z[m] - base) % t) / t
        soft = u < 1 - c
        v = np.clip(u / (1 - c), 0, 1)
        rs[m] = np.where(soft, 1 / (BENCH + (s1 - BENCH) * v), 0)
        rh[m] = np.where(soft, 0, 1 / CLIFF)
    return np.cumsum(rs) * _DZ, np.cumsum(rh) * _DZ


CS, CH = _column()


def _invert(T, m):
    """Elevation where the spread-m column has climbed a run T: solves m·CS(z) + CH(z) = T (vectorised bisection)."""
    lo = np.zeros(T.shape, np.int64); hi = np.full(T.shape, len(Z) - 1, np.int64)
    for _ in range(int(np.ceil(np.log2(len(Z)))) + 1):
        mid = (lo + hi) // 2
        big = m * CS[mid] + CH[mid] > T
        hi = np.where(big, mid, hi); lo = np.where(big, lo, mid)
    vl = m * CS[lo] + CH[lo]; vh = m * CS[hi] + CH[hi]
    t = np.clip((T - vl) / np.maximum(vh - vl, 1e-9), 0, 1)
    return Z[lo] + (Z[hi] - Z[lo]) * t


def wall(zref, e, m, w, up=True):
    """The strata wall: elevation at horizontal distance e (m) from an edge at elevation zref — climbing from a floor
    (up: gorge, cirque, sea cliff) or descending from a rim (escarpment). m: spread of the benches (1 = the gorge's
    tight walls, larger = wider ledges; cliffs stay steep). w (m): gentle warp of the beds."""
    zb = np.clip(zref + w, Z[0], Z[-1])
    c0 = m * np.interp(zb, Z, CS) + np.interp(zb, Z, CH)
    return _invert(c0 + (e if up else -e), m) - w


def wall_aa(zref, e, m, w, dx, up=True, sel=None):
    """wall(), box-filtered over each cell (3×3 samples, shifting e along its gradient): a cliff narrower than a cell
    becomes a clean one-cell ramp instead of a stair-stepped zigzag. sel: cells worth the extra samples (others get
    the single sample)."""
    z = wall(zref, e, m, w, up)
    if sel is None:
        sel = np.ones(e.shape, bool)
    gy, gx = np.gradient(e, dx)
    ez, zs, ms, ws, gxs, gys = e[sel], zref[sel], m[sel], w[sel], gx[sel], gy[sel]
    acc = np.zeros(ez.shape)
    for oy in (-1 / 3, 0, 1 / 3):
        for ox in (-1 / 3, 0, 1 / 3):
            acc += wall(zs, np.maximum(0, ez + (ox * gxs + oy * gys) * dx), ms, ws, up)
    z[sel] = acc / 9
    return z


# ── geometry helpers ──
def _line(pts_km, values, dx, x0, y0, shape, step=None):
    """Spline thalweg through the vertices; per cell: distance (m) to it, the nearest sample's values, which side of it
    the cell lies on (+1: the side the line turns toward when its curvature is positive) and that sample's curvature."""
    P, vals = spline([(x * 1000, y * 1000) for x, y in pts_km], values, step=step or dx * 0.5)
    t = np.gradient(P, axis=0); a = np.gradient(t, axis=0)
    kap = (t[:, 0] * a[:, 1] - t[:, 1] * a[:, 0]) / np.maximum(np.linalg.norm(t, axis=1) ** 3, 1e-9)
    kap = ndimage.gaussian_filter1d(kap, max(1.0, 60.0 / (dx * 0.5)), mode='nearest')
    ny, nx = shape
    ix = np.floor((P[:, 0] - x0) / dx).astype(int); iy = np.floor((P[:, 1] - y0) / dx).astype(int)
    ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    lab = np.full(shape, -1, np.int64); lab[iy[ok], ix[ok]] = np.nonzero(ok)[0]
    _, (jy, jx) = ndimage.distance_transform_edt(lab < 0, return_indices=True)
    k = lab[jy, jx]
    yy, xx = np.mgrid[0:ny, 0:nx]
    vx = (xx + 0.5) * dx + x0 - P[k, 0]; vy = (yy + 0.5) * dx + y0 - P[k, 1]
    d = np.sqrt(vx * vx + vy * vy)
    side = np.sign(t[k, 0] * vy - t[k, 1] * vx)
    return d, [v[k] for v in vals], side, kap[k], P, kap


def _poly_mask(pts_km, dx, x0, y0, shape):
    from PIL import Image, ImageDraw
    img = Image.new('L', (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon([((x * 1000 - x0) / dx, (y * 1000 - y0) / dx) for x, y in pts_km], fill=1)
    return np.asarray(img).astype(bool)


def _noise(n, i0, i1, j0, j1):
    return lambda base, octaves, seed, gain=0.5: fx.fbm(n, base, octaves, seed, gain=gain)[i0:i1, j0:j1].double().cpu().numpy()


def gorge_line(dx=15.625):
    """The main thalweg as dense samples (m) with arc length, floor, width and curvature — for probes and reports."""
    P, (fl, wd) = spline([(x * 1000, y * 1000) for x, y in GORGE], (GORGE_FLOOR, GORGE_WIDTH), step=dx * 0.5)
    t = np.gradient(P, axis=0); a = np.gradient(t, axis=0)
    kap = (t[:, 0] * a[:, 1] - t[:, 1] * a[:, 0]) / np.maximum(np.linalg.norm(t, axis=1) ** 3, 1e-9)
    kap = ndimage.gaussian_filter1d(kap, max(1.0, 60.0 / (dx * 0.5)), mode='nearest')
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    return P, s, fl, wd, kap


def plateau(h, dx, seed=0):
    """Build the causse, its gorge, cirque, canyons, calanques, escarpments and sea cliffs into h (full grid, m).
    Returns (h, info). info (full-grid arrays unless noted):
      hard      0..1 where the ground is designed rock walls: raise the droplets' hardness there, or the rain saws
                the ledges into gullies
      talus_tan the talus angle (tan) the walls need: take max(talus_tan, this) before detail.talus, or the cliffs
                slump into scree ramps
      zone      0..1: the causse and its skirts (the whole designed region); window: its crop (i0, i1, j0, j1)
      karst     0..1 over the causse top: limestone drains underground — fewer rain droplets, no lakes in the dolines
      keep      designed sea floor (m; +1e9 elsewhere) for bathymetry(keep=…): the drowned calanques and the deep water
                at the foot of the sea cliffs
      coast     0..1 multiplier for the coast pass's style: 0 at the designed sea cliffs and in the calanques (no
                wave-cut retreat to widen the inlets or plane a platform under the cliffs)
      floor     bool: the flat floors of the gorge, cirque and canyons (the future river; alluvium, no fans)
      fillable  bool: where drain() may fill closed basins (the designed region off the karst top)
      thalweg   (k, 2) array, m: the gorge's centre line head → mouth (for the river later)
      pillars   ticket 04's site: dict(c=(x, y) km, r km, floor m)
    """
    n = h.shape[0]
    i0, i1 = int(BOX[1] * 1000 / dx), int(BOX[3] * 1000 / dx)
    j0, j1 = int(BOX[0] * 1000 / dx), int(BOX[2] * 1000 / dx)
    x0, y0 = j0 * dx, i0 * dx
    H0 = h[i0:i1, j0:j1].astype(np.float64)
    shape = H0.shape
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    X = (xx + 0.5) * dx + x0; Y = (yy + 0.5) * dx + y0         # m
    nz = _noise(n, i0, i1, j0, j1)
    rng = np.random.default_rng(1234 + seed)
    w = 10.0 * nz(9, 2, 311)                                      # bed warp (m): the strata undulate gently
    land = H0 > 0

    # ── footprint: signed distance to the causse's edge (m, + inside), lobate; no crumbs of causse left outside ──
    inside = _poly_mask(CAUSSE, dx, x0, y0, shape)
    sd = (ndimage.distance_transform_edt(inside) - ndimage.distance_transform_edt(~inside)) * dx
    sd = sd + LOBES * nz(34, 2, 303, gain=0.5) + 0.25 * LOBES * nz(110, 2, 313)
    lab, nl = ndimage.label(sd > 0)
    if nl > 1:
        big = np.argmax(ndimage.sum(np.ones(shape), lab, range(1, nl + 1))) + 1
        small = (lab > 0) & (lab != big)
        sd[small] = np.minimum(-sd[small], -dx)                  # outliers: gone (the escarpment runs past them)

    # ── the top surface: tilt, swells, puechs, fine unevenness, dolines ──
    top = np.interp(X / 1000, TOP_X, TOP_Z) + SWELL * nz(26, 3, 301)
    dsea = ndimage.distance_transform_edt(land) * dx
    coastal = np.clip(1 - dsea / 2000, 0, 1) ** 1.5
    for cx_, cy_, r_, h_ in CAPES:
        rr = np.sqrt((X / 1000 - cx_) ** 2 + (Y / 1000 - cy_) ** 2) / r_
        top += h_ * np.clip(1 - rr * rr, 0, 1) ** 2
    top -= COASTAL * np.clip(1.3 * nz(20, 2, 315), 0, 1) * coastal
    top += PUECH * np.clip(nz(36, 2, 302) - 0.85, 0, None) ** 1.3 * 1.4       # isolated rounded hills
    top += ROUGH * nz(430, 2, 312) + 2 * ROUGH * nz(130, 2, 314)
    dol = np.zeros(shape)
    cand = np.argwhere((sd > 300)[::4, ::4]) * 4
    grain = nz(90, 2, 304)                                        # doline fields cluster along a fracture grain
    pw = np.clip(grain[cand[:, 0], cand[:, 1]] + 0.6, 0.05, None); pw /= pw.sum()
    for k in rng.choice(len(cand), size=min(DOLINES, len(cand)), replace=False, p=pw):
        cy, cx = cand[k]
        R = rng.uniform(35, 95) / dx; D = rng.uniform(4, 16) * (R * dx / 95) ** 0.5
        r0 = int(R) + 1
        sl = (slice(max(cy - r0, 0), cy + r0 + 1), slice(max(cx - r0, 0), cx + r0 + 1))
        rr = np.sqrt((yy[sl] - cy) ** 2 + (xx[sl] - cx) ** 2) / R
        dol[sl] = np.minimum(dol[sl], -D * np.clip(1 - rr * rr, 0, 1) ** 2)

    # ── causse + escarpment, set onto the old ground ──
    eo = np.maximum(0, -sd)
    msp = ESC_SPREAD * np.exp(0.25 * nz(30, 2, 305))
    esc = wall(top, eo, msp, w, up=False)
    esc = wall_aa(top, eo, msp, w, dx, up=False, sel=(sd < 0) & (sd > -2500) & (esc > H0 - 30))
    causse = np.where(sd >= 0, top + dol, esc)
    H = np.where(land, -softmin(-H0, -causse, 12.0), H0)         # soft max: ridges higher than the causse still stand
    floor = np.zeros(shape, bool)
    for up in UPPER:                                              # the strike valley's streams: V-cut into whatever is there
        du, (Fu, Wu), _, _, _, _ = _line(up['pts'], (up['floor'], up['width']), dx, x0, y0, shape)
        eu = np.maximum(0, du - Wu / 2 + 25 * nz(300, 2, 319) * np.clip((du - Wu / 2) / 50, 0, 1))
        H = softmin(H, np.where(du < 2500, Fu + V_WALL * eu + 4e-4 * eu * eu, 1e4), 10.0)
        floor |= du < Wu / 2

    # ── the gorge, cirque and canyons: floors and strata walls ──
    rough = BUTTRESS[0] * nz(170, 3, 306, gain=0.6) + BUTTRESS[1] * nz(520, 2, 309)

    def carve(e, zf, m, reach):
        en = np.maximum(0, e + rough * np.clip(e / 60, 0, 1))
        z = np.full(shape, 1e4)
        z[reach] = wall(zf[reach], en[reach], m[reach], w[reach])
        sel = reach & (z < H + 40)
        z[sel] = wall_aa(zf, en, m, w, dx, sel=sel)[sel]
        return z

    d, (F, W, M), side, kap, Pg, kapg = _line(GORGE, (GORGE_FLOOR, GORGE_WIDTH, GORGE_SPREAD), dx, x0, y0, shape)
    Mb = M * np.exp(BEND * np.clip(side * kap * 450.0, -1, 1))       # slip-off benches inside bends, cliffs outside
    G = carve(np.maximum(0, d - W / 2), F, Mb, d < 3500) + 0.012 * np.minimum(d, W / 2)
    floor |= d < W / 2
    Pd, (Fd,) = spline([(x * 1000, y * 1000) for x, y in GORGE], (GORGE_FLOOR,), step=dx * 0.5)
    cx, cy = CIRQUE['c']; rx, ry = CIRQUE['r']; a = np.radians(CIRQUE['rot'])
    u = ((X / 1000 - cx) * np.cos(a) + (Y / 1000 - cy) * np.sin(a)) / rx
    v = (-(X / 1000 - cx) * np.sin(a) + (Y / 1000 - cy) * np.cos(a)) / ry
    ell = np.sqrt(u * u + v * v)
    cf = np.where(ell < 1, CIRQUE['floor'] + 6 * ell, CIRQUE['floor'] + 6.0)
    G = softmin(G, carve(np.maximum(0, (ell - 1) * min(rx, ry) * 1000), cf, np.full(shape, CIRQUE['spread']), ell < 4), 8.0)
    floor |= ell < 1
    for sc in SIDE:
        pts, fl = list(sc['pts']), list(sc['floor'])
        if sc.get('join'):                                        # the mouth sits on the gorge's floor, no lip, no pit
            q = np.array(pts[-1]) * 1000
            k = np.argmin(np.linalg.norm(Pd - q, axis=1))
            pts[-1] = tuple(Pd[k] / 1000); fl[-1] = float(Fd[k]) + 1.0
        ds_, (Fs, Ws, Ms), sside, skap, _, _ = _line(pts, (fl, sc['width'], sc['spread']), dx, x0, y0, shape)
        Mbs = Ms * np.exp(BEND * np.clip(sside * skap * 450.0, -1, 1))
        G = softmin(G, carve(np.maximum(0, ds_ - Ws / 2), Fs, Mbs, ds_ < 2500), 8.0)
        floor |= ds_ < Ws / 2
    H = softmin(H, G, 5.0)

    # ── dry valleys: where the top's own drainage gathers, shallow valleys wander to the rims and hang there ──
    topm = np.clip(sd / 250, 0, 1) * np.clip((G - H - 10) / 30, 0, 1)
    k2 = 2
    Hc = H[::k2, ::k2]; m2 = Hc.shape[0]
    fixed = ((Hc <= 0) | np.pad(np.zeros((m2 - 2, m2 - 2), bool), 1, constant_values=True)).ravel()
    A = lem.flow(Hc.ravel().astype(np.float64), fixed, m2, dx * k2)[0].reshape(m2, m2)
    A = np.kron(A, np.ones((k2, k2)))[:shape[0], :shape[1]]
    la = np.log10(np.maximum(A, 1.0))
    vcell = (la > 5.0) & (topm > 0.5)
    if vcell.any():
        dv, (vy, vx) = ndimage.distance_transform_edt(~vcell, return_indices=True)
        dv = dv * dx
        s = np.clip((la[vy, vx] - 5.0) / 1.6, 0, 1)
        depth = VALAT * s ** 0.8
        width = 90 + 170 * s
        prof = np.clip(1 - (dv / width) ** 2, 0, 1) ** 2
        H = H - depth * prof * topm

    # ── sea cliffs: the column plunges into deep water along the causse's coast ──
    sea0 = ~land
    dsea_n = np.maximum(0, dsea + 170 * nz(40, 2, 316) + 60 * nz(110, 3, 307, gain=0.6) + 25 * nz(420, 2, 317))  # headlands, coves, couloirs
    ssp = SEA_SPREAD * np.exp(0.6 * np.clip(1.2 * nz(28, 2, 318), -1, 1))
    usp = SEA_UPPER * np.exp(0.4 * np.clip(1.2 * nz(33, 2, 323), -1, 1))
    zt = np.clip(SEA_TIER + 70 * nz(24, 2, 322), 240, 420)
    zf_, zt_ = np.full(shape, SEA_FOOT) + w, zt + w
    et = ssp * (np.interp(zt_, Z, CS) - np.interp(zf_, Z, CS)) + np.interp(zt_, Z, CH) - np.interp(zf_, Z, CH)

    def tiered(sl=None):
        sl = np.ones(shape, bool) if sl is None else sl
        lo = wall_aa(np.full(shape, SEA_FOOT), dsea_n, ssp, w, dx, sel=sl)
        hi = wall_aa(zt, np.maximum(0, dsea_n - et), usp, w, dx, sel=sl)
        return np.where(dsea_n < et, np.minimum(lo, zt), hi)
    zone = np.clip((sd + 600) / 600, 0, 1)                          # the causse and its skirts
    near = land & (zone > 0) & (dsea < 1500)
    S = np.full(shape, 1e4)
    S[near] = tiered(near)[near]
    Hs = softmin(H, S, 5.0)
    H = np.where(land, H + (Hs - H) * zone, H)

    # ── no ponds: whatever closed basins remain off the karst top (old valleys the causse dammed) fill up to their
    # spill level as flat alluvial floors, so the lakes pass finds nothing here but the dolines ──
    m_ = shape[0]
    fixedc = ((H <= 0) | np.pad(np.zeros((m_ - 2, m_ - 2), bool), 1, constant_values=True)).ravel()
    hf = lem.priority_flood(H.ravel().astype(np.float64), fixedc, m_, 2e-3).reshape(shape)
    fill = (sd > -2500) & (topm < 0.3) & (hf > H)
    floor |= fill & (hf - H > 1.0)
    H = np.where(fill, hf, H)

    # ── outputs ──
    keep = np.full(shape, 1e9)
    calq = G < 0
    keep[calq] = G[calq]
    dcl = ndimage.distance_transform_edt(~(land & (zone > 0.5))) * dx      # offshore distance from the causse's coast
    plunge = sea0 & (dcl < PLUNGE) & (zone > 0.2)
    keep[plunge] = np.minimum(keep[plunge], SEA_FOOT - 6 * nz(60, 2, 308)[plunge] + 16 * (dcl[plunge] / PLUNGE) ** 2)
    H = np.where(sea0 | (H < 0), np.minimum(H, keep), H)
    gy, gx = np.gradient(H, dx)
    slope = np.sqrt(gx * gx + gy * gy)
    design = ndimage.binary_dilation(np.abs(H - H0) > 1.0, iterations=2)      # only the ground this pass built
    hard = ndimage.maximum_filter((slope > 0.6) & design, size=3).astype(float)
    hard = np.maximum(hard, ndimage.gaussian_filter(hard, 1.5)).clip(0, 1) * np.clip((sd + 3000) / 1000, 0, 1)
    karst = (topm * (slope < 0.5)).astype(float)
    coast = 1 - np.clip(zone * 1.5, 0, 1)
    coast = np.minimum(coast, np.clip((ndimage.distance_transform_edt(~calq) * dx - 400) / 400, 0, 1))

    def full(a, fill):
        o = np.full((n, n), fill, dtype=np.float32 if a.dtype != bool else bool); o[i0:i1, j0:j1] = a; return o

    out = h.copy()
    out[i0:i1, j0:j1] = H
    talus = 0.9 + (CLIFF + 0.5 - 0.9) * hard
    info = dict(hard=full(hard, 0.0), talus_tan=full(talus, 0.9), zone=full(zone, 0.0), window=(i0, i1, j0, j1),
                karst=full(karst, 0.0), keep=full(keep, 1e9), coast=full(coast, 1.0), floor=full(floor, False),
                fillable=full((sd > -2500) & (topm < 0.3), False),
                thalweg=Pg, pillars=dict(c=PILLARS['c'], r=PILLARS['r'], floor=CIRQUE['floor']),
                min_radius=float(1 / np.abs(kapg[20:-20]).max()))
    return out, info


def drain(h, dx, info, eps=2e-3):
    """Run after the rain droplets and talus: the droplets drop their load on the gorge's narrow floor and at canyon
    mouths, damming little pools the lakes pass would fill. Fill every closed basin inside info['fillable'] to its
    spill level (a flat of gravel the river crosses), leaving the karst top's dolines alone. Returns h."""
    i0, i1, j0, j1 = info['window']
    H = h[i0:i1, j0:j1].astype(np.float64)
    m_ = H.shape[0]
    fixed = ((H <= 0) | np.pad(np.zeros((m_ - 2, m_ - 2), bool), 1, constant_values=True)).ravel()
    hf = lem.priority_flood(H.ravel(), fixed, m_, eps).reshape(H.shape)
    fill = info['fillable'][i0:i1, j0:j1] & (hf > H)
    out = h.copy()
    out[i0:i1, j0:j1] = np.where(fill, hf, H)
    return out
