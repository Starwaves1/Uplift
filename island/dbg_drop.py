import torch, detail
torch.manual_seed(0)
n = 256
y, x = torch.meshgrid(torch.arange(n, device=detail.dev).float(), torch.arange(n, device=detail.dev).float(), indexing='ij')
H = (300 + 200 * torch.sin(x / 30) * torch.cos(y / 40) + 50 * torch.rand(n, n, device=detail.dev))
H0 = H.clone()
for life in (1, 2, 4, 8, 16, 32):
    H = H0.clone()
    detail.droplets(H, 7.8, 20000, batch=20000, life=life)
    print(life, float(H.min()), float(H.max()), float((H - H0).abs().max()), 'mass', float((H - H0).sum()))
