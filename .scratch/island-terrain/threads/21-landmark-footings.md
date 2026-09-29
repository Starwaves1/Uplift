# 21-landmark-footings: where this agent was when paused (2026-09-27)

Full transcript: `C:\Users\garre\.claude\projects\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\subagents\agent-a28852eb0a8abbeac.jsonl`
Work folder: `C:\Users\garre\Documents\code\uplift\.claude\worktrees\agent-a28852eb0a8abbeac` (branch `worktree-agent-a28852eb0a8abbeac`)

## Original brief

You're a performance-minded engine engineer on Windborne, a single-HTML WebGL2 glider game (repo github.com/Starwaves1/Uplift; main checkout C:\Users\garre\Documents\code\uplift; you're in your own git worktree). Your task is ticket 21, "Landmark footings: stop re-sampling the terrain every frame": read `.scratch/island-terrain/issues/21-landmark-footings.md` and CLAUDE.md first.

## Context
- Ticket 16 (GPU terrain detail) adds gullies and ledges to `terrainH` in wind/core.js. Its agent measured +0.1 ms (alpine view) to +0.31 ms (a Nordic view with a village) of extra shadow time. With landmarks switched off, shadow time is identical to before, so the cost is entirely wind/models/landmarks.js re-evaluating `terrainH` for building footings, per vertex, in every shadow cascade, every frame.
- Ticket 16 is being merged into main right now. If `terrainDetail`/its new `terrainH` term isn't in main yet when you start, wait for it or work on the principle: the fix must hold whatever terrainH contains.
- Ticket 15 made heights 8192² with 16-bit storage. JS and GLSL `terrainH` agree within a few cm, so a CPU-baked footing height is exact enough.

## Mindset (the user's global instructions)
The most common failure mode is low-effort diagnosis and premature conclusions. Do the opposite. Read how landmarks.js builds, places and draws its buildings, including the shadow passes, before changing anything. Find the simplest fix: most likely bake footing heights once per landmark instance when it's placed and pass them as instance or vertex data, so the shaders stop calling terrainH. Keep the ground meeting every building with no gaps or floating.

## Build and verify
- Build the muted test build in your worktree with Git Bash: `sh build-wind.sh flora,fauna,glider,landmarks,windfx`.
  - NEVER play audio: open only test builds, never windborne.html.
  - Don't publish.
- Serve on port 8773: `py -m http.server 8773 --bind 127.0.0.1 --directory <worktree>` (other ports belong to other agents).
- In the built-in browser, ALWAYS create your own tab (tabs_create) and pass its tabId to every browser call; other agents share the pane, so never drive a tab you didn't create.
- Use spectator mode: `?fly&at=X,Y,HEADING,ALT` (km, km, compass degrees, metres above ground). Find a village or landmark view; ticket 16's agent saw the cost in a Nordic view near a village.
- Measure landmark and shadow frame time before and after, with the PROF marks in wind/main.js. Take one screenshot near a village, before and after, to show footings still sit right.
- Close your tab when done.
- Commit on your branch with messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge. Only touch landmarks.js (and a tiny hook elsewhere only if truly needed); don't edit .scratch/.

## Report back
- The cause.
- The fix.
- Before/after timings (views stated).
- Screenshot paths.
- Branch and commits.
- Any remaining issue.

## Latest messages to the agent (lead / Garrett feedback)

**2026-09-27 05:01**

Two things. (1) New rule: every agent's branch is flown and approved by Garrett (the user) before it merges to main. When you hand back, keep your worktree build served on 8773 and include a spectator link to a village view.
(2) After ticket 21, please continue on the same branch with urgent landmark bugs the user reported: "There are villages which are half underwater" and "The walls inside villages are placed nonsensically." That's ticket 12 (`.scratch/island-terrain/issues/12-rehome-landmarks.md`), which I'm unblocking now for exactly this.
- On today's island, no building or wall should stand in water or on steep ground.
- Walls should follow sensible lines: village perimeters, field boundaries, terraces, roads.
- Investigate how landmarks.js chooses sites first.
Report 21 and 12 together, with before/after screenshots and links. (Windmill improvements are a separate ticket, 22, for later; don't redesign them.)

**2026-09-27 05:23**

URGENT, hard rule from the user: "Stop grabbing my mouse!" Something is capturing the user's real mouse. Effective immediately:
- never click inside the game page (no "Take flight", no canvas clicks), since that triggers pointer lock, which captures the user's real cursor;
- never call requestPointerLock or dispatch clicks or keys into the canvas;
- never use any desktop automation tools (Windows-MCP Click/Move/Type/Shortcut/etc.).
Drive the game only through navigate plus javascript_tool (WB.step, FLIGHT, spectator `?fly&at=` URLs) and screenshots. If a tab of yours has pointer lock, call document.exitPointerLock() via javascript_tool now.

**2026-09-27 05:25**

New rule from the user: "If you want to use the computer, do it headlessly and don't take my actual cursor." Effective now:
- stop using the in-app browser pane tools (mcp__Claude_Browser__*) and all Windows-MCP desktop tools entirely;
- close any tabs you have open (tabs_close), one last time (tab-10 on 8773 may be yours).
A headless-Chrome review tool (ticket 33) is being built now. I'll send you its command when it lands; use it for all in-game screenshots and measurements. Until then, keep working on code.

**2026-09-27 05:58**

[Request interrupted by user for tool use]

## Latest reports from the agent

## Last 30 messages

**2026-09-27 05:01 · agent**

Now I have a clear picture of the cause. Let me implement the fix in landmarks.js.

**2026-09-27 05:01 · to agent**

Two things. (1) New rule: every agent's branch is flown and approved by Garrett (the user) before it merges to main. When you hand back, keep your worktree build served on 8773 and include a spectator link to a village view.
(2) After ticket 21, please continue on the same branch with urgent landmark bugs the user reported: "There are villages which are half underwater" and "The walls inside villages are placed nonsensically." That's ticket 12 (`.scratch/island-terrain/issues/12-rehome-landmarks.md`), which I'm unblocking now for exactly this.
- On today's island, no building or wall should stand in water or on steep ground.
- Walls should follow sensible lines: village perimeters, field boundaries, terraces, roads.
- Investigate how landmarks.js chooses sites first.
Report 21 and 12 together, with before/after screenshots and links. (Windmill improvements are a separate ticket, 22, for later; don't redesign them.)

**2026-09-27 05:01 · agent**

Now the build/kind functions.

**2026-09-27 05:02 · agent**

Now the footing texture creation (after the kinds), baking, and gathering.

**2026-09-27 05:10 · agent**

Identical to before. Now the A/B timing on the fixed t16 build.

**2026-09-27 05:23 · to agent**

URGENT, hard rule from the user: "Stop grabbing my mouse!" Something is capturing the user's real mouse. Effective immediately:
- never click inside the game page (no "Take flight", no canvas clicks), since that triggers pointer lock, which captures the user's real cursor;
- never call requestPointerLock or dispatch clicks or keys into the canvas;
- never use any desktop automation tools (Windows-MCP Click/Move/Type/Shortcut/etc.).
Drive the game only through navigate plus javascript_tool (WB.step, FLIGHT, spectator `?fly&at=` URLs) and screenshots. If a tab of yours has pointer lock, call document.exitPointerLock() via javascript_tool now.

**2026-09-27 05:25 · to agent**

New rule from the user: "If you want to use the computer, do it headlessly and don't take my actual cursor." Effective now:
- stop using the in-app browser pane tools (mcp__Claude_Browser__*) and all Windows-MCP desktop tools entirely;
- close any tabs you have open (tabs_close), one last time (tab-10 on 8773 may be yours).
A headless-Chrome review tool (ticket 33) is being built now. I'll send you its command when it lands; use it for all in-game screenshots and measurements. Until then, keep working on code.

**2026-09-27 05:35 · agent**

Now the ruins, circles, lighthouses and rocks.

**2026-09-27 05:38 · agent**

VS Code's bundled Node runs headlessly, so I can syntax-check and audit placement across the whole island without any browser. Let me write a Node audit harness.

**2026-09-27 05:58 · to agent**

[Request interrupted by user for tool use]

