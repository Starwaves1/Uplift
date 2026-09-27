# 06 — Sea floor

**What to build:** A believable sea floor, since from a glider you see it through the water everywhere near the
coast. Today it is blotchy, like random reefs, and too shallow offshore. Replace that with a smooth shelf that deepens
steadily away from the land into deep blue water. There should be bright turquoise sandy shallows at the Mediterranean
beaches, darker rocky ground under the cliffs, and deep fjord basins left deep.

**Blocked by:** 02 — Glacial fjords from the landscape model; 05 — Coastline pass

**Status:** ready-for-agent

- [ ] No blotchy patches: the floor noise is broad and gentle, with no speckle visible from 300 m up
- [ ] The shelf is narrower under the cliffs and wider off the beaches; the open sea is clearly deep within a few km
- [ ] The Mediterranean beaches have turquoise shallows; the Nordic coast drops off quickly and reads dark
- [ ] Fjord basins keep the depth the glaciers carved, and their mouths blend into the shelf with no stripe
- [ ] Reviewed in the game along both coasts and over a fjord mouth, with screenshots

## Comments

- Known cause of stripes: depth is taken from distance to land, and that distance peaks along the middle of every gap
  in the coast, so each bay or fjord mouth throws a deeper channel out to sea. Flatten those ridges, e.g. take the
  minimum of the distance and a blurred copy of it (see ticket 02).
- Seen in the game (2026-09-26, reported by the materials session):
  - Big blotchy light and dark patches show through the water near the coast, e.g. off the south coast around km
    31, 55 looking north, and off the volcano's east side around km 58, 24. Suspected cause: the floor noise scales
    with depth (a quarter of it) on a shallow shelf, and the water's depth absorption makes every bump visible.
  - The volcano-dammed lake (km 44–49, 19–28) shows the same blotchy bed. Lake beds need the same treatment: deep
    enough in the middle, gently shelving shores, and no speckle. Not yet investigated: check what the bed is made of
    there (flat fill from the landscape model plus micro-relief and droplet deposits?) before choosing a fix.
