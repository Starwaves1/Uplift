"""The terrain's photoscanned materials: which scans, at what real-world size, for what ground — and the build that
turns the 4K sources (assets/src/polyhaven, fetched by fetch_polyhaven.py) into the game's layer images.

Two kinds of scan: aerial (drone) scans of 15–90 m of ground, which are what a glider sees from 100–800 m up, and
close-ups of 1.3–3 m, which carry the detail when you skim the ground. Each layer ships as two RGB images at SIZE²
(no alpha: browsers may premultiply it on decode, which would wreck the colour wherever alpha is low):
  <id>_c.webp  albedo (sRGB), with a little of the scan's ambient occlusion folded in
  <id>_n.webp  RG tangent normal (OpenGL: +x right, +y up), B height (0 low … 1 high, for height-blending layers)
Albedo is levelled first: big light/dark gradients across the scan (uneven lighting, a darker corner) are divided out,
so a tile repeated across a hillside doesn't show the same blotch every 50 m; then its brightness is set to a
plausible real albedo, so every material sits right next to its neighbours under the same sun.

usage (WSL venv):  python assets/materials.py stats | sheet | build
"""
import json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src', 'polyhaven')
OUT = os.path.join(HERE, 'materials')
SIZE = 1024
Image.MAX_IMAGE_PIXELS = None

# id: (scale, tile m, role). scale 'aerial' = seen from the air; 'close' = ground detail
LAYERS = {
    'aerial_rocks_02': ('aerial', 50, 'granite mountainside'),
    'aerial_rocks_04': ('aerial', 80, 'broken grey rock'),
    'rocky_terrain_02': ('aerial', 90, 'rocky alpine grassland'),
    'aerial_grass_rock': ('aerial', 15, 'grass and rock: Nordic fell'),
    'aerial_ground_rock': ('aerial', 20, 'stony dry ground: Mediterranean'),
    'coast_sand_rocks_02': ('aerial', 15, 'rocky shore'),
    'aerial_beach_01': ('aerial', 30, 'beach sand'),
    'snow_field_aerial': ('aerial', 80, 'snowfield'),
    'rock_face_03': ('close', 2.7, 'cliff face (triplanar)'),
    'rock_06': ('close', 1.5, 'pale layered rock: plateau walls'),
    'sandstone_cracks': ('close', 2.0, 'cracked pale rock: plateau tops'),
    'rocks_ground_02': ('close', 2.0, 'scree'),
    'gravelly_sand': ('close', 2.5, 'gravel: river beds, fans'),
    'leafy_grass': ('close', 2.0, 'meadow grass'),
    'forest_leaves_02': ('close', 3.0, 'forest floor'),
    'brown_mud_dry': ('close', 1.3, 'dry soil'),
    'red_laterite_soil_stones': ('close', 2.0, 'red stony soil'),
    'snow_02': ('close', 2.0, 'snow'),
}


# levelled brightness (linear luminance) per layer: real-world albedos, lifted ~1.3× to sit with the game's current
# exposure (its procedural meadow was ~0.2, its granite ~0.23). The scans themselves range from 0.06 to 0.41.
TARGET = {
    'aerial_rocks_02': 0.17, 'aerial_rocks_04': 0.15, 'rocky_terrain_02': 0.12, 'aerial_grass_rock': 0.14,
    'aerial_ground_rock': 0.24, 'coast_sand_rocks_02': 0.11, 'aerial_beach_01': 0.42, 'snow_field_aerial': 0.55,
    'rock_face_03': 0.24, 'rock_06': 0.24, 'sandstone_cracks': 0.36, 'rocks_ground_02': 0.2, 'gravelly_sand': 0.24,
    'leafy_grass': 0.14, 'forest_leaves_02': 0.12, 'brown_mud_dry': 0.19, 'red_laterite_soil_stones': 0.14,
    'snow_02': 0.82,
}


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def lum(c):
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def load(sid, key, mode=None):
    man = json.load(open(os.path.join(SRC, 'manifest.json')))
    f = man[sid]['maps'].get(key)
    if not f:
        return None
    im = Image.open(os.path.join(SRC, sid, f['file']))
    return im.convert(mode) if mode else im


def stats():
    for sid, (sc, tile, role) in LAYERS.items():
        a = np.asarray(load(sid, 'Diffuse', 'RGB').resize((512, 512), Image.BOX), np.float32) / 255
        L = srgb_to_lin(a)
        m = L.reshape(-1, 3).mean(0)
        print(f'{sid:26s} {sc:6s} {tile:5.1f} m  mean lin {m.round(3)}  lum {lum(m):.3f}  p5/p95 lum '
              f'{np.percentile(lum(L), 5):.3f}/{np.percentile(lum(L), 95):.3f}   {role}')


def sheet():
    ims = []
    for sid in LAYERS:
        ims.append(load(sid, 'Diffuse', 'RGB').resize((320, 320), Image.BOX))
    cols = 6
    S = Image.new('RGB', (cols * 320, (len(ims) + cols - 1) // cols * 340), (20, 20, 20))
    from PIL import ImageDraw
    d = ImageDraw.Draw(S)
    for i, (im, sid) in enumerate(zip(ims, LAYERS)):
        x, y = i % cols * 320, i // cols * 340
        S.paste(im, (x, y))
        d.text((x + 4, y + 322), f'{i} {sid} {LAYERS[sid][1]}m', fill=(230, 230, 230))
    os.makedirs(os.path.join(HERE, 'preview'), exist_ok=True)
    S.save(os.path.join(HERE, 'preview', 'contact.png'))
    print('sheet', S.size)


def _down(a, size=SIZE):
    """Area-average a float image (h, w[, c]) down to size² (the sources are 4096², so an exact 4×4 box)."""
    k = a.shape[0] // size
    return a.reshape(size, k, size, k, *a.shape[2:]).mean((1, 3))


def _blur_wrap(x, sigma):
    """Gaussian blur of a seamless (tiling) image, by FFT."""
    n = x.shape[0]
    f = np.fft.fftfreq(n)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(x) * g))


def build(level=0.8, targets=None):
    """targets: {id: linear luminance to set the levelled albedo to} (default: keep the scan's own)."""
    targets = TARGET if targets is None else targets
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.webp'):
            os.remove(os.path.join(OUT, f))
    meta = []                                                          # in array-layer order
    for sid, (sc, tile, role) in LAYERS.items():
        A = srgb_to_lin(_down(np.asarray(load(sid, 'Diffuse', 'RGB'), np.float32) / 255))
        L = lum(A)
        # level the big gradients (half-tile blur), keep everything smaller
        Lb = _blur_wrap(L, SIZE / 8)
        A = A * ((L.mean() / np.maximum(Lb, 1e-4)) ** level)[..., None]
        t = targets.get(sid)
        if t:
            A = A * (t / lum(A.reshape(-1, 3).mean(0)))
        H = load(sid, 'Displacement', 'F')
        H = _down(np.asarray(H, np.float32)) if H is not None else L
        lo, hi = np.percentile(H, [1, 99])
        H = np.clip((H - lo) / max(hi - lo, 1e-6), 0, 1)
        Nm = _down(np.asarray(load(sid, 'nor_gl', 'RGB'), np.float32) / 255 * 2 - 1)
        Nm /= np.linalg.norm(Nm, axis=-1, keepdims=True) + 1e-6
        O = load(sid, 'AO', 'L')
        if O is not None:                                              # crevices a touch darker, mean kept
            O = _down(np.asarray(O, np.float32) / 255) ** 0.35
            A = A * (O / O.mean())[..., None]
        c = lin_to_srgb(A)
        nrm = np.dstack([Nm[..., 0] * 0.5 + 0.5, Nm[..., 1] * 0.5 + 0.5, H])
        Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB').save(
            os.path.join(OUT, f'{sid}_c.webp'), quality=88, method=6)
        Image.fromarray((np.clip(nrm, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB').save(
            os.path.join(OUT, f'{sid}_n.webp'), quality=90, method=6)
        m = A.reshape(-1, 3).mean(0)
        meta.append({'id': sid, 'scale': sc, 'tile': tile, 'role': role, 'albedo': [round(float(v), 4) for v in m]})
        kb = sum(os.path.getsize(os.path.join(OUT, f'{sid}_{s}.webp')) for s in 'cn') / 1024
        print(f'{sid:26s} albedo lin {np.round(m, 3)}  lum {lum(m):.3f}   {kb:6.0f} KB', flush=True)
    json.dump({'size': SIZE, 'layers': meta}, open(os.path.join(OUT, 'materials.json'), 'w'), indent=1)


if __name__ == '__main__':
    {'stats': stats, 'sheet': sheet, 'build': build}[sys.argv[1]]()
