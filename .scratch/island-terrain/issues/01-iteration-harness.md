# 01 — Iteration harness: camera bookmarks and design previews

**What to build:** A fast look-critique-tweak loop for every terrain feature. The muted test build can be opened
straight at any place on the island from its URL (design-grid km position, heading, altitude), so a feature can be
checked in the game in seconds. On the generator side, any region can be rendered as a gridded design map (km grid,
contours) and as oblique views, heights can be probed along a designed line, and a single designed pass can be applied
to the finished island without re-running the whole pipeline.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Opening the test build with a bookmark in the URL starts the glider at that km position, heading and altitude above ground; without one, the normal start is unchanged
- [ ] Bookmarks for the key spots (valley start, each fjord mouth, the volcano lake, the south coast, the plateau) are listed in the spec or a README so reviews are repeatable
- [ ] A gridded design map and oblique views can be rendered for any km rectangle of any saved island
- [ ] Heights (at a point, and min/median/max around it) can be printed along any designed polyline
- [ ] One designed pass can be tried on a finished island and previewed in under a minute

## Comments

- The gridded design map and the height probe already exist as generator scripts (used to lay out the fjords); the
  camera bookmark in the game does not exist yet.
