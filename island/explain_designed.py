"""An explainer figure: hand-drawn landforms (lines drawn by hand, then carved) versus generated ones (made by the
landscape model). Writes island/preview/explain_designed_vs_generated.png."""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import preview
import design as ds
import causse, plateau
from paths import WORK

PRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')
S = 760
# the rejected hand-drawn fjord thalwegs (km), kept here only to draw them
REJECTED_FJORDS = [
    [(10.0, 17.0), (12.0, 18.2), (13.8, 19.4), (15.6, 20.4), (17.6, 20.9), (19.6, 21.5), (21.0, 22.8), (21.8, 24.5), (22.4, 26.0), (22.9, 27.2)],
    [(15.0, 12.4), (15.3, 15.0), (16.0, 16.9), (16.2, 18.6), (16.3, 20.4)],
    [(28.6, 12.4), (27.8, 15.5), (26.9, 18.0), (27.1, 20.6), (26.6, 23.0), (25.4, 25.2), (24.8, 26.4)],
]


def panel(path, box, lines, title):
    h = np.load(f'{WORK}/{path}').astype(np.float64)
    n = h.shape[0]; dx = 64000 / n
    x0, y0, x1, y1 = box
    c = h[int(y0 * 1000 / dx):int(y1 * 1000 / dx), int(x0 * 1000 / dx):int(x1 * 1000 / dx)]
    preview.render(c, dx, '/tmp/_ex.png')
    im = Image.open('/tmp/_ex.png').convert('RGB').resize((S, S), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    for pts in lines:
        xy = [((x - x0) / (x1 - x0) * S, (y - y0) / (y1 - y0) * S) for x, y in pts]
        d.line(xy, fill=(230, 30, 30), width=5, joint='curve')
    out = Image.new('RGB', (S, S + 96), (18, 18, 22))
    out.paste(im, (0, 96))
    f = ImageFont.load_default(size=24)
    d = ImageDraw.Draw(out)
    for k, t in enumerate(title):
        d.text((14, 10 + k * 30), t, fill=(255, 255, 255) if k == 0 else (200, 200, 200), font=f)
    return out


nord = (5.0, 8.0, 31.0, 34.0)
pl = (40.0, 30.0, 58.0, 48.0)
a_lines = [causse.GORGE['pts'], causse.LOOP['pts']] + [s['pts'] for s in causse.SIDES + causse.RECULEES + causse.COMBES]
b_lines = [plateau.GORGE] + [s['pts'] for s in plateau.SIDE + plateau.UPPER]
panels = [
    panel('h_q_4096.npy', nord, REJECTED_FJORDS,
          ['HAND-DRAWN fjords (you rejected these)', 'I drew the red lines, then carved a trough along each.']),
    panel('h_g1_1024.npy', nord, [],
          ['GENERATED fjords (the ice-age model)', 'Nobody drew these: ice followed the rivers\' valleys.']),
    panel('h_pl_k12.npy', pl, a_lines,
          ['Plateau design A: HAND-DRAWN', 'Every red line (gorge, side canyons) was drawn by hand.']),
    panel('h_pl_final.npy', pl, b_lines,
          ['Plateau design B: HAND-DRAWN', 'Same method: the gorge and canyons follow drawn lines.']),
]
W, H = S * 2 + 12, (S + 96) * 2 + 12 + 70
fig = Image.new('RGB', (W, H), (40, 40, 46))
for k, p in enumerate(panels):
    fig.paste(p, ((k % 2) * (S + 12), (k // 2) * (S + 96 + 12)))
d = ImageDraw.Draw(fig)
d.text((14, H - 60), '"Generate" for the plateau = raise a hard limestone tableland in the landscape model and let its river',
       fill=(255, 235, 150), font=ImageFont.load_default(size=24))
d.text((14, H - 30), 'cut the gorge wherever it naturally flows, the way the ice cut the fjords.',
       fill=(255, 235, 150), font=ImageFont.load_default(size=24))
fig.save(f'{PRE}/explain_designed_vs_generated.png')
print('ok', fig.size)
