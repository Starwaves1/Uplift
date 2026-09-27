# 17 — Rock structure in the generator

**What to build:** Real landscapes look real largely because their rock has structure; ours has none, so slopes and
cliffs smooth into blobs. Give the landscape model per-region geology:
- the Mediterranean limestone and the plateau: flat-lying beds of hard and soft rock, so slopes break into ledges and
  walls at consistent levels;
- the Nordic granite: joints and exfoliation slabs, so it weathers into knobs, slabs and blocky cliffs;
- the Alpine ranges: steeply dipping schists and gneiss, with fault-guided valleys;
- the volcano: stacked lava flows and ash, so the cone shows layered cliffs where it is cut.

Erosion then carves these structures naturally. This is not a pass painted on afterwards: rock strength and critical
slope vary in 3D inside the model. The rock type is exported as a map, so ticket 16's GPU detail and the materials can
follow it.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Rock strength varies with depth (bedding) and direction (joints, faults) inside the landscape model, per region
- [ ] Cut slopes show the structure: consistent ledge levels in the limestone, blocky granite, layered lava; no invented stair patterns
- [ ] A rock-type map is exported for the game (materials, GPU detail)
- [ ] Before/after previews of each region, and an in-game spectator review, shown to the user

## Comments

- 2026-09-26: part of the procedural overhaul the user chose ("procedural, much better") after rejecting hand-drawn
  landforms. The plateau (03) and the coast (05) build on this.
