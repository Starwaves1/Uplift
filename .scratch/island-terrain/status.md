# Status (2026-09-27)

**Merged to main before the approval rule, awaiting Garrett's review:**
- 15: 8192² island (a7c3c2a)
- 14: view range (a82b960)

**Awaiting Garrett's review:** 16 GPU detail (rebasing onto main; port 8770).

**Running:**
- 02 fjords, also Alpine glacial forms
- 08 valley head
- 17 bedrock types
- 28 climate fields
- 31 topsoil and sediments (owns island_ground.bin)
- 19 rivers and lake shores (8771)
- 20 baked light (8772)
- 21 footings, then 12 villages underwater and walls (8773)
- 23 clouds and weather (8774)
- 27 pause Esc (8775)

**Queued:**
- 29 storms and 30 wind (after 28)
- 22 windmills, then 26 villages (same module)
- 24 trees
- 25 wildlife
- 32 fly-through features
- 03 and 05 (after 17)
- 04 (after 03)
- 18 (after 16)
- 06, 09, 10, 13

**Integration plan:** once the generator branches are approved, run one combined island:
1. the landscape model at 4096² with 08, 17, 28 and 31;
2. 02's glacial stage;
3. 29 and 30 when ready;
4. finalize at 8192²;
5. export heights, maps and the ground map;
6. render with 14, 16, 19, 20 and 23.
Garrett reviews that island.

**Fold into integration:**
- droplet artefacts at 8192² (beaded channels, streaks on fans);
- the volcano lake sits ~7 m lower;
- far copses speckle;
- High mode costs 7.4–8.5 ms/frame (perf ticket after this wave).

**Garrett's decisions:**
- procedural generation, not real elevation data;
- no hand-drawn landforms;
- 10× effective resolution (8192² stored plus GPU detail);
- 5× view range;
- the island shaped by weather, ice, storms, wind, soil and real rock types;
- approval before every merge.
