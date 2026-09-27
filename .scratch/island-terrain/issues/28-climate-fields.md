# 28 — Climate and weather that shape the island

**What to build:** The island should be shaped by actual weather. Give the generator a climate that drives every
erosion process, instead of hand-set rain multipliers per region:
- a prevailing wind (WNW) with its variability;
- orographic precipitation: moist air rising over windward slopes rains out, and lee sides lie in rain shadow;
- temperature falling with altitude, giving frost weathering above the treeline, snow, and the glaciers' equilibrium
  line (for ticket 02);
- storm statistics: how often and how hard heavy-rain events hit, by place, for ticket 29.

These are fields the landscape model reads each step (and that change through glacial and interglacial climates).
They are exported too, so the game's weather (23) and vegetation can match the island's own climate.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Precipitation, temperature/frost, wind and storm-frequency fields computed from the terrain and a prevailing wind with a physically sensible model (e.g. a linear orographic precipitation model)
- [ ] Wet windward slopes and dry lee sides emerge from the terrain, not from region labels
- [ ] Glacial and interglacial states supported (colder, lower snowline), usable by ticket 02
- [ ] The fields plug into the landscape model's erosion (river power, droplets, glaciers) as a clean module, exported for the game
- [ ] Before/after previews of the island with climate-driven erosion, shown to the user

## Comments

- 2026-09-27, user: "I want this island to be shaped by actual weather and actual events, simulated glaciers,
  simulated storms, simulated wind, simulated droplets, actual topsoil, various types of materials. The volcanic rock
  being different from the bedrock, being different from uplifted rock, all that stuff. I want it to be real."
