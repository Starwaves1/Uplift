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

- [x] The generator's final stage and export run at ≥ 8192² (7.8 m or finer), in reasonable time and memory on this machine
- [x] The whole shipped page stays within the artifact limits (every file ≤ 16 MB, total ≤ 64 MB with the material textures), measured and written down in the ticket
- [x] The game loads it in a few seconds with no stall: JS memory and GPU memory are measured and reasonable (no full-size float copies)
- [x] Heights in JS (collision) and GLSL (render) still match exactly
- [x] Round trip verified (max error ≤ the quantisation step), including below −400 m (the glacial fjords)
- [ ] Reviewed in spectator mode against today's island from the same viewpoints, with screenshots shown to the user

## Comments

- 2026-09-26: the user asked for 10× today's resolution. The artifact budget rules out storing it, so the effective 10×
  comes from this ticket plus ticket 16. If the game is ever hosted outside the artifact, true stored 10× becomes
  possible, as a multi-GB download.
- 2026-09-27: 8192² (7.81 m) lands; the shipped island is the `p` landscape finalized at 8192² (tag r5).
  - **Codec** (measured on the 8192² island): today's median-edge predictor + byte planes + zlib would be ~27 MB (it is 13 % larger
    than planar at 4096²).
    Planar predictor (W + N − NW) + zlib is 23.2 MB (2.76 bits/sample); least-squares predictors with up to 10
    neighbours gain only 1.3 %, split planes vs one escaped byte stream are the same size, and a context-adaptive
    entropy coder would gain ~7 % at best — none worth a custom JS decoder. 0.2 m steps would save 15 % (20 MB) but
    the budget doesn't need it, so the step stays 0.1 m (error ≤ 5 cm). Most bits are land (4.8 bits/sample on land,
    1.3 on the sea floor — the latter is pure rounding noise on a smooth surface). 16384² would be ~95 MB: out of reach.
  - **Format 2**: 'WBIS' v2 header (offset from the data, so any depth fits), then one zlib stream of one byte per
    zig-zag residual (255 escapes to two), cut into files of ≤ 14 MB: `island.bin` 14.00 MB + `island-1.bin` 9.16 MB.
    The game still reads format 1 (old exports, `?island=` folders).
  - **Budget**: island.bin 14.00 + island-1.bin 9.16 + island_maps.bin 3.59 + materials 15.79 + page ~0.67 = 43.2 MB
    of 64; largest file 14.0 MB (binary limit 15 MB). The glacial landscape at 8192² is 23.5 MB.
  - **Runtime**: decoded as it downloads, straight into a Uint16Array (128 MB; no float copy, no 256 MB temporaries).
    GPU: R16UI 8192² + a 2×2-mean pyramid made in JS (112 ms) = 179 MB (was 89.5 MB for 4096² R32F; an 8192² R32F
    would be 358 MB). Filtering by hand: Catmull-Rom (hmCubic) and trilinear over the pyramid (hmLod); a 2048² pass of
    12 terrainH() calls costs 1.6–1.9 ms vs 1.3–1.4 ms before, i.e. nothing at the tile cache's rate. JS heap 189 MB
    vs 126 MB before (glider-only build). Load from localhost: ~1.1 s for 8192² (inflate 0.14 s, the rest the
    predictor loop, chunked so the page never stalls) vs ~0.4 s for 4096². islandH() got faster (53 ns vs 76 ns).
  - **JS vs GLSL**: 65 536 points, median 0.14 mm, 99th percentile 3.7 mm, max 43 mm on a near-vertical face (float32
    world coordinates, as before); fjord floors below −400 m within 4 mm.
  - **Round trip**: max error 0.050 m for both islands; the glacial one has 17 503 cells below −400 m (lowest
    −604.7 m), all within 0.050 m, and the JS decoder reads the same values.
  - **Generator** at 8192²: 4–6 min (machine busy), peak 9.1 GB RAM (was 19.8 GB; what's left is lem.flow's routing
    arrays in the fans and maps stages), 5.0 GB GPU (was 12.5 GB: the design is now built at ≤ 4096² and its smooth
    region weights upsampled). Export: 80–100 s, 3.8 GB. Droplets sample the
    spawn CDF above 2^24 cells (torch.multinomial's limit), live as far in metres (life ×2) with a 3-cell brush (finer
    rills). The refine step is now a cubic B-spline: torch's bicubic (a = −0.75) left a waffle of slope ripples at the
    landscape's 31 m grid, plain in the shading at 4×.
  - **Side effect for the lead**: the volcano-dammed lake at the valley head spills at ~(43.9, 29.1) km over a narrow
    sediment barrier; at 8192² it is ~7 m lower (26.6 m vs 33.2 m, 27 vs 32 km²).
