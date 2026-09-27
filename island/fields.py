"""Noise and shape fields for designing the island (torch on the GPU; results returned as numpy float64 grids)."""
import numpy as np
import torch
import torch.nn.functional as F

dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def noise(n, g, seed):
    """Smooth random field (bicubic-interpolated g×g gaussian lattice), zero mean, unit-ish variance."""
    gen = torch.Generator(device='cpu').manual_seed(seed)
    lat = torch.randn(1, 1, g + 4, g + 4, generator=gen).to(dev)
    out = F.interpolate(lat, size=(n + int(4 * n / g),) * 2, mode='bicubic', align_corners=False)
    o = int(2 * n / g)
    return out[0, 0, o:o + n, o:o + n]


def fbm(n, base, octaves, seed, gain=0.5, lac=2.0):
    s = torch.zeros(n, n, device=dev); a = 1.0; norm = 0.0; g = float(base)
    for k in range(octaves):
        if g > n / 2:
            break
        s += a * noise(n, int(g), seed + 101 * k)
        norm += a * a; a *= gain; g *= lac
    return s / norm ** 0.5


def warp(field, dx, dy):
    """Sample field (n×n tensor) at positions offset by (dx, dy) in cells."""
    n = field.shape[0]
    ys, xs = torch.meshgrid(torch.arange(n, device=dev, dtype=torch.float32), torch.arange(n, device=dev, dtype=torch.float32), indexing='ij')
    gx = (xs + dx) / (n - 1) * 2 - 1
    gy = (ys + dy) / (n - 1) * 2 - 1
    grid = torch.stack([gx, gy], -1)[None]
    return F.grid_sample(field[None, None], grid, mode='bilinear', padding_mode='border', align_corners=True)[0, 0]


def coords(n, L):
    """Cell-centre coordinates in km, (x east, y south) over [0, L]."""
    c = (torch.arange(n, device=dev, dtype=torch.float32) + 0.5) * (L / n)
    Y, X = torch.meshgrid(c, c, indexing='ij')
    return X, Y


def dist_to_polyline(X, Y, pts):
    """Distance (km) from every cell to a polyline, and the normalised arc position (0..1) of the nearest point."""
    pts = torch.tensor(pts, device=dev, dtype=torch.float32)
    seg_len = torch.linalg.norm(pts[1:] - pts[:-1], dim=1)
    total = seg_len.sum()
    best = torch.full_like(X, 1e9); arc = torch.zeros_like(X); acc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ab = b - a; L2 = (ab * ab).sum()
        t = (((X - a[0]) * ab[0] + (Y - a[1]) * ab[1]) / L2).clamp(0, 1)
        px = a[0] + t * ab[0]; py = a[1] + t * ab[1]
        d = torch.sqrt((X - px) ** 2 + (Y - py) ** 2)
        m = d < best
        best = torch.where(m, d, best)
        arc = torch.where(m, (acc + t * seg_len[i]) / total, arc)
        acc += float(seg_len[i])
    return best, arc


def smoothstep(a, b, x):
    t = ((x - a) / (b - a)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def blur(x, sigma_cells):
    """Gaussian blur of an n×n tensor (separable)."""
    r = int(3 * sigma_cells) + 1
    k = torch.exp(-0.5 * (torch.arange(-r, r + 1, device=dev, dtype=torch.float32) / sigma_cells) ** 2)
    k = (k / k.sum())
    y = F.conv2d(F.pad(x[None, None], (r, r, 0, 0), mode='replicate'), k.view(1, 1, 1, -1))
    y = F.conv2d(F.pad(y, (0, 0, r, r), mode='replicate'), k.view(1, 1, -1, 1))
    return y[0, 0]
