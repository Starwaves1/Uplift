# Island terrain — spec

The glider game flies over one big hand-designed fantasy island (64 × 64 km). The terrain must look real — "like you
would mistake it for real life" — while being built for fun: grounded, with many fantasy moments of wonder.

## Design intent (from the user)

- High quality mode only; the medium mode is derived later.
- Medium density; exploration, not rings.
- Three regional styles: **Nordic** (north-west: fjords, granite fell, rock faces), **Alpine** (centre: two ranges and
  the great valley between them), **Mediterranean** (south: limestone hills, cliffs and coves, a sheltered bay; the
  plateau and gorge country in the south-east). Plus the **volcano** (north-east, with its caldera and the lake it dams).
- Must-haves: a great valley; very interesting coastlines with rock faces; sites for medium-large villages with tall
  buildings to fly between; some ruins; things to fly around and through (arches, loops, pillars). Built assets
  (villages, windmills, ruins, arches) come later — this effort is the landform and the ground it sits on.
- Shipping texture files is fine; the user's GPU (ROCm) may be used to make high-quality assets.

## How every ticket is done

- Iterate with care: look, critique, tweak, repeat — never one-shot. Judge each feature in design previews *and* in the
  game, from the air, at the heights a glider flies (100–800 m above ground).
- The generator is the source of truth: a feature lands as a pass in the island pipeline, the island is re-exported,
  and the result is flown in the local muted test build (never play audio on the user's PC).
- Keep the island's JS and GLSL height functions identical, so the ground you collide with is the ground you see.
- Coordinates in tickets are km on the design grid: x east, y south, origin at the island's north-west corner.

## Ground material map (island_ground.bin) — contract

Owned by ticket 31 (export and loader); bedrock ids come from ticket 17; the materials session drives the photo layers
from it.
- **File:** its own file, loaded optionally (absent means today's look). Header 'WBGR', u32 version = 1, u32 n, then
  zlib of n×n RGBA8, row-major, north-west origin, same extent as the heights, n = 4096.
- **R, bedrock type (nearest):**
  - 0 none/sea
  - 1 granite/gneiss (crystalline basement)
  - 2 schist/metamorphic
  - 3 limestone, hard
  - 4 marl/shale, soft
  - 5 sandstone
  - 6 basalt/andesite lava
  - 7 tuff/ash
  - 8+ reserved
- **G, bedrock exposure:** 0..1.
- **B, soil/regolith depth:** depth_m = 8·(B/255)².
- **A, sediment type (nearest):**
  - 0 none
  - 1 clay/silt
  - 2 sand
  - 3 gravel/shingle
  - 4 boulders/scree/colluvium
  - 5 volcanic ash/pumice/cinder
  - 6 glacial till/moraine
  - 7 alluvial loam
  - 8+ reserved
- **GLSL_COMMON:** all helpers use texelFetch, so no filtering touches the indices.
  - `float islandGroundOn()`: 1 when the file loaded.
  - `vec4 islandGround(vec2 q)`: the texel containing q, decoded as x = rock type as float, y = exposure 0..1,
    z = depth in metres, w = sediment index as float.
  - `void islandGroundTexels(vec2 q, out vec4 g00, out vec4 g10, out vec4 g01, out vec4 g11, out vec2 f)`: the 4
    surrounding texels decoded the same way, plus the bilinear fraction.
- **JS:** `islandGround(x, z)` returns {bedrock, exposure, depth, sediment}.
- **Later (v2):** a wetness/drainage-saturation channel for bogs, seeps and wet meadows.

## Bookmarks

Open the muted test build at a place with `?at=X,Y,HEADING,ALT` — km on the design grid, compass degrees (0 north,
90 east), metres above ground; HEADING and ALT are optional (auto direction, 130 m). A crash respawns at the bookmark.
Append `&v=N` to beat the cache after a rebuild.

Page: `http://127.0.0.1:8765/windborne-test-flora,fauna,glider,landmarks,windfx.html` + suffix:

| Spot | Suffix |
|---|---|
| Great valley start (the default start) | `?at=12.5,35.3,77,130` |
| Nordic west coast, from the sea | `?at=9.0,16.4,120,250` |
| Nordic north coast, from the sea | `?at=15.0,11.4,178,250` |
| Nordic east inlet, from the sea | `?at=28.8,11.4,195,250` |
| Volcano lake (south shore, looking north over it) | `?at=46.0,31.0,0,300` |
| South coast | `?at=27.0,53.5,270,200` |
| South-east plateau | `?at=48.0,40.0,340,300` |

Add bookmarks for each fjord mouth and head once ticket 02 generates them. If HEADING is left out, the start faces the
highest ground within 1.6 km (the old procedural rule), so give a heading. ALT is measured from the ground or the sea
surface; over a lake it counts from the lake bed.
