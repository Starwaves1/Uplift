# 33-headless-tool: where this agent was when paused (2026-09-27)

Full transcript: `C:\Users\garre\.claude\projects\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\subagents\agent-a894e21c8ed7cdb12.jsonl`
Work folder: `C:\Users\garre\Documents\code\uplift\.claude\worktrees\agent-a894e21c8ed7cdb12` (branch `worktree-agent-a894e21c8ed7cdb12`)

## Original brief

You're a tools engineer on Windborne, a single-HTML WebGL2 glider game (repo github.com/Starwaves1/Uplift; main checkout C:\Users\garre\Documents\code\uplift; you're in your own git worktree). URGENT ticket 33, "Headless review tool": read `.scratch/island-terrain/issues/33-headless-review-tool.md` and CLAUDE.md first.

## Why
Agents testing the game in the desktop app's browser pane captured the user's real mouse cursor (pointer lock from clicks in the game canvas, and possibly desktop automation tools). The user: "If you want to use the computer, do it headlessly and don't take my actual cursor."

## ABSOLUTE RULES for you
- Do NOT use the in-app browser pane tools (mcp__Claude_Browser__*) or ANY Windows-MCP desktop tool (Click, Move, Type, Shortcut, Scroll, App, etc.).
- Do NOT launch a visible browser window. Everything you launch must be headless and must never take focus or the cursor.
- NEVER play audio: only load muted test builds (`windborne-test-*.html`, which set window.WB_MUTE), never windborne.html. Also pass `--mute-audio` to Chrome.

## What exists
- Installed: Chrome (C:\Program Files\Google\Chrome\Application\chrome.exe), Edge, and Python via the `py` launcher (Windows).
- Not installed: Node and Playwright. Don't download anything; use what's there.
- The game's test build is served by a static server on http://127.0.0.1:8765 (main checkout).
- Spectator mode: `?fly&at=X,Y,HEADING,ALT` (design-grid km, compass degrees, metres above ground); `&island=NAME` loads islands/NAME/.
- Debug hook in the page: `window.WB.step(n, dt)` advances frames; `FLIGHT`, `TERRAIN`, `WB.PROF` are globals.
- There's a review harness in tools/: `review-harness.js` (R.ready, R.pair, which POSTs frames to `tools/shot_server.py` on 127.0.0.1:8791). The materials session just patched main's copy to block requestPointerLock; that change may not be in your worktree yet, so apply the same idea.

## What to build
- A command-line tool, e.g. `py tools/headless.py`, that:
  - launches Chrome headless (`--headless=new`), with GPU WebGL through ANGLE D3D11 (flags like `--use-angle=d3d11`, `--enable-gpu`, `--ignore-gpu-blocklist`; find what actually works), `--mute-audio`, a 1920×1080 window size, and a temporary `--user-data-dir`;
  - drives it over the DevTools protocol, using a minimal WebSocket client written with Python's standard library (socket, base64, hashlib) or another zero-download route;
  - navigates to a URL, waits for the island to load, injects a pointer-lock block before the game scripts run (Page.addScriptToEvaluateOnNewDocument), runs JS steps (e.g. WB.step), evaluates expressions and returns JSON, and captures screenshots (Page.captureScreenshot) to files;
  - supports a batch of shots in one run (a list of spots) and before/after pairs across two URLs, stitched side by side with PIL if available, else separate files;
  - can run a simple frame-time benchmark (PROF timings over N frames);
  - always kills its Chrome process at the end.
- **Verify:**
  - the WebGL renderer string shows the AMD GPU / D3D11, not SwiftShader;
  - screenshots match what the game shows (compare one view with an existing shot in the main checkout's shots/ folder);
  - no window ever appears (e.g. confirm the Chrome process is headless and has no visible main window, via PowerShell Get-Process MainWindowTitle).
- **Document it** in `tools/README.md` with exact example commands for agents.
- Commit on your branch with messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge; the lead handles merging after review.

## Report back
- The exact commands.
- Proof of GPU rendering (the renderer string).
- A sample screenshot path.
- Timing per shot.
- Branch and commit.
- Limitations.
Be fast: every other agent's visual testing is waiting on this.

## Latest messages to the agent (lead / Garrett feedback)

**2026-09-27 05:26**

Prior art that may save you time: the ticket-20 agent already ran its tests in a private headless Edge driven over CDP (port 9337, its own profile, muted), and it worked with GPU WebGL on this machine. Its tools are in the lead's scratchpad folder: C:\Users\garre\AppData\Local\Temp\claude\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\scratchpad\t20\ (and its harness copy is main checkout shots/rh20.js, which no longer clicks "Take flight"). Reuse what's good, but deliver a clean, documented tools/headless.py as specified. Also make the default port configurable and avoid 8765–8791, which are in use.

## Latest reports from the agent

**2026-09-27 05:54 · agent → lead**

## Ticket 33: headless review tool is built and verified

`tools/headless.py` runs your installed Chrome headless, with WebGL on the RX 7900 XT, and kills the browser at the end. It needs no downloads. It's committed on branch `worktree-agent-a894e21c8ed7cdb12`, commit `a92fcf2`. Not pushed or merged.

**What it does:**
- **Launch:** `--headless=new --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --force_high_performance_gpu --disable-software-rasterizer --mute-audio --window-size=W,H`, with a fresh temporary profile each run.
- **Port:** the DevTools port is picked by the browser (it reads `DevToolsActivePort`), so it never collides with 8765–8791. `--port N` sets a fixed one.
- **Protocol:** the DevTools protocol runs over a small standard-library WebSocket client.
- **Cleanup:** the browser starts hidden and suspended, then joins a kill-on-close job object. It dies with the tool even if the tool is hard-killed; the only leftover is a stale temp profile, which later runs delete after 6 h.
- **Before any game script runs:**
  - pointer lock, fullscreen and keyboard lock are refused;
  - `WB_MUTE` is forced on;
  - `tools/review-harness.js` is injected, so frames are fixed 1/60 s steps.
- **Shots:** each shot reads the canvas back at full resolution; `--page` captures the whole page with the title/HUD instead.
- **Speed:** compiled shaders are cached between runs, so the game starts in ~1–2 s instead of ~20 s. The HTTP cache is never kept, so a rebuilt page always loads fresh.
- **Guards:** it refuses to load `windborne.html`, and stops if the renderer turns out to be SwiftShader or another software renderer.

## Exact commands

Run these from the repo root. `--url` takes a URL or a path; a path is served from the checkout on a private port, so agents can test their own worktree's build without a server.
```
py tools/headless.py info
py tools/headless.py shot --at 29,43.5,215,450 --name south
py tools/headless.py shot --at south=29,43.5,215,450 --at alpine=27.5,22,225,550 --name k14
py tools/headless.py shot --spots my_spots.txt --name k14        (lines: NAME X,Y,HDG,ALT or NAME X Y HDG ALT)
py tools/headless.py shot --island fjord1 --at 15.6,12.4,168,250 --settings "{\"tod\":\"dusk\"}" --name fj_dusk
py tools/headless.py pair --at 27.5,22,225,550 --name mat --b-js "TERRAIN.materials = false" --labels "materials on" "materials off"
py tools/headless.py pair --at 15.6,12.4,168,250 --name fjord --island fjord1 --b-island fjord2
py tools/headless.py pair --at 29,43.5,215,450 --name build --url windborne-test.html --b-url http://127.0.0.1:8765/windborne-test.html
py tools/headless.py run --at 29,43.5,215,450 --js "WB.PROF.on = true" --expr "WB.PROF.report()" --expr "WB.settings"
py tools/headless.py run --glider --island fjord1 --at 17.2,16.6,158,300 --settle 0 --js "await R.pair('fj_mid', 17.2, 16.6, 158, 300)"
py tools/headless.py bench --at 27.5,22,225,550 --frames 300
```
- **Common options:** `--url`, `--root`, `--glider`, `--settle N` (default 150 frames), `--size`, `--out` (default `shots/`), `--browser edge`, `--port N`, `--console`, `--page`, `--no-materials`.
- **Pairs:** save `<name>_a.png`, `<name>_b.png` and `sbs_<name>.jpg`.
- **Old harness:** `R.shot` and `R.pair` work unchanged inside `run`, and their frames land in `--out`.
- **Why `run`:** the JS subcommand was going to be called `eval`, but the worktree command guard blocks any command containing that word.

## Proof of GPU rendering

The renderer string, both on a blank page and in the game: `ANGLE (AMD, AMD Radeon RX 7900 XT (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)`. GPU timer queries are available, and Chrome reports `webgl: enabled` and `gpu_compositing: enabled`. Edge gives the same renderer string.

## Sample screenshots and the comparison

- **Sample shot:** `C:\Users\garre\AppData\Local\Temp\claude\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\scratchpad\hl\final\final_south.png` (1920×1080). Also `hl\alpine.png` and `hl\sbs_hl_mat.jpg` (a materials on/off pair).
- **Match with an old shot:** I reproduced `shots/fj1_N_mouth.png` headless: island fjord1, glider mode, 1904×985, the same `R.view` and `R.pump`.
  - Mean absolute difference is 2.8/255, and the mean colour matches to 0.01.
  - Side by side in `scratchpad\hl\cmp_fj1.jpg`: same look; only the clouds and particles drift slightly.

## No window, no cursor

- **Windows:** I polled the browser's processes (up to 22 at once) through several batch runs. Get-Process showed no `MainWindowHandle` or `MainWindowTitle`, EnumWindows found no visible windows, and the foreground window was never the browser's.
- **Cleanup:** after every run, including error exits and hard-killing the tool mid-run, no browser processes were left. The hard-killed run left one temp profile, which I deleted.
- **Pointer lock:** in glider mode after "Take flight", `document.pointerLockElement === null`.

## Timing per shot

| Case | Time |
| --- | --- |
| Spectator shot inside a batch (warm cache) | 3.2–4.8 s (page load 1.2–2.3 s + 150 settle frames + PNG read-back) |
| One-shot run, end to end (warm) | ~5–6 s |
| First shot on a cold cache | ~23 s (D3D11 shader compile) |
| Pair | 7–9 s |
| Bench, 300 frames | ~8 s |

At the alpine spot, bench gave about 5.0–5.2 ms of GPU passes (terrain ~2.1 ms, water ~0.9 ms), wall p50 8.2–8.8 ms and CPU p50 ~2 ms.

## Limitations

- **Stale default build:** in the main checkout, `windborne-test.html` has no photo materials. The only current test build there is `windborne-test-flora,fauna,glider,landmarks,windfx.html`; pass it with `--url` or rebuild first. The README says so.
- **Spectator batches reload:** `?fly` reads its spot only at startup, so each spectator spot reloads the page (~2 s warm). Glider spots can move without a reload (`R.view`).
- **Benchmark numbers:** they come from the headless browser, with no vsync or present. The wall mean and tail jump whenever something else uses the GPU, so compare `gpuMs

## Last 30 messages

**2026-09-27 05:26 · to agent**

Prior art that may save you time: the ticket-20 agent already ran its tests in a private headless Edge driven over CDP (port 9337, its own profile, muted), and it worked with GPU WebGL on this machine. Its tools are in the lead's scratchpad folder: C:\Users\garre\AppData\Local\Temp\claude\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\scratchpad\t20\ (and its harness copy is main checkout shots/rh20.js, which no longer clicks "Take flight"). Reuse what's good, but deliver a clean, documented tools/headless.py as specified. Also make the default port configurable and avoid 8765–8791, which are in use.

**2026-09-27 05:31 · agent**

Now add `R.frame` (synchronous one-frame render) to the harness so the headless tool can read the canvas back in the same task.

**2026-09-27 05:34 · agent**

Now update `call` and `goto` to use per-recv timeouts.

**2026-09-27 05:39 · agent**

Now run a batch spectator shot (3 spots) in the background while the window checker polls.

**2026-09-27 05:40 · agent**

Structure is fine. Rerun the batch with the window checker.

**2026-09-27 05:52 · agent**

Final regression across all commands after the edits.

**2026-09-27 05:54 · agent → lead**

## Ticket 33: headless review tool is built and verified

`tools/headless.py` runs your installed Chrome headless, with WebGL on the RX 7900 XT, and kills the browser at the end. It needs no downloads. It's committed on branch `worktree-agent-a894e21c8ed7cdb12`, commit `a92fcf2`. Not pushed or merged.

**What it does:**
- **Launch:** `--headless=new --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --force_high_performance_gpu --disable-software-rasterizer --mute-audio --window-size=W,H`, with a fresh temporary profile each run.
- **Port:** the DevTools port is picked by the browser (it reads `DevToolsActivePort`), so it never collides with 8765–8791. `--port N` sets a fixed one.
- **Protocol:** the DevTools protocol runs over a small standard-library WebSocket client.
- **Cleanup:** the browser starts hidden and suspended, then joins a kill-on-close job object. It dies with the tool even if the tool is hard-killed; the only leftover is a stale temp profile, which later runs delete after 6 h.
- **Before any game script runs:**
  - pointer lock, fullscreen and keyboard lock are refused;
  - `WB_MUTE` is forced on;
  - `tools/review-harness.js` is injected, so frames are fixed 1/60 s steps.
- **Shots:** each shot reads the canvas back at full resolution; `--page` captures the whole page with the title/HUD instead.
- **Speed:** compiled shaders are cached between runs, so the game starts in ~1–2 s instead of ~20 s. The HTTP cache is never kept, so a rebuilt page always loads fresh.
- **Guards:** it refuses to load `windborne.html`, and stops if the renderer turns out to be SwiftShader or another software renderer.

## Exact commands

Run these from the repo root. `--url` takes a URL or a path; a path is served from the checkout on a private port, so agents can test their own worktree's build without a server.
```
py tools/headless.py info
py tools/headless.py shot --at 29,43.5,215,450 --name south
py tools/headless.py shot --at south=29,43.5,215,450 --at alpine=27.

**2026-09-27 05:54 · agent**

I've handed the full report to the lead.

