# Windborne ("Updraft")

A single-HTML WebGL2 glider game over a big hand-designed fantasy island. Source: https://github.com/Starwaves1/Uplift
(public; `origin`, branch `main` — pull before pushing, another session may commit too). Published as the claude.ai artifact
https://claude.ai/artifact/JvmmvMKGQd3AMUdpqtUDHE — publish `windborne.html` with that `url` so it updates the same
artifact (it was first published from another folder, so publishing without the url would create a new one).

- `wind/` — the game's modules (core, terrain, water, clouds, world, flight, …); `build-wind.sh` concatenates them into
  `windborne.html` (and muted `windborne-test-*.html` builds). Serve the folder locally to play
  (`.claude/launch.json`: a static server on 127.0.0.1:8765): the page fetches `island.bin` and `island_maps.bin`
  from next to itself.
- `island/` — the island generator (Python: numba + torch on a ROCm GPU, run inside WSL through `island/run.sh`;
  first-time env setup: `island/setup-wsl.sh`). `gen_island.py` (landscape evolution) → `finalize.py` (designed
  passes: valley, fjords, caldera, coast, droplet erosion, lakes, data maps) → `export.py` (writes `island.bin` +
  `island_maps.bin`). Intermediate grids go to `island/work/` (git-ignored, reproducible); design previews to
  `island/preview/`. From Windows, call WSL via PowerShell (Git Bash mangles `/root/...` paths).
- Test builds must stay muted (`window.WB_MUTE`): never play audio on the user's PC.

## Rule: Garrett approves every merge to main

Every subagent's work is reviewed by Garrett (the user) before it is merged to main: he flies the branch's own
playable build (its worktree served on its own port, with `?fly&at=…` spectator links to the key spots), gives
feedback to that agent, and approves. No merge to main without his explicit approval of that branch. Agents keep their
preview server running after handing back, and expect review rounds.

## Investigate before concluding

The most common failure mode of Opus 5.5 is low-effort diagnosis and premature conclusions. Do the opposite. Launch
full investigations of bugs to understand the most efficient and simple way to solve a problem in a codebase. The first
thing you think to do is often not the simplest and best way to do it.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
