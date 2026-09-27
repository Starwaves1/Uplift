# 16 — Terrain detail below the stored grid, synthesised on the GPU

**What to build:** Close up, the terrain should look 10× sharper than today: 1.5 m or finer near the camera, sharper
still where the camera is very close. The stored heights (ticket 15) stop at ~7.8 m; below that, the game synthesises
detail. It replaces today's ±1 m value-noise micro-relief, and it is driven by the generator's own maps so that it
follows the geology:
- rock steps and ledges along the bedding;
- gullies and rills aligned with the water's flow direction;
- scree texture below cliffs;
- soft soil on flats;
- boulders and knobs on scoured granite.

It is deterministic, and the same function runs in JS, for collision, and in GLSL, for rendering. Each LOD fades it
out by its own spacing, so nothing shimmers.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Near the camera the ground has believable relief at 1–10 m scales: no blobby Catmull-Rom smoothness, no obvious noise pattern
- [ ] Detail depends on terrain type, slope and flow direction: gullies run downhill, ledges follow the bedding, flats stay calm
- [ ] JS and GLSL heights match within a few centimetres (the glider collides with what is drawn)
- [ ] No shimmering or popping between LOD rings; the cost is measured on the RX 7900 XT at 1080p
- [ ] Reviewed in spectator mode low over several regions (Nordic, Alpine, Mediterranean, volcano), before and after, with screenshots shown to the user

## Comments

- 2026-09-26: together with ticket 15, this gives the user's requested 10× resolution within the artifact budget.
  Techniques to consider: erosion-style filters that add gullies along the gradient (well-known shader approaches),
  bedding-aligned terracing by rock type, and displacement from the photo materials' own height maps at the finest
  scale. Coordinate with the materials session (terrain shading) and ticket 14 (LOD ranges); the height functions
  live in the core module.
