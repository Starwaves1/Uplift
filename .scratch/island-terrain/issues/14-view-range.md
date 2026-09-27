# 14 — View range: detail, trees and flowers seen from far away

**What to build:** This is a game about looking at the land from far away, but its detail stops close to the camera:
- the terrain mesh doubles its spacing with every ring out: 2 m to 180 m, 16 m at 1.4 km, 64 m at 6 km, 128 m at
  11 km;
- trees fade out at 1.3 km, shrubs at 440 m, grass at 75 m.

The user wants to see it all about 5× further, including trees and flowers from much further off. In High mode:
- terrain detail follows how large it looks on screen, so a triangle stays a few pixels wide at any distance;
- trees stay visible out to 8–10 km, turning into impostors (flat cards that look 3D) beyond a few hundred metres;
- shrubs, flowers and grass reach several times further, thinning with distance, with flowers turning into colour
  far off;
- beyond the last plants, forest and meadow carry on in the terrain's colour, so there is no visible edge.

Medium and Low stay as they are; they are derived later.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Terrain mesh detail holds out to about 5× today's distances (16 m spacing no nearer than ~7 km, where today it is 1.4 km), with no popping, cracks or swimming between rings
- [ ] Trees stay visible out to 8–10 km, with no visible ring where they disappear; from 3 km up, a forest reads as a forest
- [ ] Shrubs, flowers and grass reach several times further than today, fading smoothly
- [ ] Frame time is measured on the RX 7900 XT at 1920×1080 before and after each change. High holds 120 fps at typical views, or the report states the cost and where to trim
- [ ] Reviewed in spectator mode (`?fly`) from low and high viewpoints, with before/after screenshots shown to the user

## Comments

- 2026-09-26: requested by the user after flying the island in spectator mode ("I would like to see it 5 times
  further … I want to see flowers and trees from much further"). Delegated to an Opus agent in its own worktree.
  The materials session owns the terrain shading in the terrain module; this ticket touches the level-of-detail
  selection and ranges there, plus the vegetation code.
