# 15 — Stored terrain resolution: as fine as the artifact allows

**What to build:** Today the island's heights are stored at 4096², one sample per 15.6 m, and the user finds the
geometry "really, really low" resolution. They want 10× the resolution, a sample every 1.5 m. Stored at that density
the island would be ~1.7 billion samples, several GB even compressed, far over the artifact's 64 MB per version (16 MB
per file). So resolution comes in two layers:
- this ticket stores the generated terrain as finely as the budget allows;
- ticket 16 synthesises the rest on the GPU, reaching 1.5 m or finer near the camera.

Target: at least 8192² (7.8 m), finer if a better codec makes room. The generator's final stage runs at that resolution,
so its rain gullies, talus and coast detail exist at 7.8 m. The export format stays compact, and the game loads and
samples it without blowing up memory. For example: 16-bit heights on the GPU with manual bicubic filtering, a separate
float pyramid for distant LOD, and no 268 MB Float32Array.

**Blocked by:** None — can start immediately.

**Status:** claimed

- [ ] The generator's final stage and export run at ≥ 8192² (7.8 m or finer), in reasonable time and memory on this machine
- [ ] The whole shipped page stays within the artifact limits (every file ≤ 16 MB, total ≤ 64 MB with the material textures), measured and written down in the ticket
- [ ] The game loads it in a few seconds with no stall: JS memory and GPU memory are measured and reasonable (no full-size float copies)
- [ ] Heights in JS (collision) and GLSL (render) still match exactly
- [ ] Round trip verified (max error ≤ the quantisation step), including below −400 m (the glacial fjords)
- [ ] Reviewed in spectator mode against today's island from the same viewpoints, with screenshots shown to the user

## Comments

- 2026-09-26: the user asked for 10× today's resolution. The artifact budget rules out storing it, so the effective 10×
  comes from this ticket plus ticket 16. If the game is ever hosted outside the artifact, true stored 10× becomes
  possible, as a multi-GB download.
