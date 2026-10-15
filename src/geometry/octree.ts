// Adaptive octree signed distance field (a port of the iOS core's octree.cpp,
// restructured so that subtrees can be built in parallel by Web Workers).
//
// Refinement, level by level:
// * A cell the surface may pass through (its centre is within NEAR sides of
//   the surface; the half-diagonal is 0.87 sides) is always split, down to the
//   leaf size, so the zero level set is resolved at the finest level.
// * Any other cell is split if it is large compared to its distance from the
//   surface (side > distance / FAR), or if trilinear interpolation of its
//   corners misses the exact distance at its centre or at a face centre by more
//   than TOL_ABS + TOL_REL·|distance| (error-driven, as in adaptive distance
//   fields, Frisken et al. 2000). That puts cells near the medial axis and the
//   other kinks of the distance field, where interpolation is worst.
// Each leaf stores its 8 corner values, quantized to int16. Corners shared by
// several leaves are evaluated once (per subtree).
//
// Parallel build: the root and its 8 children are always split (they are
// always near the surface anyway, because the domain is the shape's bounding
// cube plus the guidance range), which gives 64 independent subtrees.

import type { ExactSDF } from './bvh';

const NEAR = 0.9, FAR = 1.0;
const TOL_ABS = 0.0005, TOL_REL = 0.01;
const MAX_DEPTH = 12;
export const LEAF = 0x80000000;
/** Levels that are always split, so 8^SPLIT_LEVELS subtrees are built independently. */
export const SPLIT_LEVELS = 2;

export interface OctreeLayout {
  /** Min corner of the root cube. */
  origin: [number, number, number];
  /** Root cube side (metres) = leafSize · 2^depth. */
  size: number;
  depth: number;
  leafSize: number;
}

/** One subtree to build: its min corner and side, in leaf units. */
export interface SubtreeTask {
  index: number;
  i: number;
  j: number;
  k: number;
  side: number;
}

export interface SubtreeResult {
  index: number;
  /** Local nodes: [0] is the subtree root. Internal: local index of the first of 8 children; leaf: LEAF | local leaf index. */
  nodes: Uint32Array;
  /** 8 corner values per leaf, metres. */
  values: Float32Array;
  minValue: number;
  maxAbs: number;
}

/** Root cube centred on the bounding box, covering it plus `margin`, with leaves exactly `leafSize`. */
export function octreeLayout(lo: ArrayLike<number>, hi: ArrayLike<number>, margin: number, leafSize: number): OctreeLayout {
  const half = 0.5 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + margin;
  let depth = SPLIT_LEVELS;
  while (depth < MAX_DEPTH && leafSize * 2 ** depth < 2 * half) depth++;
  // A very large domain (leaves would exceed MAX_DEPTH): grow the leaves instead.
  if (leafSize * 2 ** depth < 2 * half) leafSize = (2 * half) / 2 ** depth;
  const size = leafSize * 2 ** depth;
  const origin = [0, 1, 2].map((a) => 0.5 * (lo[a] + hi[a]) - size / 2) as [number, number, number];
  return { origin, size, depth, leafSize };
}

export function subtreeTasks(layout: OctreeLayout): SubtreeTask[] {
  const n = 2 ** SPLIT_LEVELS;
  const side = 2 ** (layout.depth - SPLIT_LEVELS);
  const tasks: SubtreeTask[] = [];
  // Task index t = 8·c + o: level-1 octant c, then level-2 octant o (bit 0 = x, 1 = y, 2 = z).
  for (let t = 0; t < n ** 3; t++) {
    const c = t >> 3, o = t & 7;
    const i = ((c & 1) * 2 + (o & 1)) * side;
    const j = (((c >> 1) & 1) * 2 + ((o >> 1) & 1)) * side;
    const k = (((c >> 2) & 1) * 2 + ((o >> 2) & 1)) * side;
    tasks.push({ index: t, i, j, k, side });
  }
  return tasks;
}

const KEY = 8193; // > 2^MAX_DEPTH: lattice coordinates fit
const cornerKey = (i: number, j: number, k: number) => (i * KEY + j) * KEY + k;

/** Build one subtree with the exact SDF. Runs in a worker (or synchronously in tests). */
export function buildSubtree(layout: OctreeLayout, task: SubtreeTask, sdf: ExactSDF): SubtreeResult {
  const { origin, leafSize } = layout;
  const [ox, oy, oz] = origin;
  const nodes: number[] = [0];
  // Cells of the current level: node index, min corner and side in leaf units.
  let level: number[] = [0, task.i, task.j, task.k, task.side];
  const leaves: number[] = []; // i, j, k, side per leaf
  const corner = new Float64Array(8);
  while (level.length) {
    const next: number[] = [];
    for (let c = 0; c < level.length; c += 5) {
      const node = level[c], ci = level[c + 1], cj = level[c + 2], ck = level[c + 3], cs = level[c + 4];
      let split = false;
      if (cs > 1) {
        const side = cs * leafSize;
        const lx = ox + ci * leafSize, ly = oy + cj * leafSize, lz = oz + ck * leafSize;
        const d = sdf.unsigned(lx + side / 2, ly + side / 2, lz + side / 2);
        if (d < NEAR * side || d < FAR * side) split = true;
        else {
          // Trilinear interpolation vs. exact values at the centre (the mean of
          // the 8 corners) and the 6 face centres (the mean of 4 corners).
          for (let o = 0; o < 8; o++) corner[o] = sdf.signed(lx + (o & 1) * side, ly + ((o >> 1) & 1) * side, lz + (o >> 2) * side);
          const off = (tx: number, ty: number, tz: number, interpolated: number) => {
            const exact = sdf.signed(lx + tx * side, ly + ty * side, lz + tz * side);
            return Math.abs(interpolated - exact) > TOL_ABS + TOL_REL * Math.abs(exact);
          };
          let mean = 0;
          for (let o = 0; o < 8; o++) mean += corner[o] / 8;
          split = off(0.5, 0.5, 0.5, mean);
          for (let axis = 0; axis < 3 && !split; axis++) {
            for (let s01 = 0; s01 < 2 && !split; s01++) {
              let face = 0;
              for (let o = 0; o < 8; o++) if (((o >> axis) & 1) === s01) face += corner[o] / 4;
              split = off(axis === 0 ? s01 : 0.5, axis === 1 ? s01 : 0.5, axis === 2 ? s01 : 0.5, face);
            }
          }
        }
      }
      if (split) {
        const first = nodes.length;
        nodes[node] = first;
        for (let o = 0; o < 8; o++) nodes.push(0);
        const s = cs / 2;
        for (let o = 0; o < 8; o++) next.push(first + o, ci + (o & 1) * s, cj + ((o >> 1) & 1) * s, ck + (o >> 2) * s, s);
      } else {
        nodes[node] = (LEAF | (leaves.length / 4)) >>> 0;
        leaves.push(ci, cj, ck, cs);
      }
    }
    level = next;
  }

  // Unique leaf corners, evaluated once.
  const nLeaves = leaves.length / 4;
  const keys = new Float64Array(nLeaves * 8);
  for (let l = 0; l < nLeaves; l++) {
    const i = leaves[4 * l], j = leaves[4 * l + 1], k = leaves[4 * l + 2], s = leaves[4 * l + 3];
    for (let o = 0; o < 8; o++) keys[8 * l + o] = cornerKey(i + (o & 1) * s, j + ((o >> 1) & 1) * s, k + (o >> 2) * s);
  }
  const sorted = keys.slice().sort();
  let u = 0;
  for (let n = 0; n < sorted.length; n++) if (n === 0 || sorted[n] !== sorted[u - 1]) sorted[u++] = sorted[n];
  const unique = sorted.subarray(0, u);
  const uniqueValues = new Float64Array(u);
  let minValue = 0, maxAbs = 0;
  for (let n = 0; n < u; n++) {
    const key = unique[n];
    const k = key % KEY, ij = (key - k) / KEY, j = ij % KEY, i = (ij - j) / KEY;
    const v = sdf.signed(ox + i * leafSize, oy + j * leafSize, oz + k * leafSize);
    uniqueValues[n] = v;
    minValue = Math.min(minValue, v);
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  const values = new Float32Array(nLeaves * 8);
  for (let n = 0; n < keys.length; n++) {
    // Binary search for the key.
    let a = 0, b = u - 1;
    const key = keys[n];
    while (a < b) {
      const m = (a + b) >> 1;
      if (unique[m] < key) a = m + 1;
      else b = m;
    }
    values[n] = uniqueValues[a];
  }
  return { index: task.index, nodes: Uint32Array.from(nodes), values, minValue, maxAbs };
}

/** The finished octree: a query structure over stitched subtrees. */
export class OctreeSDF {
  constructor(
    readonly layout: OctreeLayout,
    /** Internal: index of the first of 8 children; leaf: LEAF | leaf index. */
    readonly nodes: Uint32Array,
    /** 8 quantized corner values per leaf. */
    readonly values: Int16Array,
    /** Metres per quantization step. */
    readonly quantum: number,
    /** Most negative SDF value: minus the largest inscribed radius (about). */
    readonly minValue: number,
    /** Bounding box, for queries outside the root cube. */
    readonly meshLo: ArrayLike<number>,
    readonly meshHi: ArrayLike<number>,
  ) {}

  get leafCount() {
    return this.values.length / 8;
  }
  get bytes() {
    return this.nodes.byteLength + this.values.byteLength;
  }

  /** Signed distance at p (trilinear in its leaf). */
  sample(x: number, y: number, z: number): number {
    const { origin, size } = this.layout;
    let tx = (x - origin[0]) / size, ty = (y - origin[1]) / size, tz = (z - origin[2]) / size;
    if (!(tx >= 0 && ty >= 0 && tz >= 0 && tx < 1 && ty < 1 && tz < 1)) {
      // Outside the domain, which extends past the guidance range: a lower bound is enough.
      const lo = this.meshLo, hi = this.meshHi;
      const dx = Math.max(lo[0] - x, 0, x - hi[0]), dy = Math.max(lo[1] - y, 0, y - hi[1]), dz = Math.max(lo[2] - z, 0, z - hi[2]);
      return Math.hypot(dx, dy, dz);
    }
    const N = this.nodes;
    let n = N[0];
    while (!(n & LEAF)) {
      tx *= 2;
      ty *= 2;
      tz *= 2;
      let o = 0;
      if (tx >= 1) (o |= 1), (tx -= 1);
      if (ty >= 1) (o |= 2), (ty -= 1);
      if (tz >= 1) (o |= 4), (tz -= 1);
      n = N[n + o];
    }
    const V = this.values, b = 8 * (n & ~LEAF);
    const x0 = V[b] + (V[b + 1] - V[b]) * tx, x1 = V[b + 2] + (V[b + 3] - V[b + 2]) * tx;
    const x2 = V[b + 4] + (V[b + 5] - V[b + 4]) * tx, x3 = V[b + 6] + (V[b + 7] - V[b + 6]) * tx;
    const y0 = x0 + (x1 - x0) * ty, y1 = x2 + (x3 - x2) * ty;
    return (y0 + (y1 - y0) * tz) * this.quantum;
  }
}

/** Stitch the 64 subtrees under the always-split top levels and quantize. */
export function assembleOctree(
  layout: OctreeLayout,
  results: SubtreeResult[],
  meshLo: ArrayLike<number>,
  meshHi: ArrayLike<number>,
): OctreeSDF {
  const byIndex = [...results].sort((a, b) => a.index - b.index);
  const top = 1 + 8; // root + level 1; level-2 slots are 9..72 (the subtree roots)
  const nTasks = byIndex.length;
  let nodeCount = top + nTasks, leafCount = 0;
  for (const r of byIndex) {
    nodeCount += r.nodes.length - 1;
    leafCount += r.values.length / 8;
  }
  const nodes = new Uint32Array(nodeCount);
  nodes[0] = 1;
  for (let c = 0; c < 8; c++) nodes[1 + c] = top + 8 * c;
  let maxAbs = 1e-6, minValue = 0;
  for (const r of byIndex) {
    maxAbs = Math.max(maxAbs, r.maxAbs);
    minValue = Math.min(minValue, r.minValue);
  }
  const quantum = maxAbs / 32767;
  const values = new Int16Array(leafCount * 8);
  let base = top + nTasks, leafBase = 0;
  for (const r of byIndex) {
    const L = r.nodes;
    const map = (j: number) => (j === 0 ? top + r.index : base + j - 1);
    for (let j = 0; j < L.length; j++) {
      const v = L[j];
      nodes[map(j)] = v & LEAF ? (LEAF | (leafBase + (v & ~LEAF))) >>> 0 : map(v);
    }
    for (let n = 0; n < r.values.length; n++) values[8 * leafBase + n] = Math.round(r.values[n] / quantum);
    base += L.length - 1;
    leafBase += r.values.length / 8;
  }
  return new OctreeSDF(layout, nodes, values, quantum, minValue, meshLo, meshHi);
}
