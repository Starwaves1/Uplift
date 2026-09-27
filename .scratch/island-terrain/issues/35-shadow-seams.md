# 35 — Shadow seams: hard straight dark edges across the ground

**What to build:** The user flew the island and found a hard, straight dark edge running diagonally across flat
ground. It darkens trees and ground equally, so it's sun visibility rather than texture. A real ridge shadow would
follow the ridge's jagged outline. Likely causes: a cascaded-shadow-map boundary, cascade fit or coverage, or the edge of
the cloud-shadow map. Find it and fix it so shadows fade and blend correctly at every distance and sun angle.

**Blocked by:** None — can start immediately (use the headless review tool, ticket 33, for all testing).

**Status:** ready-for-agent

- [ ] The cause is identified (cascade split, fit, coverage or cloud-shadow extent) with proof
- [ ] No hard straight shadow edges at any distance or sun angle; cascades blend smoothly; cloud shadows fade at their extent
- [ ] Frame-time cost measured; flown and approved by the user

## Comments

- 2026-09-27: from the user's review screenshot (image 5 in the lead's session, valley-head island, low sun). The
  materials session attributed it to shadows, not shading.
