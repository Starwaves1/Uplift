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
