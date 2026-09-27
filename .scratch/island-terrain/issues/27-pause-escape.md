# 27 — Esc in the pause menu should return to the game

**What to build:** Bug from the user: pressing Esc while the pause menu is open brings the pause menu back instead of
resuming. Esc should toggle: pause from flight, resume from pause, including with pointer lock and after Esc has
already released the pointer. Check the settings panel's Esc handling too, and spectator mode.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] From flight, Esc pauses; from the pause menu, Esc resumes flight with the mouse captured again
- [ ] Works repeatedly, in first-person and chase camera and in spectator mode; the settings panel still closes on Esc
- [ ] Verified in the test build
