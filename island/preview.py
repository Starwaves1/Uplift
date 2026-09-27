"""Shaded-relief previews of a heightfield (for judging landforms while iterating)."""
import os
import numpy as np
from PIL import Image


def _ramp(h):
    stops = np.array([0, 60, 350, 800, 1300, 1800, 2300, 3000], float)
    cols = np.array([
        [0.42, 0.52, 0.30], [0.36, 0.50, 0.26], [0.50, 0.56, 0.32], [0.56, 0.52, 0.38],
        [0.55, 0.51, 0.46], [0.62, 0.61, 0.60], [0.93, 0.94, 0.96], [0.97, 0.97, 0.99]])
    out = np.empty(h.shape + (3,))
    for c in range(3):
        out[..., c] = np.interp(h, stops, cols[:, c])
    return out


def render(h, dx, path, A=None, size=None, sea=0.0, z=1.0, river_min=4e6):
    """h: 2D heights (m); dx: cell size (m); A: optional drainage area (m²) to draw rivers."""
    h = np.asarray(h, float)
    gy, gx = np.gradient(h * z, dx)
    nx, ny, nz = -gx, -gy, np.ones_like(h)
    inv = 1 / np.sqrt(nx * nx + ny * ny + nz * nz)
    nx *= inv; ny *= inv; nz *= inv
    # sun from the north-west, 40° up; plus a soft sky term
    L = np.array([-0.6, -0.55, 0.64]); L /= np.linalg.norm(L)
    sun = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    sky = 0.5 + 0.5 * nz
    shade = 0.28 * sky + 0.85 * sun
    col = _ramp(h) * shade[..., None]
    land = h > sea
    depth = np.clip(sea - h, 0, None)
    water = np.stack([0.10 + 0.25 * np.exp(-depth / 25), 0.22 + 0.30 * np.exp(-depth / 30), 0.34 + 0.22 * np.exp(-depth / 60)], -1)
    water *= (0.85 + 0.15 * shade)[..., None]
    col = np.where(land[..., None], col, water)
    if A is not None:
        r = np.clip((np.log10(np.maximum(A, 1)) - np.log10(river_min)) / 2.0, 0, 1) * land
        col = col * (1 - r[..., None] * 0.85) + np.array([0.18, 0.34, 0.55]) * (r[..., None] * 0.85)
    img = Image.fromarray((np.clip(col, 0, 1) ** (1 / 1.1) * 255).astype(np.uint8))
    if size and size != img.size[0]:
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path)
    return path


def oblique(h, dx, path, azim=210, elev=22, width=1600, height=900, z=1.0, sea=0.0, A=None, dist=0.62, alt=0.12, fov=55):
    """Perspective view over the shaded relief (voxel-space column march on the GPU) to judge relief shapes.
    azim: view direction (0 = looking north); the camera sits `dist`·size behind the centre, `alt`·size above the top."""
    import torch
    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    h = np.asarray(h, float); n = h.shape[0]
    tex = torch.tensor(np.asarray(Image.open(render(h, dx, f'/tmp/_ob{os.getpid()}.png', A=A, sea=sea))).astype(np.float32) / 255, device=dev)
    H = torch.tensor(np.maximum(h, sea) * z / dx, device=dev, dtype=torch.float32)
    a = np.radians(azim)
    fwd = np.array([np.sin(a), -np.cos(a)]); right = np.array([np.cos(a), np.sin(a)])
    cx, cy = n / 2 - fwd[0] * n * dist, n / 2 - fwd[1] * n * dist
    camh = float(H.max()) + n * alt
    xs = torch.linspace(-1, 1, width, device=dev) * np.tan(np.radians(fov) / 2)
    rows = torch.arange(height, device=dev, dtype=torch.float32)[:, None]
    sky = torch.tensor([0.62, 0.74, 0.88], device=dev)
    out = sky.expand(height, width, 3).clone()
    ymin = torch.full((width,), float(height), device=dev)
    tilt = np.radians(elev); vf = np.radians(fov) * height / width
    for step in range(2, int(n * 1.6)):
        d = float(step)
        px = cx + fwd[0] * d + right[0] * xs * d; py = cy + fwd[1] * d + right[1] * xs * d
        ok = (px >= 0) & (px < n - 1) & (py >= 0) & (py < n - 1)
        if not bool(ok.any()):
            if d > n * 0.3:
                continue
            continue
        ix = px.clamp(0, n - 1).long(); iy = py.clamp(0, n - 1).long()
        hh = H[iy, ix]
        ang = torch.atan2(camh - hh, torch.tensor(d, device=dev)) - tilt
        sy = (height / 2 + ang / vf * height).clamp(0, height)
        sy = torch.where(ok, sy, ymin)
        fog = float(np.exp(-d / (n * 1.1)))
        c = tex[iy, ix] * fog + sky * (1 - fog)
        m = (rows >= sy[None, :]) & (rows < ymin[None, :])
        out = torch.where(m[..., None], c[None, :, :], out)
        ymin = torch.minimum(ymin, sy)
    Image.fromarray((out.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)).save(path)
    return path
