"""The island's layout — the designed part. Everything here is in km (x east, y south, domain [0, 64]²); the prevailing
wind comes from the WNW, so the north-west is windward and the south-east lies in the lee.

Regions
  Nordic      north-west: a rugged granite highland between the north range and the sea; fjords, rock faces, skerries
  Alpine      centre: two parallel ranges with the great valley between them (a broad glacial trough, WSW → ENE)
  Mediterranean  south: limestone hills, cliffs and coves, a sheltered bay; the plateau and canyon country in the SE lee
  Volcano     north-east: a stratovolcano with a caldera lake
"""
import numpy as np
import torch
import fields as fx

L = 64.0

# ── designed lines (km) ──
# great valley thalweg (mouth → head): gentle bends, widening in basins and pinching at rock bars
VALLEY = [(4.5, 37.5), (9.0, 36.6), (13.0, 35.9), (16.5, 34.2), (20.0, 33.6), (24.0, 32.4), (27.5, 30.4),
          (31.0, 29.8), (34.5, 28.6), (38.0, 26.6), (41.5, 25.8), (44.5, 24.2), (46.8, 22.6)]
VALLEY_WIDTH = [2.2, 2.0, 1.55, 1.35, 1.9, 2.3, 1.6, 1.45, 1.85, 1.55, 1.25, 0.95, 0.75]              # flat floor (km)
VALLEY_FLOOR = [0, 6, 18, 38, 62, 95, 150, 215, 250, 330, 440, 560, 700]                              # floor (m): a rock step past the middle
NORTH_RANGE = [(8.0, 32.9), (15.5, 30.5), (23.5, 28.0), (31.5, 25.6), (39.0, 23.2), (43.5, 21.0)]   # ≈ 3.8 km north of the valley
SOUTH_RANGE = [(10.0, 40.2), (18.0, 37.6), (26.0, 35.0), (34.0, 32.4), (41.5, 29.8)]  # ≈ 3.8 km south
VOLCANO = (51.5, 17.0)          # summit centre
BAY = (31.0, 52.5)              # the sheltered southern bay (harbour town above it)
COAST_RIDGE = [(17.5, 49.5), (22.5, 50.5), (27.0, 50.8)]                                             # Amalfi-style ridge, west of the bay
# (the Nordic fjords are not designed: glaciate.py cuts them from the landscape)

LOBES = [                       # (cx, cy, rx, ry, rotation°): soft union = the land
    (32, 32, 25, 14.5, -20),     # core body, WSW–ENE
    (18, 21.5, 11.5, 8, -28),    # Nordic north-west highland
    (12, 42, 9, 7.5, 12),        # south-west
    (34, 44.5, 13, 7.5, -4),     # Mediterranean south
    (48.5, 38.5, 8.5, 6.5, -18), # plateau (south-east)
    (51.5, 17.5, 9.0, 8.5, 0),   # volcano
    (6.5, 50.5, 3.5, 2.6, 25),   # south-west cape
    (45.5, 21.5, 5.5, 4.0, -20), # ties the volcano to the head of the great valley
]
HOLES = [                        # carved from the outline: bays
    (31.0, 53.4, 4.2, 3.0, 5),   # the southern bay
]
ISLES = [(5.8, 25.0, 2.6, 1.7, 20), (60.5, 44.0, 1.8, 1.3, 0), (26.5, 7.5, 1.5, 1.0, 0), (41.5, 55.5, 1.2, 0.9, 30)]


class Design:
    def __init__(self, N, seed=0):
        self.N = N
        X, Y = fx.coords(N, L)
        self.X, self.Y = X, Y
        n = N
        wx = fx.fbm(n, 6, 5, 11 + seed) * 1.8 / L * n; wy = fx.fbm(n, 6, 5, 12 + seed) * 1.8 / L * n
        self.wx, self.wy = wx, wy

        def ellipse(cx, cy, rx, ry, rot):
            a = np.radians(rot)
            u = (X - cx) * np.cos(a) + (Y - cy) * np.sin(a)
            v = -(X - cx) * np.sin(a) + (Y - cy) * np.cos(a)
            return 1 - torch.sqrt((u / rx) ** 2 + (v / ry) ** 2)
        self.ellipse = ellipse

        # ── outline ──
        P = torch.full_like(X, -9.0)
        for lb in LOBES + ISLES:
            P = torch.logaddexp(P * 7, ellipse(*lb) * 7) / 7
        for hb in HOLES:
            P = torch.minimum(P, -ellipse(*hb) * 1.2)
        # coastal texture: stronger (rugged) on the Nordic side, gentler in the south
        self.P0 = P
        P = fx.warp(P, wx, wy)
        dN = torch.clamp((30 - Y) / 14 + (22 - X) / 30, 0, 1)                 # north-west weight
        rug = 0.10 + 0.12 * dN
        P = P + rug * fx.fbm(n, 12, 6, 21 + seed, gain=0.58)
        self.P = P
        self.land = fx.smoothstep(-0.02, 0.20, P)

        # ── regions (soft weights that sum to ~1 on land) ──
        dist_v, arc_v = fx.dist_to_polyline(X, Y, VALLEY)
        self.dist_valley, self.arc_valley = dist_v, arc_v
        volc = torch.sqrt((X - VOLCANO[0]) ** 2 + (Y - VOLCANO[1]) ** 2)
        self.volc_r = volc
        w_volc = fx.smoothstep(10.5, 7.0, volc)
        w_nord = fx.smoothstep(1.0, 5.0, fx.dist_to_polyline(X, Y, NORTH_RANGE)[0] * torch.sign(NORTH_RANGE_side(X, Y))) * (1 - w_volc)
        plateau = fx.smoothstep(0.02, 0.4, fx.warp(ellipse(48.5, 39.5, 7.5, 5.2, -18), wx * 0.6, wy * 0.6))
        w_med = fx.smoothstep(1.0, 5.0, fx.dist_to_polyline(X, Y, SOUTH_RANGE)[0] * torch.sign(-SOUTH_RANGE_side(X, Y))) * (1 - w_volc)
        w_plat = plateau * (1 - w_volc)
        w_med = w_med * (1 - w_plat)
        self.w_volc, self.w_nord, self.w_med, self.w_plateau = w_volc, w_nord, w_med, w_plat
        self.w_alp = (1 - w_volc - w_nord - w_med).clamp(0, 1)

        # ── uplift (mm/yr) ──
        def ridge(pts, width, amp, seed_, taper=0.1, var=0.45):
            d, arc = fx.dist_to_polyline(X, Y, pts)
            along = fx.smoothstep(0, taper, arc) * fx.smoothstep(1, 1 - taper, arc)
            peaks = 1 + var * fx.fbm(n, 6, 3, seed_).clamp(-1.3, 1.3)       # summits and saddles along the crest
            return amp * torch.exp(-(d / width) ** 2) * along * peaks

        northR = ridge(NORTH_RANGE, 3.6, 0.95, 31)
        southR = ridge(SOUTH_RANGE, 3.4, 0.9, 32)
        coastR = ridge(COAST_RIDGE, 2.2, 0.7, 37, taper=0.2)                       # steep coastal mountains west of the bay
        med = (0.35 + 0.55 * fx.fbm(n, 7, 4, 34).clamp(-0.5, 2)) * self.w_med    # hill country, terraces
        plat = 0.0 * self.w_plateau
        base = (0.1 + 0.07 * fx.fbm(n, 4, 3, 35))
        trough = 1 - 0.85 * torch.exp(-(dist_v / 1.6) ** 2) * fx.smoothstep(0.0, 0.05, arc_v) * (1 - 0.55 * arc_v)   # the valley: a narrow structural low, rising to its head
        # a raised rim along the cliff coasts (Nordic, Mediterranean, the volcano): high ground meets the sea, so rivers cut
        # short steep gorges to it and the waves cut rock faces into it
        from scipy import ndimage as _nd
        dcoast = torch.tensor(_nd.distance_transform_edt((self.P0 > 0).cpu().numpy()) * (L / n), device=fx.dev, dtype=torch.float32)
        self.dcoast = dcoast
        rim = fx.smoothstep(0.0, 0.9, dcoast) * (1 - fx.smoothstep(2.2, 6.0, dcoast))
        rimw = (0.1 * self.w_nord + 0.75 * self.w_med * (1 - fx.smoothstep(46.0, 52.0, X)) + 0.3 * self.w_alp) * (0.55 + 0.6 * fx.fbm(n, 9, 3, 39).clamp(-0.8, 0.8))
        coastRim = 0.9 * rim * rimw.clamp(0, 1.2)
        # the Nordic block: a highland falling steadily from the north range to the sea (as Fiordland falls from the Main
        # Divide, or western Norway from its ice divide), so the range's rivers run out to the coast side by side, each a
        # future fjord; it drops away a little more over the last few km to the real (rugged) shore. (A rim of coastal
        # uplift here used to pool the rivers behind it and let them out through one gap; a raised plateau dammed the
        # range's streams into one trunk along its edge; a noise patch of sinking land walled in by the rim became the
        # ring lake.)
        dshore = torch.tensor(_nd.distance_transform_edt((self.land > 0.5).cpu().numpy()) * (L / n), device=fx.dev, dtype=torch.float32)
        d_range = fx.dist_to_polyline(X, Y, NORTH_RANGE)[0]
        nord_fall = (1 - fx.smoothstep(4.0, 15.0, d_range)) * (0.35 + 0.65 * fx.smoothstep(0.0, 3.0, dshore))
        # the old surface: low and slow before the late uplift, already sloping to the sea
        nordic = (0.06 + 0.12 * nord_fall + 0.05 * fx.fbm(n, 8, 4, 33)).clamp(min=0.05) * self.w_nord
        U = (base * (1 - 0.7 * self.w_plateau) + (northR + southR) * (1 - self.w_plateau) + nordic + med + plat + coastR + coastRim) * trough
        U = U * self.land
        self.U = torch.where(self.land > 0.02, U, torch.tensor(-0.2, device=fx.dev)) * 1e-3
        # late block uplift: the Nordic highland and the plateau rise faster than their rivers can keep up — high old
        # surfaces survive inland, gorges (future fjords, canyons) bite in from the edges. late_from: when it starts (share
        # of the run): the plateau over the last 30%; the Nordic highland over the last 12%, tilting up toward the range —
        # late and fast, so only its big rivers cut back to the range (knickpoints climb big rivers ~30 km/Myr, small
        # streams a few km) and the old rolling surface between them survives as fell for the ice to cap
        nord_tilt = 0.25 + 0.95 * nord_fall
        self.U_late = ((nord_tilt + 0.2 * fx.fbm(n, 5, 3, 38)) * self.w_nord + 0.36 * self.w_plateau) * self.land * 1e-3
        self.late_from = 0.7 + 0.18 * self.w_nord
        # rain: wet on the windward north-west, drier in the lee; the Mediterranean limestone drains underground (karst),
        # so its rivers cut less
        self.rain = (1.0 + 0.35 * self.w_nord - 0.3 * self.w_plateau) * (1 - 0.55 * self.w_med)
        # starting surface: an old, gently rolling land (a peneplain) with the regions at their pre-uplift heights. The
        # Nordic side already falls from the range to the sea: the first rivers set the drainage for good (later uplift
        # only deepens their valleys), and on a flat plateau they had gathered into one basin leaving by the deepest bay
        nside = fx.smoothstep(-0.5, 1.5, d_range * torch.sign(NORTH_RANGE_side(X, Y))) * (1 - self.w_volc)
        h0n = nside * (15 + 100 * nord_fall) * (0.85 + 0.15 * fx.fbm(n, 6, 3, 52))
        self.h0 = torch.where(self.land > 0.5, 20 + 25 * self.land + 60 * self.w_plateau * (0.6 + 0.4 * fx.fbm(n, 6, 3, 52)) + h0n, torch.tensor(-30.0, device=fx.dev))

        # ── rock: erodibility K (1/yr, m = 0.5) and critical slope (tan) ──
        litho = torch.exp(0.4 * fx.fbm(n, 6, 4, 41))
        K = 1.5e-5 * litho
        K = K * (1 - 0.45 * self.w_nord)             # granite and gneiss: resistant
        K = K * (1 + 0.25 * self.w_med)              # limestone hills: a little softer
        self.K = K
        self.Sc = torch.full_like(X, 0.78) + 0.25 * self.w_nord   # granite stands steeper
        self.strata = fx.fbm(n, 3, 2, 42) * 25

    def np(self, t):
        return t.double().cpu().numpy().ravel()


def _side(X, Y, pts):
    """Signed side of a polyline (positive to the left when walking along it, i.e. north for an eastward line)."""
    p = torch.tensor(pts, device=fx.dev, dtype=torch.float32)
    d, arc = fx.dist_to_polyline(X, Y, pts)
    # nearest segment direction ≈ direction between the ends, good enough for gently curved ranges
    a, b = p[0], p[-1]
    return (b[0] - a[0]) * (Y - a[1]) - (b[1] - a[1]) * (X - a[0])


def NORTH_RANGE_side(X, Y):
    return -_side(X, Y, NORTH_RANGE)          # > 0 north of the north range


def SOUTH_RANGE_side(X, Y):
    return -_side(X, Y, SOUTH_RANGE)          # > 0 north of the south range
