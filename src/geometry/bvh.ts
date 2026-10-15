// Exact distances to a triangle mesh: a BVH (median split on the longest
// centroid axis, 4 triangles per leaf, nearest-first traversal), Ericson's
// closest point on a triangle (which also reports the closest feature), and
// the sign from that feature's pseudonormal.

import type { Mesh } from './mesh';

const LEAF_TRIS = 4;

/** Result of a closest-point query (reused between calls to avoid allocation). */
export interface Closest {
  d2: number;
  tri: number;
  /** 0 face; 1, 2, 3 edges ab, bc, ca; 4, 5, 6 vertices a, b, c. */
  region: number;
  x: number;
  y: number;
  z: number;
}

export const newClosest = (): Closest => ({ d2: Infinity, tri: -1, region: 0, x: 0, y: 0, z: 0 });

// Scratch output of closestOnTriangle.
const cq = { x: 0, y: 0, z: 0, region: 0 };

/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection, 5.1.5), into `cq`. */
function closestOnTriangle(V: Float64Array, ia: number, ib: number, ic: number, px: number, py: number, pz: number) {
  const ax = V[ia], ay = V[ia + 1], az = V[ia + 2];
  const bx = V[ib], by = V[ib + 1], bz = V[ib + 2];
  const cx = V[ic], cy = V[ic + 1], cz = V[ic + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az, 4);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz, 5);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v, 1);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz, 6);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w, 3);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w, 2);
  }
  const denom = va + vb + vc;
  if (!(denom > 0)) return set(ax, ay, az, 4); // degenerate triangle
  const v = vb / denom, w = vc / denom;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w, 0);
}
function set(x: number, y: number, z: number, region: number) {
  cq.x = x;
  cq.y = y;
  cq.z = z;
  cq.region = region;
}

export class BVH {
  readonly mesh: Mesh;
  private bounds: Float64Array; // 6 per node: lo xyz, hi xyz
  private first: Uint32Array; // leaf: first index into order; internal: right child (left = this + 1)
  private count: Uint32Array; // > 0 for leaves
  private order: Uint32Array;
  private nodeCount = 0;
  private stack = new Uint32Array(128);

  constructor(mesh: Mesh) {
    this.mesh = mesh;
    const nt = mesh.tris.length / 3;
    const maxNodes = Math.max(1, 2 * Math.ceil(nt / LEAF_TRIS) + 1) * 2;
    this.bounds = new Float64Array(6 * maxNodes);
    this.first = new Uint32Array(maxNodes);
    this.count = new Uint32Array(maxNodes);
    this.order = new Uint32Array(nt);
    const centroids = new Float64Array(3 * nt);
    const { verts: V, tris: T } = mesh;
    for (let t = 0; t < nt; t++) {
      this.order[t] = t;
      for (let k = 0; k < 3; k++) centroids[3 * t + k] = (V[3 * T[3 * t] + k] + V[3 * T[3 * t + 1] + k] + V[3 * T[3 * t + 2] + k]) / 3;
    }
    if (nt) this.buildNode(0, nt, centroids);
  }

  private buildNode(begin: number, end: number, centroids: Float64Array): number {
    const index = this.nodeCount++;
    const { verts: V, tris: T } = this.mesh;
    const b = this.bounds;
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    let clx = Infinity, cly = Infinity, clz = Infinity, chx = -Infinity, chy = -Infinity, chz = -Infinity;
    for (let i = begin; i < end; i++) {
      const t = this.order[i];
      for (let k = 0; k < 3; k++) {
        const v = 3 * T[3 * t + k];
        lx = Math.min(lx, V[v]); ly = Math.min(ly, V[v + 1]); lz = Math.min(lz, V[v + 2]);
        hx = Math.max(hx, V[v]); hy = Math.max(hy, V[v + 1]); hz = Math.max(hz, V[v + 2]);
      }
      const c = 3 * t;
      clx = Math.min(clx, centroids[c]); cly = Math.min(cly, centroids[c + 1]); clz = Math.min(clz, centroids[c + 2]);
      chx = Math.max(chx, centroids[c]); chy = Math.max(chy, centroids[c + 1]); chz = Math.max(chz, centroids[c + 2]);
    }
    b.set([lx, ly, lz, hx, hy, hz], 6 * index);
    if (end - begin <= LEAF_TRIS) {
      this.first[index] = begin;
      this.count[index] = end - begin;
      return index;
    }
    const ex = chx - clx, ey = chy - cly, ez = chz - clz;
    const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2;
    const mid = (begin + end) >> 1;
    const sub = Array.from(this.order.subarray(begin, end));
    sub.sort((p, q) => centroids[3 * p + axis] - centroids[3 * q + axis]);
    this.order.set(sub, begin);
    this.buildNode(begin, mid, centroids);
    const right = this.buildNode(mid, end, centroids);
    this.first[index] = right;
    this.count[index] = 0;
    return index;
  }

  private boxDist2(node: number, px: number, py: number, pz: number) {
    const b = this.bounds, o = 6 * node;
    const dx = Math.max(b[o] - px, 0, px - b[o + 3]);
    const dy = Math.max(b[o + 1] - py, 0, py - b[o + 4]);
    const dz = Math.max(b[o + 2] - pz, 0, pz - b[o + 5]);
    return dx * dx + dy * dy + dz * dz;
  }

  /** Nearest triangle to p, written into `out` (d2 = squared distance). */
  closest(px: number, py: number, pz: number, out: Closest = newClosest()): Closest {
    out.d2 = Infinity;
    out.tri = -1;
    if (!this.nodeCount) return out;
    const { verts: V, tris: T } = this.mesh;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const n = stack[--top];
      if (this.boxDist2(n, px, py, pz) >= out.d2) continue;
      const count = this.count[n];
      if (count) {
        for (let i = this.first[n]; i < this.first[n] + count; i++) {
          const t = this.order[i];
          closestOnTriangle(V, 3 * T[3 * t], 3 * T[3 * t + 1], 3 * T[3 * t + 2], px, py, pz);
          const dx = px - cq.x, dy = py - cq.y, dz = pz - cq.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < out.d2) {
            out.d2 = d2;
            out.tri = t;
            out.region = cq.region;
            out.x = cq.x;
            out.y = cq.y;
            out.z = cq.z;
          }
        }
        continue;
      }
      let left = n + 1, right = this.first[n];
      let dl = this.boxDist2(left, px, py, pz), dr = this.boxDist2(right, px, py, pz);
      // Push the farther child first so the nearer one is visited first.
      if (dl < dr) {
        [left, right] = [right, left];
        [dl, dr] = [dr, dl];
      }
      if (dl < out.d2 && top < stack.length) stack[top++] = left;
      if (dr < out.d2 && top < stack.length) stack[top++] = right;
    }
    return out;
  }

  /** Number of triangles hit by the ray p + t·d, t > 0. */
  countHits(px: number, py: number, pz: number, dx: number, dy: number, dz: number): number {
    if (!this.nodeCount) return 0;
    const { verts: V, tris: T } = this.mesh;
    const b = this.bounds;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const stack = this.stack;
    let hits = 0, top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const n = stack[--top], o = 6 * n;
      let t0 = 0, t1 = Infinity;
      let a = (b[o] - px) * ix, c = (b[o + 3] - px) * ix;
      t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
      a = (b[o + 1] - py) * iy; c = (b[o + 4] - py) * iy;
      t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
      a = (b[o + 2] - pz) * iz; c = (b[o + 5] - pz) * iz;
      t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
      if (t0 > t1) continue;
      const count = this.count[n];
      if (count) {
        for (let i = this.first[n]; i < this.first[n] + count; i++) {
          const t = this.order[i];
          const va = 3 * T[3 * t], vb = 3 * T[3 * t + 1], vc = 3 * T[3 * t + 2];
          const e1x = V[vb] - V[va], e1y = V[vb + 1] - V[va + 1], e1z = V[vb + 2] - V[va + 2];
          const e2x = V[vc] - V[va], e2y = V[vc + 1] - V[va + 1], e2z = V[vc + 2] - V[va + 2];
          const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (Math.abs(det) < 1e-18) continue;
          const f = 1 / det;
          const sx = px - V[va], sy = py - V[va + 1], sz = pz - V[va + 2];
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = f * (dx * qx + dy * qy + dz * qz);
          if (v < 0 || u + v > 1) continue;
          if (f * (e2x * qx + e2y * qy + e2z * qz) > 0) hits++;
        }
        continue;
      }
      if (top + 2 <= stack.length) {
        stack[top++] = n + 1;
        stack[top++] = this.first[n];
      }
    }
    return hits;
  }
}

// Skewed directions for the ray-parity vote (non-watertight meshes, and tests).
const RAYS = [
  [0.5773, 0.5774, 0.5775],
  [-0.71, 0.31, 0.63],
  [0.23, -0.91, 0.35],
].map((d) => {
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
});

/** Inside by majority vote of 3 ray parities (independent of the pseudonormals). */
export function insideByRays(bvh: BVH, x: number, y: number, z: number): boolean {
  let inside = 0;
  for (const d of RAYS) inside += bvh.countHits(x, y, z, d[0], d[1], d[2]) & 1;
  return inside >= 2;
}

/** Exact signed distance (negative inside), and the unsigned distance alone. */
export class ExactSDF {
  readonly bvh: BVH;
  private readonly q = newClosest();

  constructor(readonly mesh: Mesh) {
    this.bvh = new BVH(mesh);
  }

  unsigned(x: number, y: number, z: number): number {
    return Math.sqrt(this.bvh.closest(x, y, z, this.q).d2);
  }

  signed(x: number, y: number, z: number): number {
    const q = this.bvh.closest(x, y, z, this.q);
    const d = Math.sqrt(q.d2);
    if (!(d > 0)) return 0;
    const m = this.mesh;
    if (m.watertight) {
      const t = q.tri, r = q.region;
      let N: Float64Array, o: number;
      if (r === 0) (N = m.faceNormals), (o = 3 * t);
      else if (r <= 3) (N = m.edgeNormals), (o = 9 * t + 3 * (r - 1));
      else (N = m.vertexNormals), (o = 3 * m.tris[3 * t + (r - 4)]);
      const s = (x - q.x) * N[o] + (y - q.y) * N[o + 1] + (z - q.z) * N[o + 2];
      return s < 0 ? -d : d;
    }
    return insideByRays(this.bvh, x, y, z) ? -d : d;
  }
}
