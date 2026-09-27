# 19 — River and lake water rendering

**What to build:** Rivers you can see and follow from the air. The game side of ticket 09, split out so it can start
now. The engine draws flowing river water along the island's river network:
- widths grow with the discharge, from mountain streams to the great valley's river;
- the surface follows the terrain down the valley with no steps or gaps;
- the water visibly flows in the downhill direction;
- rivers meet lakes and the sea without seams.

The network comes from the data the island already ships. The flow-accumulation map in island_maps plus the heights
are enough to trace centrelines when the island loads, so no export change is needed yet. Ticket 09 later carves proper
channels and cleans up lakes in the generator; the renderer should improve automatically when that lands.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Rivers above a size threshold are drawn along the valleys, their width scaling with discharge, from 2–3 m streams to a 30–60 m main river
- [ ] Water surface levels follow the ground: no floating ribbons, no water buried under the terrain, no steps at LOD seams
- [ ] Flow is animated in the downhill direction; the shading matches the lakes and sea (reflections, depth colour) at a fraction of their cost
- [ ] Rivers join lakes and the sea cleanly
- [ ] Visible from far enough to follow them in a glider (several km), with a measured frame-time cost
- [ ] Reviewed in spectator mode along the great valley and a Nordic river, with screenshots shown to the user
