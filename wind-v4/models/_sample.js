'use strict';
// Reference module showing the MESH API. Not part of the game build (files starting with _ are skipped).
const SAMPLE = (() => {
  const b = new MESH.Builder();
  // a tapered, bent tube with baked AO toward the base and wind sway toward the tip
  b.tube([[0, 0, 0], [0, 1.5, 0.2], [0.3, 3, 0.1], [0.8, 4.2, -0.2]], [0.3, 0.24, 0.16, 0.08],
    { sides: 10, color: [0.42, 0.3, 0.2], ex: (u, v) => [0.6 + 0.4 * v, v * v, 0, 0], capStart: true });
  // lathe: a vase profile (radius, y)
  const vase = b.lathe([[0.01, 0], [0.5, 0.05], [0.7, 0.6], [0.35, 1.3], [0.45, 1.6]], { sides: 20, color: (u, v) => [0.75, 0.45 + v * 0.2, 0.3] });
  b.translate(vase, 3, 0, 0);
  // displaced ellipsoid canopy with a colour gradient
  const blob = b.ellipsoid([0, 0, 0], [1.6, 1.2, 1.6], {
    seg: 18, disp: d => 0.85 + 0.25 * hash2(Math.floor(d[0] * 4 + 9), Math.floor(d[2] * 4 + d[1] * 7 + 9)),
    color: d => [0.2 + d[1] * 0.08, 0.45 + d[1] * 0.12, 0.18], ex: d => [0.55 + 0.45 * (d[1] * 0.5 + 0.5), 1, 0, 0],
  });
  b.translate(blob, 0.8, 4.6, -0.2);
  // box + extruded star, rotated
  const bx = b.box([-3, 0.5, 0], [1, 1, 1], { color: [0.7, 0.7, 0.75] });
  b.rotate(bx, 'y', 0.5, [-3, 0.5, 0]);
  const star = [];
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2, r = k % 2 ? 0.35 : 0.8; star.push([Math.cos(a) * r, Math.sin(a) * r]); }
  const st = b.extrude(star, 0.2, { color: [0.95, 0.75, 0.25] });
  b.translate(st, -3, 2, 0);
  const mesh = b.upload();

  // instancing: a little grove of the same mesh
  const grove = MESH.instances(mesh, 64);
  for (let k = 0; k < 12; k++) grove.push(10 + (k % 4) * 6, 0, -10 - Math.floor(k / 4) * 6, 0.6 + hash2(k, 3) * 0.5, hash2(k, 7) * 6.28, hash2(k, 11), hash2(k, 13));

  return {
    name: 'sample',
    preview(ctx) {
      MESH.drawStatic(mesh, ctx.vp, [0, 0, 0, 1], [0, 0, 0], 1, { spec: 0.2 });
      MESH.drawInstances(grove, { sway: 1 });
    },
  };
})();
MODELS.push(SAMPLE);
