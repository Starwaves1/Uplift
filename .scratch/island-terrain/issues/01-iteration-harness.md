# 01 — Iteration harness: camera bookmarks and design previews

**What to build:** A fast look-critique-tweak loop for every terrain feature. The muted test build can be opened
straight at any place on the island from its URL (design-grid km position, heading, altitude), so a feature can be
checked in the game in seconds. On the generator side, any region can be rendered as a gridded design map (km grid,
contours) and as oblique views, heights can be probed along a designed line, and a single designed pass can be applied
to the finished island without re-running the whole pipeline.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Opening the test build with a bookmark in the URL starts the glider at that km position, heading and altitude above ground; without one, the normal start is unchanged
- [x] Bookmarks for the key spots are listed in the spec so reviews are repeatable (fjord bookmarks wait for ticket 02)
- [x] A gridded design map and oblique views can be rendered for any km rectangle of any saved island
- [x] Heights (at a point, and min/median/max around it) can be printed along any designed polyline
- [x] One designed pass can be tried on a finished island and previewed in under a minute

## Comments

- The gridded design map and the height probe already exist as generator scripts (used to lay out the fjords); the
  camera bookmark in the game does not exist yet.

## Answer

Done 2026-09-26.
- `?at=X,Y[,HEADING[,ALT]]` works in the test build and was verified at eight spots against the spawn values. A crash
  respawns at the bookmark, cutting straight to it rather than sweeping the camera across the map. Malformed values
  print a warning and fall back to the normal start.
- The Bookmarks table is in the spec.
- Generator side:
  - the gridded design map and the height probe;
  - a script that renders the standard previews (top-down plus region and fjord obliques) of any saved island;
  - a template for trying one pass on a finished island, from the fjord experiments.
- Known quirks: with no heading given, the start faces the highest nearby ground; ALT over a lake counts from the lake
  bed.
