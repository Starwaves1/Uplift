import numpy as np, torch, torch.nn.functional as F
from scipy import ndimage
import fields as fx, detail
from paths import WORK
N0, N = 2048, 4096
dx = 64000 / N
h0 = np.load(f'{WORK}/h_m_2048.npy').astype(np.float32)
fp = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])


def spikes(h, label):
    h = h.cpu().numpy() if torch.is_tensor(h) else h
    up = h - ndimage.maximum_filter(h, footprint=fp, mode='nearest')
    print(f'{label:24s} spikes>10: {(up > 10).sum():6d}  >20: {(up > 20).sum():5d}  max {up.max():6.1f}', flush=True)


Ht = F.interpolate(torch.tensor(h0, device=fx.dev)[None, None], size=(N, N), mode='bicubic', align_corners=False)[0, 0]
spikes(Ht, 'bicubic upsample')
gy, gx = torch.gradient(Ht, spacing=dx)
steep = torch.sqrt(gx * gx + gy * gy).clamp(0, 1.5)
micro = fx.fbm(N, 64000 / 300, 4, 7, gain=0.5)
Ht = Ht + micro * (0.6 + 3.0 * steep) * (Ht > 1)
spikes(Ht, '+ micro')
H = Ht.clone()
detail.droplets(H, dx, int(N * N * 0.8), spawn=(H > 2).float() + 1e-4, life=64, inertia=0.3, capacity=2.0, erode=0.08,
                deposit=0.03, evaporate=0.02, radius=3)
spikes(H, '+ droplets')
detail.talus(H, dx, torch.full_like(H, 0.9), iters=30)
spikes(H, '+ talus')
