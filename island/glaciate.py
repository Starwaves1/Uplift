"""Stage A2: the ice ages. Glacial cycles over a finished river-eroded landscape (the output of gen_island.py).

Each cycle is a glacial (the sea ~120 m lower; snow gathers above an equilibrium line that sits low over the windward
Nordic north-west — an ice cap — higher over the Alpine ranges, only on the tallest summits in the south) followed by
an interglacial (today's sea, rivers). Ice is routed down its own surface (lem.ice_flux over the bed plus last step's
ice), so thick ice spills over low divides into the deepening troughs; glaciers melt over their whole width. Their
surface is perfectly plastic (thin near snouts and calving fronts, thick far from any margin), they slide at flux over
width × thickness, and they grind their bed at a rate rising with the square of that speed, across each glacier's width
(glacial.erosion): the river valleys the fast outlet glaciers follow turn into troughs cut below sea level at the coast,
which flood as fjords when the sea comes back, while slow ice on the uplands and in the side valleys barely scours
(fell, hanging valleys). Overdeepenings stop growing where the bed climbs out of them faster than the ice surface falls,
so fjords keep a sill at the mouth and basins inside. Nothing is drawn: where the fjords form follows from the landscape
and the climate. Base level during the glacials stays at the preglacial coastline: the ice calves there, and keeps
cutting cells inland of it that have gone below sea level (it is grounded there at the lowstand).

usage: python glaciate.py src_tag N out_tag [cycles]       e.g.  glaciate.py fH_2048 1024 fgH
"""
import sys, time, os
import numpy as np
from scipy import ndimage
import fields as fx
import lem, glacial, preview
from design import Design, L
from paths import WORK as OUT

SRC, N, TAG = sys.argv[1], int(sys.argv[2]), sys.argv[3]
CYCLES = int(sys.argv[4]) if len(sys.argv) > 4 else 12
dx = L * 1000 / N
PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')

# ── climate and ice ──
G_STEPS, G_DT = 10, 1000.0         # a glacial: 10 steps of 1 kyr at full ice
I_STEPS, I_DT = 1, 1.0e4           # an interglacial: 10 kyr of rivers
GAMMA = 0.006                      # mass balance gradient (m/yr of ice per m of height)
BMAX, BMIN = 1.5, -6.0             # most snow a cell gathers, most ice it melts (m/yr)
KG = 1e-4                          # bed erosion per m/yr of sliding, at 100 m/yr
L_EXP = 2.0                        # erosion ∝ sliding^L_EXP (Herman et al. 2015 found ~2.3 under Franz Josef Glacier)
CAP = 25.0                         # most a cell may be cut in one step (m)
SC_ICE = 0.8                       # glacier walls stand this much steeper (tan) than the rock's usual repose
SCOUR = 10.0                       # glacial erosion (m) that leaves a fresh rock face
C_PLASTIC = 13.0                   # τ_b/(ρ_i g) (m) of the plastic ice surface: a basal shear stress of ~115 kPa
QMIN = 2e3                         # least discharge (m³/yr) that counts as ice
ICE_ROUTE = 0.9                    # ice flows down its own surface: routing sees this share of last step's ice thickness
                                   # (a little less than all, so inside a glacier the flow keeps to its deepest line)

h = np.load(f'{OUT}/h_{SRC}.npy').astype(np.float64)
if h.shape[0] != N:
    f = h.shape[0] // N
    h = h.reshape(N, f, N, f).mean(axis=(1, 3)) if f * N == h.shape[0] else ndimage.zoom(h, N / h.shape[0], order=1)
h = h.ravel()

D = Design(N)
g = D.np
RES = (1024 / N) ** 0.5
K0, Sc0 = g(D.K), g(D.Sc)
plat, strat, w_volc = g(D.w_plateau), g(D.strata), g(D.w_volc)
w_nord, w_alp, w_med = g(D.w_nord), g(D.w_alp), g(D.w_med)
# the plateau's late uplift is still going on; the Nordic highland's short, fast pulse is over by the ice ages (had it
# gone on, it would have lifted the valley floors inland faster than the glaciers could cut them below the sea)
U = (g(D.U) + g(D.U_late) * (1 - w_nord)) * RES
rain = g(D.rain)
kappa = 0.004 + 0.03 * w_med * (1 - plat) + 0.02 * np.clip(1 - g(D.U) / 1.2e-3, 0, 1) * (1 - w_nord) + 0.03 * w_nord
edge = np.zeros((N, N), bool); edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
edge = edge.ravel()
# the equilibrium line: low on the wet windward Nordic side, higher over the Alpine ranges (about a third of their summit
# heights, as in the Alps at the last glacial maximum), high in the dry south; the young volcano stays bare
ELA = 320 * w_nord + 750 * w_alp + 1700 * w_med + 1500 * plat + 3500 * w_volc


def rock(hc):
    """As in gen_island.py: plateau beds of hard caps over soft shales; resistant young lava."""
    ph = ((hc + strat) / 110.0) % 1.0
    hard = ((ph > 0.0) & (ph < 0.3)).astype(float) * (plat > 0.3)
    Kn = K0 * (1 - 0.85 * hard) * (1 + 0.6 * plat * (1 - hard)) * (1 - 0.8 * w_volc)
    Scn = np.where(hard > 0, 3.0, np.where(plat > 0.3, 0.6, Sc0))
    return Kn, Scn


def open_sea(hc):
    lab, _ = ndimage.label((hc <= 0.0).reshape(N, N))
    ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return edge | np.isin(lab, ids[ids > 0]).ravel()


R_WALL = max(1, round(190 / dx))   # how far past the ice (cells) its walls stand steeper


def fresh_rock(ice, gcut):
    """Glacier walls stand steeper than weathered slopes: next to the ice, and wherever the ice has scoured fresh rock
    (they stay steep through the short interglacials — rock walls weather back over far longer times)."""
    return ndimage.binary_dilation((ice | (gcut > SCOUR)).reshape(N, N), iterations=R_WALL).ravel()


def glacial_step(h, fixed, Hi, gcut):
    hf = lem.priority_flood(h + ICE_ROUTE * Hi, fixed, N, 1e-3)     # thick ice spills over low divides into the troughs
    rec, dist = lem.receivers(hf, fixed, N, dx)
    st = lem.stack_order(rec, N)
    b = np.clip(GAMMA * (h + Hi - ELA), BMIN, BMAX) * dx * dx      # on the ice surface (last step's thickness)
    b[fixed] = 0.0
    Q = lem.ice_flux(st, rec, b, dx)                                # melt over each glacier's width
    S = glacial.surface(st, rec, dist, h, Q, fixed, C_PLASTIC, QMIN)
    E, Sn, Hn = glacial.erosion(Q, S, h, rec, dist, fixed, N, dx, KG, QMIN, l=L_EXP, c=C_PLASTIC,
                                look=max(3, round(375 / dx)))              # the adverse slope over ~375 m downstream
    E, Hn = E.ravel(), Hn.ravel()
    ice = Hn > 5.0
    cut = np.where(fixed, 0.0, np.minimum(E * G_DT, CAP))
    h -= cut
    gcut += cut
    # rivers work the ice-free land (glaciated cells are left to the ice)
    A = lem.drainage_area(st, rec, dx * dx, rain)
    Kn, Scn = rock(h)
    lem.erode(h, st, rec, dist, A, np.where(ice, 0.0, Kn), np.zeros(N * N), G_DT, 0.5, fixed | ice, 1.0, dx * dx, 3)
    h += np.where(fixed, 0.0, U * G_DT)
    lem.hillslope(h, fixed, N, dx, np.where(fresh_rock(ice, gcut), Scn + SC_ICE, Scn), kappa, G_DT, 10, 0.06)
    return Hn, Q, E


t0 = time.time()
rng = np.random.default_rng(11)
fixed0 = open_sea(h)                        # the preglacial sea: base level through the lowstands
land0 = ~fixed0
h_start = h.copy()
Hi = np.zeros(N * N)
gcut = np.zeros(N * N)                       # glacial erosion so far (m)
for c in range(CYCLES):
    for s in range(G_STEPS):
        Hi, Q, E = glacial_step(h, fixed0, Hi, gcut)
    Hmax, Qmax, Emax = Hi.copy(), Q.copy(), E.copy()
    ice = Hi > 5
    print(f'cycle {c}: ice {100 * ice[land0].mean():4.1f}% of land  thickest {Hi.max():5.0f} m  fastest cut {1000 * E.max():5.1f} mm/yr'
          f'  deepest land0 {h[land0].min():7.1f} m  {time.time() - t0:6.1f}s', flush=True)
    Hi[:] = 0.0
    for s in range(I_STEPS):
        fx_i = open_sea(h)
        Kn, Scn = rock(h)
        Scn = np.where(fresh_rock(np.zeros(N * N, bool), gcut), Scn + SC_ICE, Scn)
        lem.step(h, fx_i, N, dx, Kn, U, rain, I_DT, 0.5, Scn, 1e-3, rng.random(N * N), kappa, 10, 1.0)

H = h.reshape(N, N)
cut = (h_start - h).reshape(N, N)
for nm, w in (('nordic', w_nord), ('alpine', w_alp), ('med', w_med), ('volcano', w_volc)):
    m = (w.reshape(N, N) > 0.6) & land0.reshape(N, N)
    print(f'{nm:8s} max {H[m].max():6.0f}  p50 {np.median(H[m]):6.0f}  below sea {100 * (H[m] < 0).mean():4.1f}%  '
          f'cut p50 {np.median(cut[m]):5.0f}  p99 {np.percentile(cut[m], 99):5.0f}  max {cut[m].max():5.0f}')
np.save(f'{OUT}/h_{TAG}_{N}.npy', H.astype(np.float32))
np.save(f'{OUT}/land0_{TAG}_{N}.npy', land0.reshape(N, N))
np.save(f'{OUT}/ice_{TAG}_{N}.npy', Hmax.reshape(N, N).astype(np.float32))
np.save(f'{OUT}/gcut_{TAG}_{N}.npy', gcut.reshape(N, N).astype(np.float32))    # glacially scoured rock (materials)

# previews: the last glacial maximum's ice over the landscape, then the drowned result
preview.render(H, dx, f'/tmp/_g{os.getpid()}.png')
from PIL import Image
im = np.asarray(Image.open(f'/tmp/_g{os.getpid()}.png')).astype(np.float32) / 255
a = np.clip(Hmax.reshape(N, N) / 120, 0, 1)[..., None] * 0.8
Image.fromarray((np.clip(im * (1 - a) + np.array([0.93, 0.96, 1.0]) * a, 0, 1) * 255).astype(np.uint8)).resize((1400, 1400)).save(f'{PRE}/{TAG}_{N}_ice.png')
A = lem.flow(h, open_sea(h), N, dx)[0].reshape(N, N)
preview.render(H, dx, f'{PRE}/{TAG}_{N}_top.png', A=A, size=1400, river_min=3e6)
c = lambda x0, y0, x1, y1: H[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
preview.oblique(c(2, 6, 34, 34), dx, f'{PRE}/{TAG}_{N}_nordic.png', azim=140, elev=14, dist=0.6, alt=0.07)
preview.oblique(c(2, 6, 34, 34), dx, f'{PRE}/{TAG}_{N}_nordic_n.png', azim=180, elev=12, dist=0.6, alt=0.06)
preview.oblique(H, dx, f'{PRE}/{TAG}_{N}_obl_w.png', azim=75, elev=16)
print('done', round(time.time() - t0, 1))
