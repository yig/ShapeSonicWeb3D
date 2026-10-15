// Builds octree subtrees for the main thread (see parallel.ts).

import { ExactSDF } from './bvh';
import type { Mesh } from './mesh';
import { buildSubtree, type OctreeLayout, type SubtreeTask } from './octree';

export type WorkerRequest =
  | { type: 'mesh'; build: number; mesh: Mesh; layout: OctreeLayout }
  | { type: 'task'; build: number; task: SubtreeTask };

let current: { build: number; exact: ExactSDF; layout: OctreeLayout } | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'mesh') {
    current = { build: msg.build, exact: new ExactSDF(msg.mesh), layout: msg.layout };
    return;
  }
  if (!current || current.build !== msg.build) return;
  try {
    const result = buildSubtree(current.layout, msg.task, current.exact);
    (self as unknown as Worker).postMessage({ type: 'result', build: msg.build, result }, [result.nodes.buffer, result.values.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', build: msg.build, message: String(err) });
  }
};
