# 02 — Glacial fjords from the landscape model

**What to build:** Fjords that come out of the landscape simulation rather than being drawn on. The landscape
evolution model gets Quaternary-style glaciations:
- **Glacial stages:** the sea is lowered by about 120 m. The equilibrium line (the snowline where glaciers neither
  grow nor shrink) sits low over the windward Nordic north-west, giving an ice cap, higher over the Alpine ranges, and
  high enough in the south that only the tallest summits carry ice.
- **Interglacial stages:** today's sea and rivers return.

Ice flux is routed down the model's own drainage from the snow gathered above the equilibrium line. Glacier width,
thickness and sliding speed all scale with that flux, and the bed erodes in proportion to sliding speed across the
glacier's whole width. That combination produces the landforms we want:
- the rivers' valleys become flat-floored troughs with steep walls;
- big glaciers cut deeper than their tributaries, which are left as hanging valleys;
- thin ice on the uplands barely scours, so the fell between the troughs survives;
- outlet glaciers cut below sea level where they reach the coast, and those troughs flood as fjords when the sea
  returns.

Where the fjords form, how many there are, how they branch and how deep they get should all follow from the landscape.
Steer them only through climate (equilibrium line, mass balance) and rock strength, never by drawing them.

**Blocked by:** 01 — Iteration harness

**Status:** done (merged to main 2026-09-27 at Garrett's go; open items below)

- [x] Glaciation runs inside the landscape model, as a stage that can restart from a finished river-eroded landscape for fast iteration; the designed fjord lines and their carve pass are removed from the pipeline
- [x] At least two or three major fjords form in the Nordic north-west, each reaching 5 km or more inland, with walls rising 500–900 m at 40° or steeper near the water, a sill near the mouth and deeper basins inside
- [ ] Tributary troughs hang above the main fjords, cirques form at glacier heads, and truncated spurs line the main troughs
- [ ] The uplands between the fjords survive as broad fell rather than being cut up
- [ ] The Alpine ranges get glacial valleys and cirques at their own, higher equilibrium line; the young volcano cone stays unglaciated
- [ ] Rivers and deltas rework the fjord heads during the interglacials, leaving flat head valleys
- [x] Later passes keep the fjord basins deep: the sea floor pass no longer flattens them, and no channel shows as a stripe out at sea
- [x] Reviewed from the air in the game at each fjord mouth and head, with screenshots, against real references (Sognefjord, Geirangerfjord, Lysefjord)

## Comments

- 2026-09-26: a designed-line version was built and previewed first. It had three hand-placed spline troughs (the
  Vestfjord, Nordfjord and Austfjord) carved into the finished island. The user judged it "highly unnatural" and asked
  for fjords generated with the landscape. Lessons from that version, which the glacial model should avoid by
  construction:
  - smooth planar walls and straight shoulder lines give away a carved trough;
  - a constant width reads as a canal;
  - rounded bowls at the heads look artificial.
  That version is kept in `git stash` as "designed fjords (rejected)" for reference; it is not to be revived.
- Starting points:
  - The landscape model now has an ice-flux routing function. It accumulates mass balance down the drainage stack,
    never lets flux go negative (glaciers end where melt uses up their ice), and drops ice that reaches base level
    (calving).
  - Draft glacier scalings, with Q the ice flux in m³/yr: width about 1.3·Q^0.4 m; thickness about 4.9·(Q/width)^0.4 m;
    sliding speed = flux per unit width ÷ thickness. That gives a 1.5 km wide, 300 m thick glacier moving 100 m/yr for
    Q = 4.5·10⁷.
  - Erosion ∝ sliding speed, spread across the width with a plug-flow profile, 1 − (2d/width)⁴.
  - Apply ice erosion explicitly, not limited by the bed slope, so overdeepenings and sills can form.
  - During glacials keep base level at the preglacial sea, so cells carved below 0 keep eroding under the ice.
  - Glaciated cells skip river erosion, and the critical hillslope angle is raised on glacier walls.
  - Iterate at 1024² starting from the round-p landscape (a fluvial run takes about 10 minutes at 2048²).
- Also found: the sea floor pass takes depth from distance to land, and that distance peaks along the middle of every
  gap in the coast, so each bay or fjord mouth throws a deeper channel out to sea. Fix it by flattening those ridges,
  e.g. take the minimum of the distance and a blurred copy of it. This belongs to ticket 06 as well.
- Overlap with 07 (Nordic upland character): an ice cap over the Nordic highland may produce much of 07's fell,
  tarns and cirques. Re-scope 07 once this lands.

- 2026-09-27, closed out: merged with the Alpine sculpting (snowfield ice, frost-cracked cirque headwalls, a fracture
  stand-in for quarrying, snowline from ticket 28's climate.py when `ISLAND_CLIMATE` points at it). Check run fgZ
  (fH_2048 → 1024, 12 cycles, climate.py snowline): fjords 14.0 / 11.2 / 6.8 / 6.2 km inland, sills −26 / −30 / −29 m,
  deepest −372 m; Alpine ridges come out sharper, with arêtes and a horn (island/preview/fgZ_alp_ne.png vs fgH_alp_ne.png
  in the worktree). Left open, for ticket 34 or a follow-up:
  - side valleys still spaced like a comb or fishbone off the ridges;
  - fjord mouths too wide (3–6 km);
  - no tarns on the fell yet (the fracture stand-in is too weak);
  - with climate.py's glacial snowline the volcano sits partly above the ELA (p50 ~900 m): check it stays bare;
  - fracture density should come from ticket 17's rock model; the ELA switch becomes plain once climate.py merges;
  - hanging valleys, cirques at the Nordic heads and the interglacial head deltas not yet verified.
