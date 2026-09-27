# tools/

Review tooling for renders of the game (none of it ships).

## headless.py: the one way to take in-game screenshots and measurements

`py tools/headless.py` runs the installed Chrome (or Edge) **headless**, with WebGL on the GPU (ANGLE on Direct3D 11,
on the RX 7900 XT). It loads a muted test build at a spot, runs JavaScript in the page, and saves full-resolution
screenshots. Then it kills the browser. It needs nothing beyond Python and Chrome: the DevTools protocol runs over a
small standard-library WebSocket client, and PIL is used only if it's installed (for the side-by-side images).

It never touches the user's screen, mouse or speakers:
- no window: `--headless=new`, and the process starts hidden (`SW_HIDE`), so it can't take focus;
- no cursor: pointer lock, fullscreen and keyboard lock are refused before the game's scripts run, and nothing sends OS
  input (the harness's `R.centre()` only dispatches a DOM event inside the page);
- no sound: `--mute-audio`, `window.WB_MUTE` forced on, and the tool refuses to load `windborne.html`;
- no leftovers: the browser runs in a kill-on-close job object, so it dies with the tool even if the tool is killed
  outright. Each run gets a fresh temporary profile and picks a free DevTools port, so runs never collide with each
  other, with the user's own browsers, or with the servers on 8765–8791.

**Never** use the desktop app's browser pane, Claude in Chrome, or any desktop-automation tool (clicks, keys, mouse
moves) to look at the game. The user's rule: "If you want to use the computer, do it headlessly and don't take my
actual cursor."

### Which page

`--url` takes a URL (default `http://127.0.0.1:8765/windborne-test-flora,fauna,glider,landmarks,windfx.html`, on the main checkout's static server) **or a
path**. A path like `windborne-test.html` is served from `--root` (default: the checkout the tool is in) on a private
port for the length of the run. Use a path to review your own worktree's build without starting a server:

    sh build-wind.sh                     # writes windborne-test.html (+ windborne.html) in your worktree
    py tools/headless.py shot --url windborne-test.html --at 29,43.5,215,450 --name mine

Always load a muted `windborne-test*.html` build. Check that the build is current. In the main checkout, the newest
full test build (the default) is currently `windborne-test-flora,fauna,glider,landmarks,windfx.html`; `windborne-test.html` there
predates `?fly` / `?at` / `?island`. A build older than `?fly` / `?at` / `?island` would quietly show the title flyby instead of
your spot, so the tool checks that the page honoured them (the camera is at the spot and holds still, the island's
`island.bin` loaded) and stops with "this page ignored …" if not. Serving a path from a worktree only has the
tracked default island; for `--island NAME`, use the main checkout's server, which has `islands/`.

### Commands

Spots are `X,Y,HEADING,ALT`: design-grid km east and south of the island's NW corner, a compass heading, and metres
above the ground. By default a spot is the `?fly` spectator camera. With `--glider`, the tool takes flight in the
glider there instead. Shots go to `shots/` (git-ignored) unless you pass `--out`.

    # the GPU and WebGL renderer, on a blank page and in the game (check it says the RX 7900 XT / D3D11, not SwiftShader)
    py tools/headless.py info

    # one spectator view -> shots/south.png (1920x1080)
    py tools/headless.py shot --at 29,43.5,215,450 --name south

    # a batch in one browser: named spots, or a file of spots (NAME X,Y,HDG,ALT or NAME X Y HDG ALT per line, # comments)
    py tools/headless.py shot --at south=29,43.5,215,450 --at alpine=27.5,22,225,550 --name k14
    py tools/headless.py shot --spots my_spots.txt --name k14             # -> shots/k14_<name>.png

    # another island, time of day, quality (--settings is written into the game's saved settings before it starts)
    py tools/headless.py shot --island fjord1 --at 15.6,12.4,168,250 --settings "{\"tod\":\"dusk\"}" --name fj_dusk

    # before/after: A is --url/--island/--js, B changes one of them. Saves <name>_a.png, <name>_b.png and sbs_<name>.jpg
    py tools/headless.py pair --at 27.5,22,225,550 --name mat --b-js "TERRAIN.materials = false" --labels "materials on" "materials off"
    py tools/headless.py pair --at 15.6,12.4,168,250 --name fjord --island fjord1 --b-island fjord2
    py tools/headless.py pair --at 29,43.5,215,450 --name build --url windborne-test.html --b-url http://127.0.0.1:8765/windborne-test-flora,fauna,glider,landmarks,windfx.html

    # JavaScript: --js steps run after the game is ready, then --settle frames; --expr values print as JSON
    py tools/headless.py run --at 29,43.5,215,450 --js "WB.PROF.on = true" --expr "WB.PROF.report()" --expr "WB.settings"
    # a block of statements works too (use return for a value), and await
    py tools/headless.py run --glider --at 20,30,90,200 --settle 0 --js "for (let i = 0; i < 5; i++) await R.pump(60); return FLIGHT.g.V"

    # the old review harness works unchanged inside it: R.shot / R.pair frames land in --out
    py tools/headless.py run --glider --island fjord1 --at 17.2,16.6,158,300 --settle 0 --js "await R.pair('fj_mid', 17.2, 16.6, 158, 300)"

    # frame-time benchmark: per-pass GPU ms (WB.PROF timer queries) + wall ms per frame with the GPU synced
    py tools/headless.py bench --at 27.5,22,225,550 --frames 300

Other options (`py tools/headless.py <command> -h` has everything):

| option | what it does |
| --- | --- |
| `--settle N` | frames (1/60 s each) pumped after the steps and before a shot (default 150; bench 0, after its own 60 warm-up frames) |
| `--page` | screenshot the composited page (canvas + title/HUD DOM) instead of reading back the canvas |
| `--size WxH` | viewport (default 1920x1080) |
| `--no-materials` | don't wait for the photo ground materials to load |
| `--browser edge` | Edge instead of Chrome (or a path to a browser executable) |
| `--port N` | a fixed DevTools port (default 0: the browser picks a free one) |
| `--console` | print the page's console (errors and exceptions always print) |
| `--allow-software` | carry on even if WebGL isn't on the GPU (by default the tool stops) |

### How it works

- The browser is `chrome.exe --headless=new --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist
  --force_high_performance_gpu --disable-software-rasterizer --mute-audio --window-size=W,H`, with a temporary
  `--user-data-dir` and `--remote-debugging-port=0`. The tool reads the port from `DevToolsActivePort`, attaches to one
  page, and sets the viewport to exactly W×H.
- `Page.addScriptToEvaluateOnNewDocument` injects `review-harness.js` (wrapped in a function, so its names stay out of
  the game's scope) and a small bridge (`window.HB`) before any of the page's scripts. The harness takes over
  `requestAnimationFrame`, so frames run only when pumped, each a fixed 1/60 s step: shots are deterministic, and the
  adaptive resolution never drops.
- A shot renders one frame and reads the canvas back as a PNG in the same task (`HB.grab()`). That's the game's frame
  at full resolution, without the DOM. `--page` uses `Page.captureScreenshot` instead.
- The first run on a machine spends ~15 s compiling the game's shaders for D3D11. The tool carries the compiled-shader
  caches from run to run in `%TEMP%\wb-headless-gpu-cache-<browser>`, so later runs load in ~2 s. It never carries
  the HTTP cache, so a rebuilt page always loads fresh.
- Typical times on this machine: 3–5 s per spectator shot once the browser is up, and about 5 s for a one-shot run
  with a warm shader cache (~20 s cold).

### Limits

- Spectator spots reload the page, because `?fly` reads its spot only at start. Glider spots can move without a
  reload (`R.view`).
- Timings are the headless browser's, not the user's display: `bench` has no vsync or compositor present, and wall
  time includes a 1-pixel read-back to sync the GPU. Use it to compare builds, not as absolute fps. Compare `gpuMs` and
  the wall `p50`. The wall mean and tail jump whenever anything else is using the GPU (another agent's run, the
  island generator in WSL).
- `performance.now()` is coarsened to 0.1 ms in the page. GPU pass times come from the timer queries, which are
  finer.

## The rest

- `review-harness.js`: the in-page frame driver (`R.ready`, `R.view`, `R.frame`, `R.pump`, `R.shot`, `R.pair`).
  `headless.py` injects it automatically. On its own, you import it into a muted test build right after the page loads
  (`await import('/tools/review-harness.js?v=' + Date.now())`). It takes over `requestAnimationFrame` so frames run
  when pumped (a hidden page draws nothing on its own), spawns views (`R.view(xkm, ykm, deg, agl)`), and saves
  full-resolution frames (`R.shot(name)`, `R.pair(name, …)` for photo materials on/off).
  **It never takes the user's mouse:** it refuses pointer lock at import (the game asks for it when flying starts) and
  releases any lock the page holds. `R.centre()` only dispatches a DOM event inside the page. Use it in headless
  browsers only, through `headless.py`.
- `shot_server.py`: receives the standalone harness's frames on 127.0.0.1:8791 and writes `shots/<name>.png`. Not
  needed with `headless.py`, which saves the frames itself.
- `sbs.py`: labelled before/after images from `shots/<name>_off.png` + `_on.png` (run in the WSL venv).
  `headless.py pair` makes its own.
- `range-bench.js`: the view-range bench (frames through `WB.step`, GPU pass timings; import it like the harness).
