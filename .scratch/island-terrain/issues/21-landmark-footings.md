# 21 — Landmark footings: stop re-sampling the terrain every frame

**What to build:** The landmark buildings snap their footings to the ground by evaluating `terrainH` for every vertex,
in every shadow cascade, every frame. With ticket 16's terrain detail, that costs about +0.3 ms near villages. Bake the
footing heights once when a landmark is placed; JS and GLSL heights agree within centimetres, so a CPU bake is exact
enough. Alternatively, use a coarse height in the shadow passes. The ground must still meet every building with no gaps
or floating.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Landmark frame cost near a village returns to within noise of the pre-ticket-16 cost (measured on the RX 7900 XT at 1080p)
- [ ] No floating or buried footings, before or after terrain detail changes
- [ ] Before/after timings and one screenshot near a village in the ticket
