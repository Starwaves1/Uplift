"""Bake the island's terrain light on the GPU: how much of the sky each spot of ground sees.

Valley floors, gullies and the feet of cliffs see less sky than crests and open slopes, so the sky light that fills
their shadows is dimmer (and bluer: what the relief hides first is the bright band of sky along the horizon). For every
cell of the heightfield we march outward in D directions, out to kilometres (so whole valleys darken, not only small
hollows), keeping the highest elevation angle met: the horizon. Far samples read a mean-filtered mip of the heights as
wide as the gap between neighbouring rays there (cone tracing), so narrow peaks are never slipped between rays and
nothing aliases into stars or rings. Between each pair of opposite horizons we integrate the sky over the ground's own
hemisphere, cosine-weighted (the slice integral of GTAO, Jimenez et al. 2016), for two parts of the sky:

- uniform: a sky of even radiance (the zenith's) — the classic sky visibility / ambient occlusion;
- horizon band: the extra brightness of the sky toward the horizon, radiance ∝ (1 − e^(−τ/sin e))/(1 − e^(−τ)) − 1 at
  elevation e for a thin-atmosphere optical depth τ ≈ 0.1 (the game's sky is ~8× brighter 3° up than at the zenith).
  A valley floor loses much more of it than of the uniform part.

At run time the sky irradiance splits the same way: the zenith radiance (uZen) is the uniform part, the rest of the sky
irradiance (uAmb − uZen) is the band's (islandSkyLight() in wind/core.js).

What lies below the horizontal counts as ground, which is also what the game's shading already assumes for a tilted
patch on open land: its sky light is the sky irradiance × (1 + n.y)/2. So each stored value is the relief's occlusion
*relative to that open-ground case* — 1 on flat land, open slopes and crests; lower in valleys, gullies, hollows, at
cliff feet.

Output: WORK/light_<tag>_<N>.npy (float32, 2×N²: uniform, band), <outdir>/island_light.bin (see encode()), previews in
island/preview/. The bake is at the heights' own resolution; the shipped map is box-filtered to 2048² (31 m): in the game
4096² and 1024² frames differ only at the noise floor, except flying under ~100 m in steep valleys at dusk, where 1024²
starts to blur the gully floors (4096² would cost 9.1 MB, 2048² 2.7 MB, 1024² 0.7 MB for the r5 island).
An 8192² island takes ~3.5 min on an RX 7900 XT (64 directions × 78 steps out to 15 km), ~1.5 GB of GPU memory and
~4 GB of host memory.

usage: python bake_light.py tag N outdir [--res R] [--dirs D] [--reach M] [--tau T] [--preview] [--encode-only]
"""
import argparse, math, os, struct, time, zlib
import numpy as np
import torch
import torch.nn.functional as F
from paths import WORK

dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
SIZE, ORIGIN = 64000.0, -32000.0      # the island's extent (m) and its north-west corner (world x, z)
GL_X, GL_W = (torch.tensor(a, dtype=torch.float32) for a in np.polynomial.legendre.leggauss(16))


def steps(dx, reach, ratio):
    """March distances (m): one cell apart close in, then growing geometrically out to `reach`."""
    t, out = dx, []
    while t <= reach:
        out.append(t)
        t = max(t + dx, t * ratio)
    return out


def band(e, tau):
    """The horizon band's radiance at elevation e (rad), in units of the zenith radiance: the sky's brightness there
    beyond the zenith's (a thin atmosphere's single scattering: ∝ 1 − e^(−τ/sin e))."""
    return (1 - torch.exp(-tau / torch.sin(e).clamp(min=1e-4))) / (1 - math.exp(-tau)) - 1


def slice_arc(e_pos, e_neg, nd, ny):
    """One azimuthal slice (GTAO): e_pos, e_neg the horizon elevations (rad) along +d and −d; nd, ny the normal's
    components along d and up. Horizons below the horizontal count as the horizontal (what's under it is ground).
    Returns |n_p|, the projected normal's angle γ from the zenith and the visible arc [θ1 ≤ 0 ≤ θ2] (angles from the
    zenith toward +d), clipped to the ground's own hemisphere."""
    npl = torch.sqrt(nd * nd + ny * ny)
    g = torch.atan2(nd, ny)
    h2 = (math.pi / 2 - e_pos.clamp(min=0)).minimum(g + math.pi / 2)
    h1 = (-(math.pi / 2) + e_neg.clamp(min=0)).maximum(g - math.pi / 2)
    return npl, g, h1, h2


def slice_vis(e_pos, e_neg, nd, ny):
    """Uniform sky: |n_p| · ∫ cos(θ − γ)|sin θ| dθ over the visible arc (closed form). The mean of this over evenly spaced
    slices is the visible fraction of the cosine-weighted hemisphere (1 = all of it)."""
    npl, g, h1, h2 = slice_arc(e_pos, e_neg, nd, ny)
    cg, sg = torch.cos(g), torch.sin(g)
    a = 0.25 * (-torch.cos(2 * h1 - g) + cg + 2 * h1 * sg) + 0.25 * (-torch.cos(2 * h2 - g) + cg + 2 * h2 * sg)
    return npl * a


def slice_int(e_pos, e_neg, nd, ny, w):
    """|n_p| · ∫ cos(θ − γ)|sin θ| w(π/2 − |θ|) dθ over the visible arc, for a sky radiance profile w(elevation) (16-point
    Gauss–Legendre on each side of the zenith)."""
    npl, g, h1, h2 = slice_arc(e_pos, e_neg, nd, ny)
    x, wt = GL_X.to(e_pos.device), GL_W.to(e_pos.device)
    acc = torch.zeros_like(g)
    for k in range(16):
        u = (x[k] + 1) * 0.5
        t2, t1 = u * h2, u * h1                                   # nodes on [0, θ2] and [θ1, 0]
        acc += wt[k] * 0.5 * (h2 * torch.cos(t2 - g) * torch.sin(t2) * w(math.pi / 2 - t2)
                              - h1 * torch.cos(t1 - g) * -torch.sin(t1) * w(math.pi / 2 + t1))
    return npl * acc


@torch.no_grad()
def bake(h, dx, dirs=64, reach=16000.0, ratio=1.08, tau=0.1, band_rows=1024, log=print):
    """h: n×n heights (m, torch, on dev), rows running south; dx: cell (m). Returns (Au, Ab, V): the uniform sky's and the
    horizon band's occlusion relative to open ground, and the plain cosine-weighted sky visibility (n×n each, on the
    host). Works through bands of rows, so the GPU memory stays ~ the height pyramid + a few band-sized buffers."""
    n = h.shape[0]
    pyr = [h[None, None]]
    while pyr[-1].shape[-1] > 4:
        pyr.append(F.avg_pool2d(pyr[-1], 2))
    hp = F.pad(h[None, None], (1, 1, 1, 1), mode='replicate')[0, 0]
    out = [np.zeros((n, n), np.float32) for _ in range(3)]
    ts = steps(dx, reach, ratio)
    log(f'  {len(ts)} steps to {ts[-1]:.0f} m × {dirs} directions')
    for r0 in range(0, n, band_rows):
        r1 = min(n, r0 + band_rows)
        for o, a in zip(out, _bake_band(pyr, hp, h, r0, r1, dx, dirs, ts, ratio, tau)):
            o[r0:r1] = a.cpu().numpy()
        log(f'  rows {r1}/{n}')
    return tuple(out)


def _bake_band(pyr, hp, h, r0, r1, dx, dirs, ts, ratio, tau):
    n = h.shape[0]
    top = len(pyr) - 1
    lx = (torch.arange(n, device=dev, dtype=torch.float32) + 0.5) * (2.0 / n) - 1.0
    ly = (torch.arange(r0, r1, device=dev, dtype=torch.float32) + 0.5) * (2.0 / n) - 1.0
    gy, gx = torch.meshgrid(ly, lx, indexing='ij')
    base = torch.stack([gx, gy], -1)[None]                     # grid_sample coords: x east (columns), y south (rows)
    del gx, gy
    # the surface normal from central differences (y up; x east, z south)
    hx = (hp[r0 + 1:r1 + 1, 2:] - hp[r0 + 1:r1 + 1, :-2]) / (2 * dx)
    hz = (hp[r0 + 2:r1 + 2, 1:-1] - hp[r0:r1, 1:-1]) / (2 * dx)
    inv = torch.rsqrt(hx * hx + hz * hz + 1)
    nx, ny, nz = -hx * inv, inv, -hz * inv
    del hx, hz, inv
    h = h[r0:r1]
    cone = 2 * math.pi / dirs
    # per step: the mip level whose cells match the footprint there (the wider of the ray gap and the step spacing)
    lev = []
    for i, t in enumerate(ts):
        gap = (ts[i + 1] - t) if i + 1 < len(ts) else t * (ratio - 1)
        w = max(t * cone, gap)
        L = min(max(math.log2(w / dx), 0.0), top - 1e-3)
        lev.append((int(L), L - int(L)))
    k = 2.0 / SIZE                                              # metres → grid_sample units
    bw = lambda e: band(e, tau)
    V = torch.zeros_like(h); B = torch.zeros_like(h); B0 = torch.zeros_like(h)
    zero = torch.zeros_like(h)
    half = dirs // 2
    for s in range(half):
        phi = math.pi * (s + 0.5) / half
        c, sn = math.cos(phi), math.sin(phi)
        e = []
        for sign in (1.0, -1.0):
            best = torch.full_like(h, -1e9)
            for t, (L0, fr) in zip(ts, lev):
                g = base + torch.tensor([sign * c * t * k, sign * sn * t * k], device=dev)
                hs = F.grid_sample(pyr[L0], g, mode='bilinear', padding_mode='border', align_corners=False)
                if fr > 1e-3:
                    hs = torch.lerp(hs, F.grid_sample(pyr[L0 + 1], g, mode='bilinear', padding_mode='border', align_corners=False), fr)
                best = torch.maximum(best, (hs[0, 0] - h) / t)
            e.append(torch.atan(best))
        nd = nx * c + nz * sn
        V += slice_vis(e[0], e[1], nd, ny)
        B += slice_int(e[0], e[1], nd, ny, bw)
        B0 += slice_int(zero, zero, nd, ny, bw)                  # the same ground on open land: horizons level
    V /= half
    Au = V / (0.5 + 0.5 * ny)
    Ab = B / B0.clamp(min=1e-6)
    return Au, Ab, V


def _med_planes(q):
    """(value − median-edge prediction) mod 256 of an n×n uint8 plane."""
    q = q.astype(np.int32)
    a = np.zeros_like(q); b = np.zeros_like(q); c = np.zeros_like(q)
    a[:, 1:] = q[:, :-1]; b[1:, :] = q[:-1, :]; c[1:, 1:] = q[:-1, :-1]
    mx = np.maximum(a, b); mn = np.minimum(a, b)
    pred = np.where(c >= mx, mn, np.where(c <= mn, mx, a + b - c))
    pred[0, 1:] = q[0, :-1]; pred[1:, 0] = q[:-1, 0]; pred[0, 0] = 0
    return ((q - pred) & 255).astype(np.uint8)


def encode(chans, res):
    """island_light.bin: 'WBIL', u32 version (1), u32 n, u32 channels, f32 size (m), f32 origin (m), then one zlib
    (deflate) stream: each channel's plane of n² bytes in turn (round(value·255); here channel 0 the uniform sky's
    occlusion, 1 the horizon band's), each byte stored as (value − its median-edge prediction, as in LOCO-I) mod 256.
    Rows run south, columns east; texel centres at origin + (i + ½)·size/n."""
    qs = []
    for A in chans:
        n0 = A.shape[0]
        if res != n0:
            f = n0 // res
            A = A.reshape(res, f, res, f).mean((1, 3))
        qs.append(np.clip(np.round(A * 255.0), 0, 255).astype(np.uint8))
    head = b'WBIL' + struct.pack('<IIIff', 1, res, len(qs), SIZE, ORIGIN)
    return head + zlib.compress(b''.join(_med_planes(q).tobytes() for q in qs), 9), qs


def decode(buf):
    """Reference decoder (mirrors wind/boot.js): → list of n×n uint8 planes."""
    from numba import njit
    n, ch = struct.unpack('<II', buf[8:16])
    r = np.frombuffer(zlib.decompress(buf[24:]), np.uint8).reshape(ch, n, n).astype(np.int32)

    @njit(cache=True)
    def rebuild(r, n):
        q = np.zeros((n, n), np.int32)
        for y in range(n):
            for x in range(n):
                if y == 0 and x == 0:
                    p = 0
                elif y == 0:
                    p = q[0, x - 1]
                elif x == 0:
                    p = q[y - 1, 0]
                else:
                    a = q[y, x - 1]; b = q[y - 1, x]; c = q[y - 1, x - 1]
                    mx = max(a, b); mn = min(a, b)
                    p = mn if c >= mx else (mx if c <= mn else a + b - c)
                q[y, x] = (p + r[y, x]) & 255
        return q
    return [rebuild(r[i], n).astype(np.uint8) for i in range(ch)]


def previews(h, Au, Ab, dx, tag, pre):
    """Grey maps of both channels (whole island, and full-resolution crops) and a hillshade before/after, to judge the
    bake by eye."""
    from PIL import Image
    os.makedirs(pre, exist_ok=True)
    n = Au.shape[0]
    if n > 4096:                                    # judge at 4096² (keeps the host memory of an 8192² bake low)
        f = n // 4096
        sh = lambda a: a.reshape(4096, f, 4096, f).mean((1, 3))
        h, Au, Ab, dx, n = sh(h), sh(Au), sh(Ab), dx * f, 4096
    img = lambda a: Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    img(Au).resize((2048, 2048), Image.LANCZOS).save(f'{pre}/light_{tag}_A.png')
    img(Ab).resize((2048, 2048), Image.LANCZOS).save(f'{pre}/light_{tag}_B.png')
    gy, gx = np.gradient(h, dx)
    nrm = 1 / np.sqrt(gx * gx + gy * gy + 1)
    L = np.array([0.42, 0.64, -0.64]); L /= np.linalg.norm(L)     # the afternoon sun: x east, y up, z south
    sun = np.clip((-gx * L[0] + L[1] - gy * L[2]) * nrm, 0, 1)
    sky0 = 0.5 + 0.5 * nrm
    land = h > 0
    for name, (xk, yk, sk) in {'valley': (8, 31, 9), 'nordic': (11, 14, 10), 'south': (19, 41, 10), 'volcano': (40, 22, 12)}.items():
        i0, j0, m = int(xk * 1000 / dx), int(yk * 1000 / dx), int(sk * 1000 / dx)
        sl = (slice(j0, j0 + m), slice(i0, i0 + m))
        img(np.concatenate([Au[sl], Ab[sl]], 1)).save(f'{pre}/light_{tag}_{name}_AB.png')
        sky1 = sky0[sl] * (0.6 * Au[sl] + 0.4 * Ab[sl])           # afternoon: ~60% of the sky light is the zenith's
        for lab, sky in (('before', sky0[sl]), ('after', sky1)):
            shade = (0.8 * sun[sl] + 0.35 * sky) * np.where(land[sl], 1.0, 0.6)
            img(shade ** (1 / 2.2) * 0.95).save(f'{pre}/light_{tag}_{name}_{lab}.png')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tag'); ap.add_argument('N', type=int); ap.add_argument('outdir')
    ap.add_argument('--res', type=int, default=2048, help='stored map size (a divisor of N)')
    ap.add_argument('--dirs', type=int, default=64)
    ap.add_argument('--reach', type=float, default=16000.0)
    ap.add_argument('--tau', type=float, default=0.1, help="the sky model's optical depth (sets the horizon band's shape)")
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--encode-only', action='store_true', help='re-encode WORK/light_<tag>_<N>.npy (e.g. at another --res)')
    a = ap.parse_args()
    h_np = np.load(f'{WORK}/h_{a.tag}_{a.N}.npy').astype(np.float32)
    n = h_np.shape[0]; dx = SIZE / n
    res = min(a.res, n)
    if a.encode_only:
        Au, Ab = np.load(f'{WORK}/light_{a.tag}_{a.N}.npy')
    else:
        t0 = time.time()
        Au, Ab, V = bake(torch.from_numpy(h_np).to(dev), dx, a.dirs, a.reach, tau=a.tau)
        torch.cuda.empty_cache()
        land = h_np > 0
        print(f'baked {n}² in {time.time() - t0:.1f} s: uniform {Au.min():.3f}…{Au.max():.3f} (mean on land {Au[land].mean():.3f}),'
              f' band {Ab.min():.3f}…{Ab.max():.3f} (mean on land {Ab[land].mean():.3f}); plain sky view on land {V[land].mean():.3f}')
        del V
        Au = np.minimum(Au, 1.0); Ab = np.minimum(Ab, 1.0)
        np.save(f'{WORK}/light_{a.tag}_{a.N}.npy', np.stack([Au, Ab]))
    blob, qs = encode([Au, Ab], res)
    os.makedirs(a.outdir, exist_ok=True)
    open(os.path.join(a.outdir, 'island_light.bin'), 'wb').write(blob)
    print(f'island_light.bin {len(blob) / 1e6:.2f} MB ({res}², 2 channels)')
    back = decode(blob)
    assert all(np.array_equal(b, q) for b, q in zip(back, qs)), 'round trip failed'
    if a.preview:
        previews(h_np, Au, Ab, dx, a.tag, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview'))


if __name__ == '__main__':
    main()
