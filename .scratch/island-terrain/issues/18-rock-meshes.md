# 18 — Rock and boulder meshes

**What to build:** Things a heightfield can't make: overhangs, sheer faces, boulders, rock piles. Generated 3D rock
meshes, textured with the photoscanned rock materials, are scattered by rule:
- boulders and blocks on scree below cliffs, and on river beds;
- outcrops and tors on scoured granite and limestone;
- rock faces with overhangs on the steepest cliffs.

The rules come from the generator's data maps (cliff, scree, flow, rock type). They are instanced, with LODs, and
visible far enough to matter from a glider.

**Blocked by:** 16 — Terrain detail below the stored grid

**Status:** ready-for-agent

- [ ] Rocks sit on the ground (no floating or buried pieces), matching the local rock type
- [ ] Cliffs gain real 3D faces and overhangs where they are steepest
- [ ] Collision matches what is drawn for the bigger rocks
- [ ] The frame-time cost is measured; reviewed in spectator mode with screenshots shown to the user
