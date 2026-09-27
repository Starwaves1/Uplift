"""Export the finished island for the game.

island.bin   heights: 'WBIS' header, then zlib(deflate) of a LOCO-I (median-edge) predicted, zig-zag coded residual
             stream of 0.1 m quantised heights, bytes split into low/high planes (compresses ~2× better)
island_maps.png   RGBA8 data maps (2048²): r river flow (log area), g alluvium/sediment, b scree/loose rock, a rock
             exposure (cliffs)
island_regions.png   RGBA8 (1024²): r Nordic, g Mediterranean, b plateau, a volcano (Alpine = the rest)

usage: python export.py tag N outdir
"""
import sys, struct, zlib, os
import numpy as np
from PIL import Image
from paths import WORK

Q = 0.1            # m per step
OFF = -400.0       # height at step 0


def encode_heights(h):
    n = h.shape[0]
    q = np.clip(np.round((h - OFF) / Q), 0, 65535).astype(np.int32)
    a = np.zeros_like(q); b = np.zeros_like(q); c = np.zeros_like(q)
    a[:, 1:] = q[:, :-1]; b[1:, :] = q[:-1, :]; c[1:, 1:] = q[:-1, :-1]
    mx = np.maximum(a, b); mn = np.minimum(a, b)
    pred = np.where(c >= mx, mn, np.where(c <= mn, mx, a + b - c))
    pred[0, 1:] = q[0, :-1]; pred[1:, 0] = q[:-1, 0]; pred[0, 0] = 0
    r = q - pred
    z = np.where(r >= 0, 2 * r, -2 * r - 1).astype(np.uint32)
    assert z.max() < 65536, 'residual overflow'
    z = z.astype(np.uint16)
    planes = np.concatenate([(z & 255).astype(np.uint8).ravel(), (z >> 8).astype(np.uint8).ravel()])
    body = zlib.compress(planes.tobytes(), 9)
    head = b'WBIS' + struct.pack('<IIffff', 1, n, 64000.0, -32000.0, Q, OFF)
    return head + body


def decode_heights(buf):
    """Reference decoder (mirrors the game's JS): returns heights in metres."""
    from numba import njit
    n = struct.unpack('<I', buf[8:12])[0]
    q0, off = struct.unpack('<ff', buf[20:28])
    planes = np.frombuffer(zlib.decompress(buf[28:]), np.uint8)
    z = (planes[:n * n].astype(np.int32) | (planes[n * n:].astype(np.int32) << 8)).reshape(n, n)
    r = np.where(z & 1, -((z + 1) >> 1), z >> 1).astype(np.int32)

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
                q[y, x] = p + r[y, x]
        return q
    return rebuild(r, n) * q0 + off


if __name__ == '__main__':
    tag, N, outdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    h = np.load(f'{WORK}/h_{tag}_{N}.npy').astype(np.float64)
    blob = encode_heights(h)
    open(os.path.join(outdir, 'island.bin'), 'wb').write(blob)
    print('island.bin', len(blob) / 1e6, 'MB for', h.shape)
    # data maps (2048²) and region weights (1024²), RGBA8, one zlib stream
    maps = np.load(f'{WORK}/maps_{tag}_{N}.npy').astype(np.float32)
    regs = np.load(f'{WORK}/regions_{tag}_{N}.npy').astype(np.float32)
    def down(a, f):
        n0 = a.shape[0] // f
        return a.reshape(n0, f, n0, f, 4).mean((1, 3))
    m2 = np.clip(down(maps, N // 2048), 0, 255).round().astype(np.uint8)
    r1 = np.clip(down(regs, N // 1024), 0, 255).round().astype(np.uint8)
    # lakes: an id mask (dilated a little: the shore itself is where the water plane meets the land) and their levels
    import json
    from scipy import ndimage
    lab = np.load(f'{WORK}/lakes_{tag}_{N}.npy').astype(np.int32)
    table = json.load(open(f'{WORK}/lakes_{tag}_{N}.json'))
    grown = ndimage.grey_dilation(lab, size=(5, 5))
    lab = np.where(lab > 0, lab, grown).astype(np.uint8)
    dx = 64000.0 / N
    lakes = [{'id': t['id'], 'level': t['level'], 'area': t['area'],
              'rect': [-32000 + (t['bbox'][1] - 3) * dx, -32000 + (t['bbox'][0] - 3) * dx, -32000 + (t['bbox'][3] + 3) * dx, -32000 + (t['bbox'][2] + 3) * dx]}
             for t in table if t['id'] < 256]
    jb = json.dumps(lakes).encode()
    mblob = b'WBIM' + struct.pack('<IIIII', 2, m2.shape[0], r1.shape[0], N, len(jb)) + zlib.compress(m2.tobytes() + r1.tobytes() + lab.tobytes() + jb, 9)
    open(os.path.join(outdir, 'island_maps.bin'), 'wb').write(mblob)
    print('island_maps.bin', len(mblob) / 1e6, 'MB')
    back = decode_heights(blob)
    err = np.abs(back - h).max()
    print('round trip max error %.3f m (quantisation %.2f)' % (err, Q))
    assert err <= Q * 0.51 + 1e-3
