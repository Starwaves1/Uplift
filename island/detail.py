"""Fine-scale erosion on the GPU (torch): rain droplets that carve gullies and rills and drop their load in hollows
(particle hydraulic erosion, after Beyer 2015 / Lague), and talus relaxation (loose rock slides until it rests at its
angle of repose). Heights in metres, cells dx metres; tensors on the GPU.
"""
import math
import torch

dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def _bilinear(H, px, py):
    n = H.shape[0]
    x0 = px.floor().clamp(0, n - 2); y0 = py.floor().clamp(0, n - 2)
    fx = (px - x0).clamp(0, 1); fy = (py - y0).clamp(0, 1)
    ix = x0.long(); iy = y0.long()
    h00 = H[iy, ix]; h10 = H[iy, ix + 1]; h01 = H[iy + 1, ix]; h11 = H[iy + 1, ix + 1]
    h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy
    gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy
    gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx
    return h, gx, gy, ix, iy, fx, fy


def _blur3(x, passes=2):
    """Small separable [1 2 1]/4 blur (mass-preserving away from the edges)."""
    k = torch.tensor([0.25, 0.5, 0.25], device=x.device)
    y = x[None, None]
    for _ in range(passes):
        y = torch.nn.functional.conv2d(torch.nn.functional.pad(y, (1, 1, 0, 0), mode='replicate'), k.view(1, 1, 1, 3))
        y = torch.nn.functional.conv2d(torch.nn.functional.pad(y, (0, 0, 1, 1), mode='replicate'), k.view(1, 1, 3, 1))
    return y[0, 0]


def droplets(H, dx, n_drops, *, batch=None, life=48, inertia=0.12, capacity=4.0, min_slope=0.01,
             erode=0.3, deposit=0.25, evaporate=0.02, gravity=4.0, radius=2, spawn=None, hardness=None, seed=0,
             max_step=0.03, max_vel=4.0):
    """Erode H (n×n metres, modified in place) with n_drops droplets. Heights are handled in cell units internally, so
    the parameters mean the same at any dx. spawn: optional n×n weights for where rain falls (e.g. land only);
    hardness: optional n×n in [0, 1] (1 = bedrock that barely erodes). max_step: most a droplet may dig in one step
    (cells) — on steep ground the local drop is large, and without a cap repeated droplets saw knife-edged gullies."""
    n = H.shape[0]
    g = torch.Generator(device=dev).manual_seed(seed)
    Hc = H / dx                                   # heights in cell units
    flat_w = cdf = None
    if spawn is not None:
        flat_w = spawn.flatten().float()
        flat_w = flat_w / flat_w.sum()
        if n * n > 1 << 24:          # torch.multinomial takes at most 2^24 categories: sample the CDF instead
            cdf = torch.cumsum(flat_w.double(), 0)   # float64: one cell's share (~3e-8 at 8192²) is below float32's step
            cdf /= cdf[-1].clone()
            flat_w = None
    # erosion brush (radius r): weights on a (2r+1)² footprint
    r = radius
    oy, ox = torch.meshgrid(torch.arange(-r, r + 1, device=dev), torch.arange(-r, r + 1, device=dev), indexing='ij')
    bw = (r - torch.sqrt((ox.float() ** 2 + oy.float() ** 2))).clamp(min=0)
    keep = bw > 0
    ox, oy, bw = ox[keep], oy[keep], bw[keep] / bw[keep].sum()
    soft = None if hardness is None else (1 - hardness.clamp(0, 1) * 0.95)
    if batch is None:
        batch = max(10000, n * n // 24)
    done = 0
    while done < n_drops:
        m = min(batch, n_drops - done)
        if flat_w is not None or cdf is not None:
            if cdf is not None:
                idx = torch.searchsorted(cdf, torch.rand(m, device=dev, generator=g, dtype=torch.float64), right=True).clamp(max=n * n - 1)
            else:
                idx = torch.multinomial(flat_w, m, replacement=True, generator=g)
            px = (idx % n).float() + torch.rand(m, device=dev, generator=g)
            py = (idx // n).float() + torch.rand(m, device=dev, generator=g)
        else:
            px = torch.rand(m, device=dev, generator=g) * (n - 2)
            py = torch.rand(m, device=dev, generator=g) * (n - 2)
        dxv = torch.zeros(m, device=dev); dyv = torch.zeros(m, device=dev)
        vel = torch.ones(m, device=dev); water = torch.ones(m, device=dev); sed = torch.zeros(m, device=dev)
        alive = torch.ones(m, dtype=torch.bool, device=dev)
        Dp = torch.zeros(n * n, device=dev)            # this batch's deposits, smoothed before they're laid down
        for step in range(life):
            h, gx, gy, ix, iy, fx, fy = _bilinear(Hc, px, py)
            dxv = dxv * inertia - gx * (1 - inertia)
            dyv = dyv * inertia - gy * (1 - inertia)
            ln = torch.sqrt(dxv * dxv + dyv * dyv)
            stuck = ln < 1e-6
            ln = ln.clamp(min=1e-6)
            dxv = dxv / ln; dyv = dyv / ln
            nx_ = px + dxv; ny_ = py + dyv
            alive = alive & ~stuck & (nx_ > 1) & (nx_ < n - 2) & (ny_ > 1) & (ny_ < n - 2)
            if not bool(alive.any()):
                break
            h2 = _bilinear(Hc, nx_.clamp(0, n - 1.001), ny_.clamp(0, n - 1.001))[0]
            dh = h2 - h
            cap = torch.clamp(-dh, min=min_slope) * vel * water * capacity
            dep_mask = alive & ((sed > cap) | (dh > 0))
            ero_mask = alive & ~dep_mask
            # droplets sharing a cell this step split its limits (in the sequential algorithm each would see the
            # previous one's change; in parallel they'd all dig the same pit at once)
            flat = iy * n + ix
            cnt = torch.zeros(n * n, device=dev)
            cnt.index_add_(0, flat, alive.float())
            share = 1.0 / cnt[flat].clamp(min=1.0)
            # deposition: fill the pit when going uphill, else drop the excess over capacity (bilinear to 4 cells)
            dep = torch.where(dh > 0, torch.minimum(dh, sed), (sed - cap) * deposit)
            dep = torch.where(dep_mask, dep, torch.zeros_like(dep)) * share
            sed = sed - dep
            Hf = Hc.view(-1)
            Dp.index_add_(0, flat, dep * (1 - fx) * (1 - fy))
            Dp.index_add_(0, flat + 1, dep * fx * (1 - fy))
            Dp.index_add_(0, flat + n, dep * (1 - fx) * fy)
            Dp.index_add_(0, flat + n + 1, dep * fx * fy)
            # erosion: take up to (cap − sed)·erode, never more than the drop in height, spread over the brush
            ero = torch.minimum(torch.minimum((cap - sed) * erode, -dh.clamp(max=0)), torch.full_like(dh, max_step))
            ero = torch.where(ero_mask, ero.clamp(min=0), torch.zeros_like(ero)) * share
            if soft is not None:
                ero = ero * soft.view(-1)[flat]
            cx = ix + (fx > 0.5).long(); cy = iy + (fy > 0.5).long()
            for k in range(ox.numel()):
                tx = (cx + ox[k]).clamp(0, n - 1); ty = (cy + oy[k]).clamp(0, n - 1)
                Hf.index_add_(0, ty * n + tx, -ero * bw[k])
            sed = sed + ero
            vel = torch.sqrt((vel * vel - dh * gravity).clamp(min=0, max=max_vel * max_vel))   # faster downhill, capped
            water = water * (1 - evaporate)
            px = torch.where(alive, nx_, px); py = torch.where(alive, ny_, py)
        # whatever a droplet still carries settles where it ended
        _, _, _, ix, iy, fx, fy = _bilinear(Hc, px, py)
        flat = iy * n + ix; Hf = Hc.view(-1)
        Dp.index_add_(0, flat, sed * (1 - fx) * (1 - fy)); Dp.index_add_(0, flat + 1, sed * fx * (1 - fy))
        Dp.index_add_(0, flat + n, sed * (1 - fx) * fy); Dp.index_add_(0, flat + n + 1, sed * fx * fy)
        Hc += _blur3(Dp.view(n, n), passes=5)
        done += m
    H.copy_(Hc * dx)
    return H


def talus(H, dx, angle_tan, iters=40, rate=0.2, fixed=None):
    """Loose material slides downhill until every slope is at most angle_tan (tensor n×n or float): 8-neighbour,
    mass-conserving relaxation."""
    n = H.shape[0]
    offs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for it in range(iters):
        P = torch.nn.functional.pad(H[None, None], (1, 1, 1, 1), mode='replicate')[0, 0]
        acc = torch.zeros_like(H)
        for dy, dxo in offs:
            d = dx * (math.sqrt(2) if dy and dxo else 1.0)
            nb = P[1 + dy:1 + dy + n, 1 + dxo:1 + dxo + n]
            lim = angle_tan * d
            acc += (nb - H - lim).clamp(min=0) - (H - nb - lim).clamp(min=0)
        if fixed is not None:
            acc = torch.where(fixed, torch.zeros_like(acc), acc)
        H += acc * (rate / 8)
    return H
