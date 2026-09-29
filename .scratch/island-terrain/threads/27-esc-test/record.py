"""Record the ticket 27 Esc sequence on the old and fixed builds (headless, muted, simulated pointer lock), side by side.
usage: py record.py [probe]"""
import base64, io, json, os, subprocess, sys, time
sys.path.insert(0, r'C:\Users\garre\Documents\code\uplift\tools')
import headless
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = r'C:\Users\garre\Documents\code\uplift\.scratch\island-terrain\threads\27-esc-test'
FFMPEG = os.path.join(HERE, 'ffmpeg', 'ffmpeg.exe')
W, H, FPS = 960, 540, 25
SIM = open(os.path.join(HERE, 'sim.js'), encoding='utf-8').read()
BUILDS = [('old', 'OLD BUILD (main)', False), ('fixed', 'FIXED BUILD (branch)', True)]

# (seconds, JS) — the same inputs at the same times for both builds
T = [
    (0.0, "SIM.caption('Flying. The mouse is captured.')"),
    (1.2, "SIM.key('w', 'KeyW')"),
    (2.0, "SIM.caption('1 \u00b7 Esc while flying  \u2192  expected: pause menu'); SIM.esc()"),
    (3.8, "SIM.key('w', 'KeyW')"),
    (4.5, "SIM.caption('2 \u00b7 Esc in the pause menu  \u2192  expected: back to flying, mouse captured'); SIM.esc()"),
    (6.8, "SIM.key('w', 'KeyW')"),
    (7.5, "SIM.caption('3 \u00b7 Esc while flying  \u2192  expected: pause menu'); SIM.esc()"),
    (9.3, "SIM.key('w', 'KeyW')"),
    (10.0, "SIM.caption('4 \u00b7 Esc in the pause menu  \u2192  expected: back to flying, mouse captured'); SIM.esc()"),
    (11.8, "SIM.key('w', 'KeyW')"),
    (12.5, "SIM.caption('5 \u00b7 Esc, then Esc again 0.4 s later (Chrome refuses the mouse for 1.25 s after an Esc)'); SIM.esc()"),
    (12.9, "SIM.esc()"),
    (15.0, "SIM.caption('6 \u00b7 One click  \u2192  expected: mouse captured again')"),
    (15.3, "SIM.click()"),
]
END = 18.0


def record(name, label, good, probe=False):
    url = f'http://127.0.0.1:8775/windborne-test-esc-{name}.html'
    with headless.Browser(size=(W, H)) as b:
        b.goto(url)
        info = b.js('HB.ready({ play: false, materials: true, timeout: 90000 })', timeout=120)
        print(name, json.dumps(info)[:200])
        b.js(f'window.__SIM_LABEL = {json.dumps(label)}; window.__SIM_GOOD = {json.dumps(good)};')
        b.js(SIM)
        b.js("SIM.click(document.getElementById('fly'))")
        time.sleep(0.3)
        b.js("SIM.key('c', 'KeyC'); FLIGHT.g.pos[1] += 250; FLIGHT.g.invuln = 1e6")
        b.js('R.pump(120, HB.dtMs)')
        frames, todo = [], list(T)
        t0 = last = time.perf_counter()
        while True:
            now = time.perf_counter(); t = now - t0
            if t > (1.0 if probe else END):
                break
            while todo and todo[0][0] <= t:
                b.js(todo.pop(0)[1])
            dt = min(50.0, (now - last) * 1000); last = now
            b.js(f'R.frame({dt:.2f}); SIM.update()')
            r = b.call('Page.captureScreenshot', {'format': 'jpeg', 'quality': 90, 'captureBeyondViewport': False}, session=True)
            frames.append((t, base64.b64decode(r['data'])))
        print(name, len(frames), 'frames', f'{len(frames) / frames[-1][0]:.1f} fps captured')
        return frames


def main():
    probe = 'probe' in sys.argv
    runs = [record(n, l, g, probe) for n, l, g in BUILDS]
    if probe:
        for (n, _, _), fr in zip(BUILDS, runs):
            open(os.path.join(HERE, f'probe_{n}.jpg'), 'wb').write(fr[-1][1])
        return
    fdir = os.path.join(HERE, 'frames'); os.makedirs(fdir, exist_ok=True)
    for f in os.listdir(fdir):
        os.remove(os.path.join(fdir, f))
    idx = [0, 0]
    for i in range(int(END * FPS)):
        t = i / FPS
        img = Image.new('RGB', (W * 2 + 6, H), (0, 0, 0))
        for k, fr in enumerate(runs):
            while idx[k] + 1 < len(fr) and fr[idx[k] + 1][0] <= t:
                idx[k] += 1
            img.paste(Image.open(io.BytesIO(fr[idx[k]][1])).convert('RGB'), (k * (W + 6), 0))
        img.save(os.path.join(fdir, f'{i:05d}.jpg'), quality=92)
    out = os.path.join(OUT, 'esc27-old-vs-fixed.mp4')
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(fdir, '%05d.jpg'),
                    '-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', out], check=True)
    print('saved', out)


main()
