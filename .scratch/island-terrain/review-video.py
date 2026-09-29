"""Review videos for the 2026-09-29 sitting: each ticket's spectator bookmarks filmed as a slow forward dolly, the
branch build side by side with its baseline, with captions saying what to look for.

usage: py review-video.py 28 [17 31 19 23]        one mp4 per ticket into review-2026-09-29/
       py review-video.py probe 31                 one spot, 2 s, saves a probe jpg, prints timings

Headless, muted, no window, no pointer lock (tools/headless.py). Frames are fixed 1/30 s steps, so A and B are in
lockstep. The camera is the game's ?fly spectator: it moves on synthetic W/D key events, at a speed set by wheel
events (it starts at 150 m/s and each wheel notch scales by 0.8)."""
import base64, io, json, math, os, subprocess, sys, time
sys.path.insert(0, r'C:\Users\garre\Documents\code\uplift\tools')
import headless
from PIL import Image, ImageDraw, ImageFont

OUT = r'C:\Users\garre\Documents\code\uplift\.scratch\island-terrain\review-2026-09-29'
FFMPEG = r'C:\Users\garre\AppData\Local\Temp\esc27\ffmpeg\ffmpeg.exe'
FONT = r'C:\Windows\Fonts\segoeui.ttf'
FONT_B = r'C:\Windows\Fonts\segoeuib.ttf'
FPS, SEC, W, H, GAP, BAR = 30, 6.0, 1600, 900, 6, 44
PAGE = 'windborne-test-flora,fauna,glider,landmarks,windfx.html'

def u(port, page=PAGE, **q):
    return f'http://127.0.0.1:{port}/{page}?fly' + ''.join(f'&{k}={v}' for k, v in q.items())

# ticket -> sides [(label, base url)], spots [(name, (x, y, hdg, alt), what to look for)]
TICKETS = {
    '28': dict(title='Ticket 28  climate fields: erosion from real rainfall (WNW wind, wet west, dry lee)',
        sides=[('NEW  climate rain  (island=c28clim)', u(8776, island='c28clim')), ('OLD  regional rain  (island=c28old)', u(8776, island='c28old'))],
        spots=[('West coast, windward', (2.5, 30, 100, 700), 'wet side: should look much as before'),
               ('Great valley', (12.5, 35.3, 77, 300), 'should look much as before'),
               ('Upper valley', (31, 29.8, 62, 300), 'massif behind is now the highest Alpine summit'),
               ('Valley head', (36.5, 27.8, 70, 400), 'decision B: the drawn trough cuts 730 m deep with flat walls'),
               ('East, lee side', (40, 36, 270, 600), 'dry lee: taller, more rugged'),
               ('Plateau, lee side', (50, 42, 290, 600), 'top 605 m -> 1153 m; rock beds read as terraces'),
               ('South coast', (27, 53.5, 350, 500), 'taller and more rugged'),
               ('Nordic west coast', (9, 16.4, 120, 400), 'wet side: little change expected')]),
    '17': dict(title='Ticket 17  rock structure round 3: real rock types under the erosion (island=rock3 vs rock1)',
        sides=[('NEW  rock3', u(8765, island='rock3')), ('BEFORE  rock1 (round 1)', u(8765, island='rock1'))],
        spots=[('Mediterranean massif', (29, 43.5, 215, 450), 'walls and tilted beds; do the southern bands still read as terraces?'),
               ('Alpine peak and ridges', (27.5, 22, 225, 550), 'sharper crests; any smooth single-slope domes or regular banding?'),
               ('Nordic coast', (19, 10.5, 200, 300), 'jagged ridges; are the faces still broad planes?'),
               ('Volcano gorges', (53.5, 10.5, 200, 400), 'volcano on an old lava field; lake should hold'),
               ('Plateau', (51, 31.5, 205, 600), 'twice the cliffs; do the mesas still look like loaves?')]),
    '31': dict(title='Ticket 31  topsoil and sediments: talus, drift, channels (island=soil1 vs soil0)',
        sides=[('NEW  soil1', u(8783, island='soil1')), ('BEFORE  soil0', u(8783, island='soil0'))],
        spots=[('South coast', (26, 52, 0, 700), 'decide: is 12 % of the land as scree right?'),
               ('Alpine front', (27, 31, 150, 900), 'talus cones below bare walls; ranges keep their height now'),
               ('Nordic fjords', (16, 18, 220, 900), 'drift mosaic on scoured ground'),
               ('Great valley trough wall', (25, 33, 60, 500), 'how much bare rock do you want?')]),
    '19': dict(title='Ticket 19  river water: no hole under a low camera, no folded bends, softer pools and foam',
        sides=[('NEW  ticket 19', u(8771)), ('BEFORE  pre-ticket build', u(8771, page='windborne-test-before19.html'))],
        spots=[('Alpine brook', (23.76, 18.36, 249, 18), 'clear brown water, foam streaks; water under the camera'),
               ('Big river, 4 m up', (15.03, 42.93, 251, 4), 'reflections, no hole'),
               ('Stream into lake 19', (29.65, 42.30, 65, 20), 'reads as water, not bare ground'),
               ('River into lake 16', (10.11, 40.04, 0, 18), 'the join'),
               ('Lake 16 village', (10.11, 40.19, 0, 110), 'REGRESSION: river runs through two houses (ticket 12 problem)'),
               ('Lake 7 shore', (11.04, 29.525, 150, 40), 'thin pale rim, no smear'),
               ('Great valley river', (14.7, 35.0, 235, 60), ''),
               ('Southern brook', (32.21, 28.14, 119, 18), 'still silvery grey at a grazing angle: acceptable?')]),
    '23': dict(title='Ticket 23  clouds and weather: cumulus, rain curtains, orographic cloud, high layers',
        sides=[('NEW  ticket 23', u(8774)), ('BEFORE  old clouds', u(8774, page='windborne-test-before.html'))],
        spots=[('Alpine, building weather', (22, 38, 30, 1800), 'towers only on big clouds; one rounded summit each', dict(wx='building')),
               ('Valley, showery', (12.5, 35.3, 77, 150), 'rain curtains hang from cloud base to ground, trail upwind', dict(wx='showery')),
               ('Valley, overcast', (14, 35, 77, 400), 'deck of rounded cells that breaks up at its edges', dict(wx='overcast')),
               ('Valley, fair', (14, 35, 300, 400), 'flat small puffs; clouds lean downwind of their thermal', dict(wx='fair')),
               ('Nordic coast, showery', (20, 15, 340, 120), 'orographic cloud on windward slopes; lee clears', dict(wx='showery')),
               ('Valley, natural weather', (12.5, 35.3, 77, 300), 'whatever the cycle gives; no cloud base within 240 m of ground')]),
}

def speed_notches(alt):  # forward speed from the bookmark height: 5 m/s at 4 m, ~60 m/s at 700 m, 90 m/s at 1800 m
    v = min(90, max(5, alt * 0.085))
    return max(0, round(math.log(v / 150) / math.log(0.8)))

def film(b, url, at, extra, seconds):
    x, y, hdg, alt = at
    full = url + f'&at={x},{y},{hdg},{alt}' + ''.join(f'&{k}={v}' for k, v in (extra or {}).items())
    b.goto(full)
    info = b.js('HB.ready({ play: false, materials: true, timeout: 90000 })', timeout=150)
    if not info.get('materials', True) and 'materials' in info: print('   (materials not ready)', file=sys.stderr)
    # leave the title screen: play mode hides the overlay and lets the spectator move (pointer lock is refused, so the
    # game falls back to its no-lock mode and never pauses)
    b.js("(document.getElementById('fly') || [...document.querySelectorAll('button')].find(e => /take flight/i.test(e.textContent))).click()")
    b.js('R.pump(10, HB.dtMs)')
    mode = b.js('document.body.dataset.mode')
    if mode != 'play': raise RuntimeError(f'not in play mode after Take flight: {mode!r}')
    n = speed_notches(alt)
    b.js(f"for (let i = 0; i < {n}; i++) window.dispatchEvent(new WheelEvent('wheel', {{ deltaY: 100 }}));")
    b.js('R.pump(90, HB.dtMs)')  # settle: streaming, materials, cloud state
    p0 = b.js('Array.from(FLIGHT.cam.pos)')
    b.js("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }))")
    frames = []
    for i in range(int(seconds * FPS)):
        b.js(f'R.frame({1000 / FPS:.3f})')
        r = b.call('Page.captureScreenshot', {'format': 'jpeg', 'quality': 88, 'captureBeyondViewport': False}, session=True)
        frames.append(base64.b64decode(r['data']))
    b.js("window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }))")
    p1 = b.js('Array.from(FLIGHT.cam.pos)')
    moved = math.dist(p0, p1)
    if moved < 1: print(f'   WARNING camera did not move at {at}', file=sys.stderr)
    return frames

def compose(ticket, spec, runs, fdir):
    fb, fs, ft = ImageFont.truetype(FONT_B, 26), ImageFont.truetype(FONT, 24), ImageFont.truetype(FONT, 22)
    n_sides = len(spec['sides']); TW = W * n_sides + GAP * (n_sides - 1); TH = BAR + H + BAR
    os.makedirs(fdir, exist_ok=True)
    for f in os.listdir(fdir): os.remove(os.path.join(fdir, f))
    k = 0
    for si, spot in enumerate(spec['spots']):
        name, at, look = spot[0], spot[1], spot[2]
        for fi in range(len(runs[0][si])):
            img = Image.new('RGB', (TW, TH), (12, 12, 12)); d = ImageDraw.Draw(img)
            for s in range(n_sides):
                img.paste(Image.open(io.BytesIO(runs[s][si][fi])).convert('RGB'), (s * (W + GAP), BAR))
                d.text((s * (W + GAP) + 14, 9), spec['sides'][s][0], font=fb, fill=(255, 255, 255))
            d.text((TW - 14, 9), spec['title'], font=ft, fill=(200, 200, 200), anchor='ra')
            cap = f'{si + 1}/{len(spec["spots"])}  {name}   at={",".join(str(v) for v in at)}'
            d.text((14, BAR + H + 8), cap, font=fb, fill=(255, 255, 255))
            if look: d.text((TW - 14, BAR + H + 9), look, font=fs, fill=(255, 224, 140), anchor='ra')
            img.save(os.path.join(fdir, f'{k:05d}.jpg'), quality=90); k += 1
    return k

def make(ticket, seconds=SEC, probe=False):
    spec = TICKETS[ticket]; t0 = time.time()
    spots = spec['spots'][:1] if probe else spec['spots']
    runs = []
    for label, base in spec['sides']:
        with headless.Browser(size=(W, H)) as b:
            side = []
            for spot in spots:
                t1 = time.time()
                side.append(film(b, base, spot[1], spot[3] if len(spot) > 3 else None, seconds))
                print(f'  {ticket} {label[:14]:14} {spot[0]:28} {len(side[-1])} frames in {time.time() - t1:5.1f} s', flush=True)
            runs.append(side)
    os.makedirs(OUT, exist_ok=True)
    if probe:
        spec2 = dict(spec, spots=spots); fdir = os.path.join(OUT, f'probe_{ticket}')
        compose(ticket, spec2, runs, fdir)
        print('probe frames in', fdir, f'{time.time() - t0:.0f} s total'); return
    fdir = os.path.join(os.environ.get('TEMP', OUT), f'rv_{ticket}')
    n = compose(ticket, spec, runs, fdir)
    out = os.path.join(OUT, f'{ticket}-review.mp4')
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(fdir, '%05d.jpg'),
                    '-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                    '-movflags', '+faststart', out], check=True)
    for f in os.listdir(fdir): os.remove(os.path.join(fdir, f))
    print(f'saved {out}  ({n} frames, {n / FPS:.0f} s, {os.path.getsize(out) / 1e6:.1f} MB, {time.time() - t0:.0f} s to make)', flush=True)

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'probe': make(a[1], seconds=2.0, probe=True)
    else:
        for t in a: make(t)
