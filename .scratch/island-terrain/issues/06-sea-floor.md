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
