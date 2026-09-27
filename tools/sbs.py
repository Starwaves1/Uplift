"""Side-by-side review images from shot pairs: shots/<name>_off.png | shots/<name>_on.png → shots/sbs_<name>.jpg.

usage: python tools/sbs.py name [name ...] [--labels "before" "after"]
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

SH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'shots')
args = sys.argv[1:]
labels = ('procedural (before)', 'photo materials (after)')
if '--labels' in args:
    i = args.index('--labels'); labels = (args[i + 1], args[i + 2]); args = args[:i] + args[i + 3:]
try:
    font = ImageFont.truetype('DejaVuSans-Bold.ttf', 26)
except OSError:
    font = ImageFont.load_default()
for name in args:
    a = Image.open(os.path.join(SH, f'{name}_off.png')).convert('RGB')
    b = Image.open(os.path.join(SH, f'{name}_on.png')).convert('RGB')
    w, h = a.size[0] // 2, a.size[1] // 2
    S = Image.new('RGB', (w * 2 + 8, h), (18, 18, 18))
    S.paste(a.resize((w, h), Image.LANCZOS), (0, 0)); S.paste(b.resize((w, h), Image.LANCZOS), (w + 8, 0))
    d = ImageDraw.Draw(S)
    for x, t in ((14, labels[0]), (w + 22, labels[1])):
        d.text((x + 2, 14), t, font=font, fill=(0, 0, 0)); d.text((x, 12), t, font=font, fill=(255, 255, 255))
    out = os.path.join(SH, f'sbs_{name}.jpg')
    S.save(out, quality=90)
    print(out)
