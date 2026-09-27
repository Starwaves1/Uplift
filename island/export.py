"""Export the finished island for the game.

island.bin (+ island-1.bin, island-2.bin, …)   heights, format 2:
    'WBIS', u32 version (2), u32 n, f32 size (m), f32 origin (m), f32 step (m), f32 offset (m), u32 parts,
    u32 body bytes; then the body: one zlib (deflate) stream, cut into parts of at most PART bytes (the artifact takes
    binary files up to 15 MB) — island.bin holds the header and the first part, island-k.bin the k-th continuation.
    The stream is the zig-zag coded residuals of a planar predictor (west + north − north-west; first row: west, first
    column: north) over heights quantised to `step` metres above `offset`, row by row, one byte per residual — 255
    escapes to two more bytes (low, high) for the rare large ones. The game decodes it as it downloads (boot.js).
    Format 1 (read by the game for old exports): median-edge predictor, all low bytes then all high bytes, one file.
island_maps.bin   'WBIM' v2: RGBA8 data maps (2048²: r river flow (log area), g alluvium/sediment, b scree/loose rock,
    a rock exposure), RGBA8 region weights (1024²: r Nordic, g Mediterranean, b plateau, a volcano; Alpine = the rest),
    the lake id mask (R8, at most 4096², dilated a little) and the lake table (JSON), in one zlib stream.

usage: python export.py tag N outdir
"""
import sys, struct, zlib, os, glob
import numpy as np
from paths import WORK

Q = 0.1                  # m per step
PART = 14_000_000        # bytes per file, under the artifact's 15 MB per binary file
LAKE_MAX = 4096          # the lake mask only has to say which lake a water pixel belongs to: the shore itself is where
                         # the water plane meets the land, so it needs no more than 15.6 m


def quantise(h, step=Q):
    """Integer steps above an offset below the lowest point; 16 bits must span the island."""
    step = float(np.float32(step))               # the header's f32 values, so decoding gives back exactly these steps
    off = float(np.float32((np.floor(h.min() / step) - 2) * step))
    q = np.round((h - off) / step).astype(np.int64)
    assert q.min() >= 0 and q.max() <= 65535, f'height range {h.min():.1f}…{h.max():.1f} m too large for {step} m steps'
    return q, off


def planar_residuals(q):
    p = np.zeros_like(q)
    p[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    p[0, 1:] = q[0, :-1]; p[1:, 0] = q[:-1, 0]
    return q - p


def encode_heights(h, step=Q):
    """→ list of file blobs (island.bin first)."""
    n = h.shape[0]
    q, off = quantise(h, step)
    r = planar_residuals(q).ravel()
    z = np.where(r >= 0, 2 * r, -2 * r - 1)
    assert z.max() < 65536, 'residual overflow'
    big = z >= 255
    k = np.cumsum(big) - big                      # escapes before each sample
    pos = np.arange(z.size) + 2 * k
    stream = np.empty(z.size + 2 * int(big.sum()), np.uint8)
    stream[pos] = np.where(big, 255, z)
    stream[pos[big] + 1] = z[big] & 255
    stream[pos[big] + 2] = z[big] >> 8
    body = zlib.compress(stream.tobytes(), 9)
    del stream, pos, k, z, r
    head0 = 4 + 4 * 8
    parts = max(1, -(-(head0 + len(body)) // PART))
    head = b'WBIS' + struct.pack('<IIffffII', 2, n, 64000.0, -32000.0, step, off, parts, len(body))
    first = PART - len(head)
    blobs = [head + body[:first]] + [body[first + i * PART:first + (i + 1) * PART] for i in range(parts - 1)]
    assert sum(len(b) for b in blobs) == len(head) + len(body) and all(len(b) <= PART for b in blobs)
    return blobs


def part_name(i):
    return 'island.bin' if i == 0 else f'island-{i}.bin'


def decode_heights(blobs):
    """Reference decoder (mirrors the game's JS in boot.js): returns heights in metres (float64)."""
    from numba import njit
    buf = blobs[0]
    ver, n = struct.unpack('<II', buf[4:12])
    step, off = struct.unpack('<ff', buf[20:28])
    if ver == 1:
        planes = np.frombuffer(zlib.decompress(buf[28:]), np.uint8)
        z = (planes[:n * n].astype(np.int64) | (planes[n * n:].astype(np.int64) << 8))
    else:
        parts, blen = struct.unpack('<II', buf[28:36])
        assert parts == len(blobs), f'{parts} parts, {len(blobs)} given'
        body = b''.join([buf[36:]] + list(blobs[1:]))
        assert len(body) == blen
        stream = np.frombuffer(zlib.decompress(body), np.uint8)

        @njit(cache=True)
        def unescape(s, N):
            z = np.empty(N, np.int64)
            j = 0
            for i in range(N):
                b = s[j]
                if b == 255:
                    z[i] = s[j + 1] | (np.int64(s[j + 2]) << 8); j += 3
                else:
                    z[i] = b; j += 1
            assert j == s.size
            return z
        z = unescape(stream, n * n)
    r = np.where(z & 1, -((z + 1) >> 1), z >> 1).reshape(n, n)

    @njit(cache=True)
    def rebuild(r, n, med):
        q = np.zeros((n, n), np.int64)
        for y in range(n):
            for x in range(n):
                if y == 0:
                    p = 0 if x == 0 else q[0, x - 1]
                elif x == 0:
                    p = q[y - 1, 0]
                else:
                    a = q[y, x - 1]; b = q[y - 1, x]; c = q[y - 1, x - 1]
                    if med:
                        mx = max(a, b); mn = min(a, b)
                        p = mn if c >= mx else (mx if c <= mn else a + b - c)
                    else:
                        p = a + b - c
                q[y, x] = p + r[y, x]
        return q
    q = rebuild(r, n, ver == 1)
    assert q.min() >= 0 and q.max() <= 65535
    return q * float(np.float32(step)) + float(np.float32(off))


def export_maps(tag, N, outdir):
    import json
    from scipy import ndimage
    # data maps (2048²) and region weights (1024²), RGBA8, one zlib stream
    maps = np.load(f'{WORK}/maps_{tag}_{N}.npy')
    regs = np.load(f'{WORK}/regions_{tag}_{N}.npy')

    def down(a, n0):
        f = a.shape[0] // n0
        return np.clip(a.reshape(n0, f, n0, f, 4).mean((1, 3), dtype=np.float32), 0, 255).round().astype(np.uint8)
    m2 = down(maps, 2048); r1 = down(regs, 1024)
    del maps, regs
    # lakes: an id mask (dilated a little: the shore itself is where the water plane meets the land) and their levels
    lab = np.load(f'{WORK}/lakes_{tag}_{N}.npy')
    nl = min(N, LAKE_MAX); f = N // nl
    if f > 1:
        lab = lab.reshape(nl, f, nl, f).max((1, 3))
    lab = lab.astype(np.int32)
    table = json.load(open(f'{WORK}/lakes_{tag}_{N}.json'))
    grown = ndimage.grey_dilation(lab, size=(5, 5))
    lab = np.where(lab > 0, lab, grown).astype(np.uint8)
    dx = 64000.0 / N
    lakes = [{'id': t['id'], 'level': t['level'], 'area': t['area'],
              'rect': [-32000 + (t['bbox'][1] - 3) * dx, -32000 + (t['bbox'][0] - 3) * dx, -32000 + (t['bbox'][3] + 3) * dx, -32000 + (t['bbox'][2] + 3) * dx]}
             for t in table if t['id'] < 256]
    jb = json.dumps(lakes).encode()
    mblob = b'WBIM' + struct.pack('<IIIII', 2, m2.shape[0], r1.shape[0], nl, len(jb)) + zlib.compress(m2.tobytes() + r1.tobytes() + lab.tobytes() + jb, 9)
    open(os.path.join(outdir, 'island_maps.bin'), 'wb').write(mblob)
    return len(mblob)


if __name__ == '__main__':
    tag, N, outdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    h = np.load(f'{WORK}/h_{tag}_{N}.npy').astype(np.float64)
    blobs = encode_heights(h)
    for old in glob.glob(os.path.join(outdir, 'island-*.bin')):     # continuation parts of an earlier, larger export
        os.remove(old)
    for i, b in enumerate(blobs):
        open(os.path.join(outdir, part_name(i)), 'wb').write(b)
    hb = sum(len(b) for b in blobs)
    print(f'heights {N}² ({64000 / N:.2f} m): {hb / 1e6:.2f} MB in {len(blobs)} file(s) ' +
          ', '.join(f'{part_name(i)} {len(b) / 1e6:.2f}' for i, b in enumerate(blobs)) + f'  ({hb * 8 / N / N:.2f} bits/sample)')
    mb = export_maps(tag, N, outdir)
    print(f'island_maps.bin {mb / 1e6:.2f} MB')
    back = decode_heights(blobs)
    err = np.abs(back - h)
    deep = h < -400
    print(f'round trip max error {err.max():.4f} m (step {Q} m, bound {Q / 2:.2f});  lowest {h.min():.1f} m, ' +
          (f'{deep.sum()} cells below -400 m, max error there {err[deep].max():.4f} m' if deep.any() else 'nothing below -400 m'))
    assert err.max() <= Q * 0.5 + 1e-3
