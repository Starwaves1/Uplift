# 11 — Photoreal ground materials

**What to build:** Replace today's procedural colour bands, which look cartoonish on the island, with photoscanned
ground materials. The sets are:
- rock faces and aerial rock;
- sandstone for the plateau;
- scree and gravel;
- meadow and grass;
- forest floor;
- Mediterranean soils;
- beach sand and coastal rock;
- snow.

Each is packed into texture arrays shipped with the game. They are blended by the island's data maps (flow, sediment,
scree, cliff) and regions, and by slope and altitude. They are drawn with triplanar mapping on steep ground and with
macro variation, so nothing tiles visibly from any height.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [x] The user approved downloading the 18 CC0 Poly Haven sets at 4K (about 742 MB of sources): aerial_rocks_02, aerial_rocks_04, rocky_terrain_02, rock_face_03, rock_06, sandstone_cracks, rocks_ground_02, gravelly_sand, aerial_grass_rock, leafy_grass, aerial_ground_rock, forest_leaves_02, brown_mud_dry, red_laterite_soil_stones, aerial_beach_01, coast_sand_rocks_02, snow_field_aerial, snow_02
- [ ] Sources are processed on the GPU into shipped texture arrays (colour, normal, roughness/AO/height) of about 25–35 MB total
- [ ] Cliffs and steep faces use triplanar rock with no stretching; flats use the maps' material choice with soft, natural transitions
- [ ] No visible tiling from 50 m to 3 km above the ground (macro variation, detail blending by distance)
- [ ] Each region reads distinctly: grey granite in the Nordic north-west, pale limestone and red soils in the Mediterranean south, dark volcanic ground on the volcano
- [ ] Frame rate stays within the project's high mode budget (120 fps target on a desktop GPU)
- [ ] Reviewed in the game side by side with the old look, with screenshots

## Comments

- The user OK'd the texture download at 4K on 2026-09-26.
- First pass landed in 28c5ff3 (by the materials session). It is High mode only and costs about 0.1 ms, with
  triplanar mapping on steep faces and anti-tiling. Each region has its own mix of photo layers:
  - Nordic: heath and granite slabs;
  - Alpine: grass;
  - Mediterranean: garrigue with scrub;
  - the plateau: karst;
  - the volcano: grass grading to ash.
  Still open:
  - trees are stylised against photoreal ground;
  - lake and sea-floor blotches (ticket 06);
  - a performance check on a heavy view;
  - side-by-side screenshots.
  For A/B in the test build: photo materials appear on High about 2 s after start; `TERRAIN.materials = false` in the
  console switches back to the procedural look.
