# 02 — Designed fjords

**What to build:** Three dramatic, flyable fjords cut into the Nordic highland, placed by design instead of
auto-traced from the drainage. The Vestfjord runs from the west coast deep into the highland to the foot of the north
range. The Nordfjord comes in from the north coast and joins it, so the north-west block stands as its own island and a
glider can fly all the way round through the two. The Austfjord is the long inlet on the east side of the highland.
Each has a shallow sill at its mouth, deep dark basins inside, and a flat head valley rising inland beyond the water.

**Blocked by:** 01 — Iteration harness

**Status:** ready-for-agent

- [ ] The three fjords are designed polylines (floor depth and floor width per vertex) in the island layout, carved by a pass in the pipeline; the old auto-traced fjord is gone
- [ ] Walls rise 500–900 m, at 45° or steeper near the water, with truncated spurs and hanging side valleys
- [ ] The walls are gullied and broken like real rock (the rain and talus passes run after the carve), with no smooth ramps or streak artefacts
- [ ] The fjord water reads deep and dark in the game; the sea floor pass does not flatten the fjord basins
- [ ] The Vestfjord–Nordfjord loop can be flown end to end at 150–300 m above the water without clipping a wall
- [ ] The head valleys give flat ground at each fjord head (future village sites)
- [ ] Reviewed from the air in the game at each fjord mouth, junction and head, with screenshots

## Comments

- Prototype: a first carve (per-vertex spline troughs, walls about twice as steep as the great valley's) was tried on
  the current island. The fjords already read as fjords and the junction works; the walls came out smooth and streaky
  because the rain pass had not run on them, and the Nordfjord's channel shows as a dark stripe out at sea where it meets
  the sea floor.
