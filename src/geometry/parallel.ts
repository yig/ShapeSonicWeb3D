// Parallel octree build: a pool of workers, each with its own BVH over the
// same mesh, pulls the 64 independent subtrees; the main thread stitches them.

import { assembleOctree, subtreeTasks, type SubtreeResult } from './octree';
import type { Mesh } from './mesh';
import { buildShapeSync, DEFAULT_BUILD, layoutFor, Shape, type BuildOptions } from './shape';
import type { WorkerRequest } from './sdf.worker';

let pool: Worker[] = [];
let generation = 0;
let cancelCurrent: (() => void) | null = null;

const poolSize = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

function makePool() {
  pool = Array.from({ length: poolSize() }, () => new Worker(new URL('./sdf.worker.ts', import.meta.url), { type: 'module' }));
}

/** Build a shape's SDF using all cores. A newer call cancels an older one (its promise rejects). */
export async function buildShape(
  mesh: Mesh,
  options: BuildOptions = DEFAULT_BUILD,
  sharpAngleDeg = 30,
  onProgress?: (fraction: number) => void,
): Promise<Shape> {
  if (typeof Worker === 'undefined') return buildShapeSync(mesh, options, sharpAngleDeg);
  const build = ++generation;
  // Abandon any build still running: restart the workers.
  cancelCurrent?.();
  if (pool.length) pool.forEach((w) => w.terminate());
  makePool();
  const workers = pool;
  const start = performance.now();
  const layout = layoutFor(mesh, options);
  const tasks = subtreeTasks(layout);
  // The tasks nearest the shape are the slowest; start them first.
  const c = layout.origin.map((o) => o + layout.size / 2);
  const leaf = layout.leafSize;
  const dist = (t: (typeof tasks)[0]) =>
    Math.hypot(...[t.i, t.j, t.k].map((v, a) => layout.origin[a] + (v + t.side / 2) * leaf - c[a]));
  tasks.sort((a, b) => dist(a) - dist(b));
  const results: SubtreeResult[] = [];

  await new Promise<void>((resolve, reject) => {
    cancelCurrent = () => reject(new DOMException('Superseded by a newer build', 'AbortError'));
    let next = 0;
    const send = (w: Worker) => {
      if (next < tasks.length) w.postMessage({ type: 'task', build, task: tasks[next++] } satisfies WorkerRequest);
    };
    for (const w of workers) {
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.build !== build) return;
        if (msg.type === 'error') return reject(new Error(msg.message));
        results.push(msg.result);
        onProgress?.(results.length / tasks.length);
        if (results.length === tasks.length) resolve();
        else send(w);
      };
      w.onerror = (e) => reject(new Error(e.message || 'SDF worker failed'));
      w.postMessage({ type: 'mesh', build, mesh, layout } satisfies WorkerRequest);
      send(w);
    }
  });
  cancelCurrent = null;
  const octree = assembleOctree(layout, results, mesh.lo, mesh.hi);
  // Free the workers' copies of the mesh and BVH.
  workers.forEach((w) => w.terminate());
  if (pool === workers) pool = [];
  return new Shape(mesh, octree, (performance.now() - start) / 1000, sharpAngleDeg);
}
