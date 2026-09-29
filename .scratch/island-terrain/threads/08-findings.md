# 08 valley head: why v8head looked wrong (input for 34, the full regeneration)

Garrett flew `islands/v8head` and didn't approve it. As agreed, ticket 08 doesn't rework the landform. This note
explains each problem he saw, says whether it comes from the generator or the engine, and lists what the regeneration
should keep.

All measurements are on the finished island `h_v8tF_4096`. I reran finalize and saved the grid after every pass
(`island/work/st_v8tS_<stage>.npy`: a_micro, b_trough, c_beds, d_drops, e_talus, f_fans, g_coast, h_sea).
- Evidence images: `island/preview/v8/v8_x_*.png`, `v8_evidence_*.png`.
- Scripts: the `*.py` files in the same folder.

## 1. Corrugated stripes (7.webp; also the regular bands at the left of 6.webp): a generator bug in `passes.trough`

**Cause.** `trough()` draws the valley line into grid cells (`polyline_raster`). It then takes the distance to that
line with `distance_transform_edt`, and the floor and width from the nearest drawn cell.
- A diagonal line drawn in cells is a staircase. The distance to it ripples along the valley with the staircase's
  period: about 60 m at this valley's angle, at 15.6 m cells.
- The wall term `0.022·e^1.5` turns that ripple into ridges running down the walls, 5–13 m high where the walls are
  steep. The floor gets faint terraces from the same cause.

**Proof** (`island/preview/v8/trough_exact.py`):
- Rerunning the trough on the pre-trough grid reproduces the shipped pass exactly (max difference 0.0 m).
- Swapping in the exact distance to the polyline (segment projection, floor and width interpolated at the nearest
  point) makes the stripes vanish. The two surfaces differ by 3.3 m rms, 13 m at the 99th percentile.
- Spectrum at the rock step: a 61 m peak running 166° (square to the axis) with the cell-drawn line; no such peak with
  the exact distance.
- Images: `v8_x_step.png`, `v8_x_nwall.png` and `v8_x_floor.png`, cell-drawn line on the left, exact distance on the
  right.

**Scope.**
- Main's shipping island (`h_pf_4096`) has the same stripes, fainter (`v8_pf_wall.png`), so this is an old bug that
  08's deeper cut made more visible.
- The fjords go through the same `trough()`, so they have it too.
- **Suspect, not checked:** the coast pass has the same pattern. It builds cliffs as `face=4.5 × EDT` from a
  cell-drawn shoreline.
- The engine isn't needed to explain it: the stripes are in the stored heights.

**Fix for 34:** compute the distance to any designed line exactly, never with an EDT of a drawn line. Better still, let
the glaciers (02) cut the troughs so no distance field is needed.

## 2. Ring-shaped hollows on the valley floor (6.webp): generator, the droplet and fans passes on a planed floor

**Scale check.** The stripes in 6.webp are 60 m apart, like the trough ripple. By that scale the rings are about 200 m
across with a centre about 70 m wide.

**Sequence**, from radial profiles of detected rings traced pass by pass (`cprof.py`):
1. **Landscape model output:** each spot is a river channel incised 10–40 m. No ring.
2. **Trough:** planes the floor flat.
3. **Droplets:** on that flat floor, the droplets drop their load in blobs. That leaves 2–4 m mounds with moats or
   raised rims, 100–200 m across.
   - The droplets change 95% of the floor by more than 1 m, with a mean deposit of +5.4 m.
   - Floor relief across the valley goes from 2.7 m rms to 5.6 m rms.
4. **Fans:** at (36.30, 28.50) a fan cone then plugged a droplet crater, leaving a mound inside a moat inside a rim.
   That is exactly the 6.webp pattern.

Low sun plus the materials' hollow/moist darkening makes relief of 1–3 m read strongly.

**Fix for 34:**
- No droplet deposition on alluvial flats (or diffuse it afterwards).
- Floors and fans should come from the sediment model (31), not from cones with `np.maximum` on a planed surface.

## 3. Flat, shallow valley bottom: generator, the trough design, and low walls from the landscape model

**Flat.** The trough planes a floor 1.5–2.3 km wide: the raw ground was 16–136 m above the designed floor, and all of
it was cut to one plane. Real trough floors (Lauterbrunnen, Chamonix) are 0.5–1 km wide and gently cambered, with a
braided river.

**Shallow.** The trough can only remove rock, and the landscape model never built high walls beside it:

| Distance past the floor edge | Designed wall (m above floor) | Actual ground, median (m above floor) | Share the trough cut |
|---|---|---|---|
| 0.5–1 km | 458 | 213 | 12% |
| 1–1.5 km | 977 | 293 | 3% |

So the walls are the landscape model's low, eroded flanks.

**Fix for 34:** the relief has to come from uplift and rock in the landscape model, then glacial erosion (02) deepens
and narrows the trough. No finishing cut can make walls higher.

## 4. Smooth dome mountains (9.webp): generator, threshold hillslopes in uniform rock

Before finalize, the faces already sit on one threshold angle per region, with little fine relief:

| Region | Share of steep ground in one narrow band | Fine relief under 60 m (rms) |
|---|---|---|
| North range | 65% between 44° and 56° | 5.4 m |
| Head massif | 71% between 48° and 64° | 6.0 m |

The cause is `lem.hillslope`: talus relaxation to a critical slope `Sc` that is one smooth value per region (0.78, +0.25
for granite). Every face relaxes to the same planar angle. The finalize micro-relief and talus passes don't add
structure (6–7 m rms afterwards). This is ticket 17's job: rock that varies at sub-km scale, with benches, joints and
cliffs.

## 5. Engine-side items (not 08's; noted as asked)

- **5.webp hard straight dark edge:** a shadow seam, now ticket 35. I didn't reproduce it.
- **8.webp lake/sea "noise" and the dark band along the lake shore:** water rendering, ticket 19. The known ~7 m
  low lake level may add to it.
- **"Harsh falloff from afar":** not investigated in the engine. I didn't need to check hmLod or the far-field normals
  for the stripes, because they're in the stored heights.
- **Headless tool limit:** the spectator camera can't pitch down without pointer lock, so top-down views like 6.webp
  can't be reproduced headlessly yet. That's worth a small addition to the ticket 33 tool, e.g. an `at=` pitch.

## 6. What the regeneration should keep from 08, as geology

- **Why the valley faded out:** both ranges taper east of x≈38–41, and base uplift turns negative east of x≈42
  (−0.03 to −0.08 mm/yr). The lake's catchment then captured everything east of x≈34. If 34 keeps a positive uplift
  and resistant rock around the head, the capture doesn't happen.
- **A crystalline head massif:** an uplifted block where the two ranges converge, closing the valley (like the Aar or
  Mont Blanc massifs at Alpine valley heads). In 08 it was a horseshoe of uplift, 0.8 mm/yr, about 1.9 km wide. Its
  east side is a fault scarp dropping to the lake.
- **A granite pluton in its core:** erodibility ×0.55 and a steeper critical slope. It holds the rock step and steep
  walls (like the Grimsel granite). With 17's rock types this should be a real rock unit, not a multiplier.
- **A fault zone across the massif on the valley axis:** crushed, weaker rock (×1.35). Erosion from both sides follows
  it and opens the pass where they meet, as Alpine passes follow faults. A dip in the uplift instead put the col in the
  wrong place and opened a second, lower pass.
- **A corridor left for the southern river:** without it, the massif dammed that river into a 7–20 km² lake.
- **Keep this design.py fix:** measure the valley's uplift trough in km from the mouth, not as a fraction of the
  line's length. Otherwise editing the line's end silently changes uplift along the whole lower valley.

Branch `worktree-agent-a2a6e140d28af3497`, commit `7934c51` (design.py and finalize.py), not merged, as agreed.
