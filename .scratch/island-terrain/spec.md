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
