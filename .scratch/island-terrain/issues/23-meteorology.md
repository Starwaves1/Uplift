# 23 — Clouds and local weather with real meteorology

**What to build:** Clouds and weather that match how the real atmosphere behaves. Mild and believable: no
thunderstorms or hurricanes.
- **Cloud genera by altitude:** fair-weather cumulus at the lifting condensation level, lower in moist air and over
  the sea; stratocumulus decks; altocumulus; cirrus high up. Each has the right shapes, densities and lighting. The
  cumulus should look like real clouds, not cotton balls.
- **Meteorology:** cumulus grow over sunlit slopes and thermals (the game already has thermals); orographic cloud forms
  on windward mountains and lee sides are clearer. Clouds drift with the wind and grow and decay.
- **Mild weather cycles:** fair spells, building afternoon cumulus, occasional overcast, changing over minutes.
- **Local rain:** showers under some clouds and not others, fading in and out, drifting and slanting with the wind,
  drawn as real precipitation curtains.
- **Bugs:** clouds intersect steep peaks (the user found one half on top of a summit); the rain looks like jellyfish
  tentacles.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] Several cloud genera at plausible altitudes, with bases following the condensation level and the terrain (no cloud inside a mountain unless it's deliberate hill fog)
- [ ] Cumulus look real close up and far off (lighting, edges, shadows)
- [ ] Clouds form, drift, grow and decay; windward orographic cloud and clearer lee sides
- [ ] Mild weather cycles; local showers that fade in and out, drift and slant with the wind, drawn as precipitation curtains
- [ ] Frame time measured (High); reviewed in spectator mode with screenshots, and a description of the weather cycle shown to the user

## Comments

- 2026-09-27, user: "I want actual cloud science and meteorology simulated here. I want them to be truly, truly like
  accurate clouds. I want varying levels of clouds, accurate to how real clouds actually are, with some basic
  procedural cloud generation, movement and some mildly different weather cycles. Nothing crazy, nothing drastic. No
  thunderstorms or hurricanes, but little local weather like rain that is in certain spots but not others and fades in
  and out, and interacts with the wind a bit." The user also sent a screenshot of a cloud on a steep summit and rain
  drawn as streaky strands.
