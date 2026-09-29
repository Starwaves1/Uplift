# 12 — Landmarks and villages: on land, with sensible walls

**What to build:** The landmarks and villages from the old procedural world are placed by rules that don't fit the
island. The user reports "villages which are half underwater" and "the walls inside villages are placed
nonsensically". Fix placement on today's island now:
- no building, wall or tower in water, buried, floating, or on ground too steep for it;
- villages on suitable sites (gentle slopes, near water but above it, sheltered);
- walls following sensible lines: village perimeters, field and pasture boundaries, terraces, roads.

When the village sites (ticket 10) and the new village architecture (26) land, re-home them properly.

**Blocked by:** None — can start immediately (re-homing onto designed village sites comes with 10 and 26)

**Status:** claimed

- [ ] No landmark, building or wall is underwater, buried or floating anywhere on the island
- [ ] Villages sit on sensible sites; walls follow perimeters, fields, terraces or roads
- [ ] Reviewed in spectator mode at several villages by the user, with before/after screenshots

## Comments

- 2026-09-27, user: "There are villages which are half underwater" and "The walls inside villages are placed
  nonsensically." Picked up by the ticket-21 agent after the footing fix (same module).

- 2026-09-29, ticket-19 regression agent (houses in rivers; NOT applied, over the "handful" limit). At the village by
  lake 16 (`?fly&at=10.11,40.19,0,110`) the river leaving the lake runs through houses. Cause: `genVillage` in
  `wind/models/landmarks.js` never looks at rivers. `RIVERS` is built synchronously before `LANDMARKS`, and
  `RIVERS.wet(x, z, pad)` (what the plants use) is already available at placement time. Measured island-wide on branch
  `worktree-agent-aa9a1c41975ab1fca` @ 1ceda87 (109 villages, 485 landmark cells):
  - houses/mills whose footprint overlaps river **water**: 20 houses + 3 mills in 11 villages, many fully in the
    channel (up to 19 m inside). Counting the drawn bars and wet bank (+1 m) as well: 36 houses + 5 mills in 13 villages.
    Ruins, stone circles, lighthouses: none on rivers.
  - separately, **lakes** (lake mask, ground below lake level): 68 houses + 10 mills in 11 villages, most of them wholly
    drowned (e.g. village cells -1,6 at 31.3,40.9 and -1,7 at 31.0,42.6; also 3,3 / 4,1 / 6,-2 / 7,-3 / 8,-4 / 9,-9 /
    10,-8 / 10,-3 / -16,4), plus a lighthouse at 43.8,20.5. The site search takes flat lake beds as flat meadows. This is
    the "half underwater" report.
  - walls/fences touching river wet zones: 391 segments; lakes: 1363.
- Proposed change (tested, then reverted): `.scratch/island-terrain/threads/19-river-houses.patch` (applies to 1ceda87).
  A house or mill whose footprint samples are wet by `RIVERS.wet(x, z, 1, false)` (the new `lakes` flag = rivers only)
  becomes a ghost. It stays in the layout (it still takes its random draws and blocks walls) but isn't built, and its
  garden is laid into a scrap cell. After the village is laid out, ghosts are rebuilt from their own stream
  `rng(i, j, 113)` on free, dry lane slots (mills: a dry spot 55–115 m out), clear of the walls already placed. Result:
  472 of 485 cells are byte-identical. 13 villages change: 36 houses + 5 mills removed, 22 houses + 5 mills rebuilt,
  231 garden wall/fence segments dropped, 0 houses/mills on rivers after. Villages (cell at km: houses before→after):
  -16,5 at 10.24,40.09 (lake 16: 9→5), -16,12 at 10.41,49.74 (9→9), -15,-2 at 11.56,29.99 (8→5), -14,2 at 13.36,35.78
  (7→3), -12,1 at 15.74,34.52 (7→7), -11,1 at 17.35,34.37 (4→3), -9,1 at 19.77,33.73 (4→4), 4,1 at 38.25,33.90 (7→7),
  5,-6 at 39.58,23.91 (8→8), 6,-9 at 41.19,19.98 (10→9), 7,-5 at 42.69,25.31 (9→9), 8,9 at 43.50,45.23 (7→7),
  16,-15 at 55.34,11.92 (6→5). Where the lane runs along the river (lake 16, -14,2, -15,-2), few dry slots remain, so
  those villages shrink. Re-siting the whole village off the channel is the better fix there, and that belongs here.
  Before/after images (worktree `shots/`): `sbs_rfix_l16v.jpg`, `sbs_rfix_l16j.jpg`, `sbs_rfix_v1462.jpg` (-14,2),
  `sbs_rfix_v1512.jpg` (-12,1), `sbs_rfix_vn1.jpg` (lake village -1,6: unchanged). Audit scripts: `shots/rfix_audit.js`
  (per-cell fingerprints + wet landmarks), `shots/rfix_strict.js` (overlap with the water itself).
