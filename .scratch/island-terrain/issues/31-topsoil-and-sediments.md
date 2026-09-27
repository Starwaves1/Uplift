# 31 — Topsoil and sediments

**What to build:** Real ground is layered: bedrock weathers into regolith and soil; soil creeps downhill and thickens
on gentle ground; rivers, glaciers, wind, volcanoes and waves lay down different sediments. Give the landscape model
that material state:
- a soil/regolith thickness produced from each bedrock type (ticket 17) at a rate depending on climate (28), and
  moved by creep, rain and storms;
- sediment types where they belong: river alluvium and gravel, glacial till and moraine, loess, volcanic ash and
  pumice, beach sand and shingle, scree and colluvium below cliffs;
- erosion that treats them differently: loose sediment moves easily, bedrock resists.

Export a material map (bedrock exposed, soil depth, sediment type), so the game's materials (11), GPU detail (16),
vegetation (24) and rock meshes (18) show rocks, pebbles, dirt, clay and bedrock where they really are.

**Blocked by:** None — can start immediately (use a placeholder bedrock map until 17 lands)

**Status:** claimed

- [ ] Soil and regolith thickness and sediment-type fields evolve in the landscape model, thin on steep and high ground, thick in hollows and valley floors
- [ ] Sediments appear where the processes put them (alluvium on floors, till and moraines below glaciers, ash on the volcano, scree below cliffs, sand on beaches)
- [ ] Erosion rates depend on material
- [ ] A documented material map is exported for the game
- [ ] Before/after previews and an in-game review, shown to the user

## Comments

- 2026-09-27, user: "It looks like it's from the same monomaterial instead of rocks and pebbles and dirt and clay and
  bedrock eroded differently." Later: "actual topsoil, various types of materials. The volcanic rock being different
  from the bedrock, being different from uplifted rock."
