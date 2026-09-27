# 20 — Baked terrain light: ambient occlusion and sky visibility

**What to build:** Much of why real terrain reads as real is how light falls into it: valley floors and gullies are
darker because they see less sky, crests are bright, cliffs shade their own feet. Bake that from the heightfield on the
GPU:
- for every point, horizon angles in many directions (reaching kilometres, so whole valleys darken, not just small
  hollows);
- from those, sky visibility or ambient occlusion, and perhaps a bent normal;
- shipped as a compact map.

The game uses it for the sky and ambient light on the terrain, and possibly on vegetation too: a tree in a deep valley
is lit less than one on a ridge.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] A GPU bake in the generator computes multi-direction horizon occlusion over the island, including large-scale valleys, in reasonable time
- [ ] The map ships compactly (its own file, so it doesn't collide with other export changes) and loads in the game
- [ ] A shader helper gives occlusion for any world position; the materials session wires it into the terrain lighting (coordinated through the lead)
- [ ] Valleys, gullies and cliff feet read with believable depth and soft shading; no halos or blocky artefacts
- [ ] Before/after screenshots from spectator mode shown to the user, with the load-size and frame-time cost
