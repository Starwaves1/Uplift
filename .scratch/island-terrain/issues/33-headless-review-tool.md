# 33 — Headless review tool: test the game without touching the user's screen

**What to build:** Agents test the game in the desktop app's browser pane, and some of that captured the user's real
mouse. The user: "If you want to use the computer, do it headlessly and don't take my actual cursor." Build a headless
review tool:
- it runs installed Chrome or Edge in headless mode, rendering WebGL on the GPU (ANGLE D3D11, not software);
- it loads a test build at a spectator spot (`?fly&at=…`), steps frames, runs JavaScript in the page, and saves
  full-resolution screenshots;
- it never shows a window, never takes the cursor, and never requests pointer lock;
- it needs no new downloads: Chrome and Edge are installed, Python is available, Node and Playwright are not. Use the
  DevTools protocol through Python's standard library, a minimal WebSocket client, or .NET's ClientWebSocket from
  PowerShell.

Make it the one way agents take in-game screenshots and measurements.

**Blocked by:** None — can start immediately. Urgent: all visual testing waits on it.

**Status:** claimed

- [ ] One command takes a URL (build, island, `?fly&at=` spot) plus optional JS steps and writes screenshots at 1920×1080, headless, with GPU WebGL (renderer string verified; not SwiftShader)
- [ ] Can evaluate JavaScript and return results (e.g. WB.step, FLIGHT state, PROF timings) for tests and frame-time measurements
- [ ] Never opens a visible window, never moves or captures the user's cursor, blocks pointer lock in the page
- [ ] Documented in tools/ with examples (before/after pairs, a frame-time benchmark); the existing review harness works inside it
- [ ] Verified by producing the same view headless as the old harness did, with matching look

## Comments

- 2026-09-27: after "Stop grabbing my mouse!", every agent was told: no clicks in the game, no pointer lock, no desktop
  automation tools. The materials session patched tools/review-harness.js to block requestPointerLock.
