# 36 — Rock walls and benches read as regular terraces in the game's shading

**What to build:** Ticket 17's rock structure gives the island real limestone walls, benches and mesas (hundreds of
metres of near-vertical rock). The terrain shader was tuned for slopes, not walls this big, and three things in it make
the new cliffs read as regular stripes and terraces even where the heights don't:
- **Snow on every bench.** Above the snow line, every flat bench gets snow and every wall between gets none
  (`wind/terrain.js` ~287–297: `lies = smoothstep(0.42, 0.26, slope)`), so a banded massif turns into evenly spaced
  white stripes. Real ledges hold snow unevenly: by aspect, wind, bench width, and cornices and spindrift.
- **Wall-texture tiling.** Walls use upright-projected photo scans repeating every 7–17 m (`terrain.js` ~396–404,
  `matTri(... 14.0 : 7.0 ...)`, second scan at 11/17 m). On a 300 m wall the repeat reads as a regular pattern.
- **Height-only sandstone bands.** The procedural colour path (Medium/Low quality, and before the scans load) paints
  sandstone bedding by world height alone (`terrain.js` ~279 and ~478–482). It's perfectly level and unbroken across the
  dry south. High quality discards that colour (`mats` path, ~518).

The generator already exports what the shader needs to follow the real rock: the rock map in `island_maps.bin`
(bedrock type ids, hardness, fracture intensity, cover depth; format in `island/export.py`) and the bed planes
`rockab` (s = a + b·z per column). Colour and texture could follow the actual beds instead of world height or a tile
grid.

**Blocked by:** 17 (rock structure) for the rock map to be on main; test on `islands/rock2`/`rock3` meanwhile.

**Status:** ready-for-agent

- [ ] Snow on benches varies with aspect, bench width and exposure; a banded massif no longer shows evenly spaced
      white stripes (compare in-game with the headless tool, ticket 33, at the spots below)
- [ ] Big walls show no visible texture repeat from 0.3–3 km away
- [ ] Medium/Low bedding follows the exported beds (or is removed), not world height
- [ ] Frame-time cost measured; flown and approved by the user

## Comments

- 2026-09-27: split out of ticket 17's review (adversarial checks of its round-2 checkpoint). Spots on `islands/rock2`:
  southern Mediterranean massif `29,43.5,215,450`; plateau `51,31.5,205,600`. Headless shots before/after:
  `shots/k22/sbs_south.jpg`, `sbs_plateau.jpg`. Use the full test build
  (`windborne-test-flora,fauna,glider,landmarks,windfx.html`): the plain `windborne-test.html` on 8765 ignores `?fly`
  and `?island`.
