# tools/

Review tooling for renders of the game (none of it ships).

- `review-harness.js` — import it into a muted test build right after the page loads
  (`await import('/tools/review-harness.js?v=' + Date.now())`). It takes over `requestAnimationFrame` so frames run
  when pumped (a hidden page draws nothing on its own), spawns views (`R.view(xkm, ykm, deg, agl)`), and saves
  full-resolution frames (`R.shot(name)`, `R.pair(name, …)` for photo materials on/off).
  **It never takes the user's mouse:** it refuses pointer lock at import (the game asks for it when flying starts) and
  releases any lock the page holds; `R.centre()` only dispatches a DOM event inside the page. Use it in headless
  browsers only — never drive the user's cursor or a visible window (the user's rule).
- `shot_server.py` — receives those frames on 127.0.0.1:8791 and writes `shots/<name>.png` (git-ignored).
- `sbs.py` — labelled before/after images from `shots/<name>_off.png` + `_on.png` (run in the WSL venv).
