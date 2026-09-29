# 17 (rock structure): merge notes

Branch `worktree-agent-a6e4a8428d700d309`. Latest: `ad0fe94` (round 3), playable as `islands/rock3`. Merge only after
ticket 28 is on main and Garrett approves 17. Every regeneration goes through the WSL `heavy` wrapper.

## Order

1. Merge current main into the branch. Expect conflicts in `island/finalize.py`: main's droplet call scales `life` for
   N > 4096 (`sN`) and uses region hardness, while 17 uses rock hardness and adds the pit fill after `R.finish`. Keep
   17's hardness and pit fill, and add main's `sN` scaling.
2. Karst is counted twice on this branch today (confirmed):
   - `design.py:138`: `rain *= (1 - 0.55 * w_med)`, the old regional stand-in;
   - `rock.py` lithology: `runoff = 1 - KARST * karst` on bare limestone and dolomite.

   After 28, the stand-in is one switch, `karst` in `design.py`. Set it to 1 so only `rock.py`'s runoff applies, then
   re-tune `KCOL[SED]` (and `'plat'`), which were calibrated with both in place. Target: the Mediterranean relief
   stats in the gen log (`med max / p50 / p90`) close to k23's (max 2753, p50 359, p90 852 at 2048).
3. Climate hook: `Rock.lithology(..., climate={'frost', 'rain'})` still reads `rain` as relative precipitation
   (1 = the design's mean). 28's API is `climate(h, dx, state='interglacial'|'glacial', wind=, max_n=)` and has no such
   field; `enabled()` reads the `CLIMATE` switch, and `rain()` is only the landscape model's erosion calibration.
   Feed rock.py rain in mm/yr divided by a reference in rock.py (the island mean), and frost from 28's frost field.
   Keep the `climate=None` default (neutral).
4. Regenerate at 2048 (gen → glaciate 2048 → finalize → export to `islands/rock4`) through `heavy`, and re-check with
   headless pairs against rock3 at the spots in `shots/k23/spots.txt`. Check the lake table: y comes before x in its
   bbox.

## Contracts (unchanged)

- Bedrock ids (`rock.BEDROCK`): 0 none/sea, 1 granite/gneiss, 2 schist, 3 limestone, 4 marl/shale, 5 sandstone,
  6 lava, 7 tuff/ash, 8 dolomite (taken from the reserved ids). Ticket 31 reads these from the rock map.
- `rock.py` interface: `Rock.from_design`, `window`, `lithology`, `bedrock`, `structure_ab`, `finish`, `model_props`;
  `RockFrame`. Round 3 added the module function `contour_blur` and `_lines(..., minw)`; no signatures changed.

## Handed off

- Ticket 36 (`issues/36-rock-wall-rendering.md`): snow on every bench, wall-texture tiling, height-only sandstone
  stripes in the shader.
