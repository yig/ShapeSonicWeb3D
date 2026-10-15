// Octree build time, size and accuracy per model: npx vite-node tools/bench.ts [leaf_mm] [models...]
import { readFileSync, readdirSync } from 'node:fs';
import { ExactSDF } from '../src/geometry/bvh';
import { parseOBJ, prepareMesh } from '../src/geometry/mesh';
import { buildShapeSync } from '../src/geometry/shape';

const leaf = Number(process.argv[2] ?? 2) / 1000;
const names = process.argv.slice(3).length ? process.argv.slice(3) : readdirSync('models').map((f) => f.replace('.obj', ''));
for (const name of names) {
  const mesh = prepareMesh(parseOBJ(readFileSync(`models/${name}.obj`, 'utf8')), 0.4);
  const shape = buildShapeSync(mesh, { fitSize: 0.4, leafSize: leaf, margin: 0.5 });
  const exact = new ExactSDF(mesh);
  let rnd = 1;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const err = { near: 0, out: 0, inRel: 0 };
  for (let n = 0; n < 20000; n++) {
    const p = [0, 1, 2].map((a) => mesh.lo[a] - 0.1 + rand() * (mesh.hi[a] - mesh.lo[a] + 0.2));
    const e = exact.signed(p[0], p[1], p[2]);
    const d = Math.abs(shape.sdf(p[0], p[1], p[2]) - e);
    if (Math.abs(e) <= 0.002) err.near = Math.max(err.near, d);
    else if (e > 0.01) err.out = Math.max(err.out, d);
    else if (e < -0.01) err.inRel = Math.max(err.inRel, d / -shape.minSDF);
  }
  console.log(
    `${name.padEnd(8)} tris ${String(mesh.tris.length / 3).padStart(6)} leaves ${(shape.octree.leafCount / 1e6).toFixed(2)}M ` +
      `${(shape.octree.bytes / 1e6).toFixed(1)} MB  build ${shape.buildSeconds.toFixed(2)} s  ` +
      `err near ${(err.near * 1000).toFixed(2)} mm, out ${(err.out * 1000).toFixed(1)} mm, in ${(err.inRel * 100).toFixed(1)}%  ` +
      `edges ${shape.edgeCount} corners ${shape.cornerCount} watertight ${mesh.watertight}`,
  );
}
