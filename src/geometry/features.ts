// Sharp edges and corners, in the spirit of libigl's sharp_edges as used in
// the paper (a port of the iOS core's detect_features):
// * an edge is sharp if the angle between its two faces' normals exceeds the
//   threshold; boundary and non-manifold edges count as sharp;
// * a vertex is a corner if 3 or more sharp edges meet there, if a chain of
//   sharp edges turns there by more than the threshold, or if it is a
//   cone-like point whose angle deficit |2π − Σ face angles| exceeds 70°
//   (the apex of a cone has no sharp edges).

import { cornerAngles, edgeKey, type Mesh } from './mesh';

const CORNER_DEFICIT_DEG = 70;
/** Hash-grid cell for feature queries (m); a range-limited query checks 27 cells. */
const FEATURE_CELL = 0.02;

export interface Features {
  /** Pairs of endpoints: 6 numbers per sharp edge. */
  edges: Float32Array;
  /** 3 numbers per corner. */
  corners: Float32Array;
}

export function detectFeatures(mesh: Mesh, sharpAngleDeg: number): Features {
  const { verts: V, tris: T, faceNormals: FN } = mesh;
  const cosSharp = Math.cos((sharpAngleDeg * Math.PI) / 180);
  const nv = V.length / 3, nt = T.length / 3;
  const edgeFaces = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(T[3 * t + e], T[3 * t + ((e + 1) % 3)]);
      const list = edgeFaces.get(key);
      if (list) list.push(t);
      else edgeFaces.set(key, [t]);
    }
  }
  const sharpNbrs: number[][] = Array.from({ length: nv }, () => []);
  const boundary = new Uint8Array(nv);
  const edges: number[] = [];
  for (const [key, faces] of edgeFaces) {
    const a = Math.floor(key / 0x100000000), b = key % 0x100000000;
    let sharp: boolean;
    if (faces.length !== 2) {
      sharp = true;
      boundary[a] = boundary[b] = 1;
    } else {
      const f = 3 * faces[0], g = 3 * faces[1];
      const n0 = FN[f] * FN[f] + FN[f + 1] * FN[f + 1] + FN[f + 2] * FN[f + 2];
      const n1 = FN[g] * FN[g] + FN[g + 1] * FN[g + 1] + FN[g + 2] * FN[g + 2];
      sharp = n0 > 0 && n1 > 0 && FN[f] * FN[g] + FN[f + 1] * FN[g + 1] + FN[f + 2] * FN[g + 2] < cosSharp;
    }
    if (!sharp) continue;
    edges.push(V[3 * a], V[3 * a + 1], V[3 * a + 2], V[3 * b], V[3 * b + 1], V[3 * b + 2]);
    sharpNbrs[a].push(b);
    sharpNbrs[b].push(a);
  }

  const angles = cornerAngles(mesh);
  const angleSum = new Float64Array(nv);
  for (let i = 0; i < T.length; i++) angleSum[T[i]] += angles[i];

  const corners: number[] = [];
  const deficit = (CORNER_DEFICIT_DEG * Math.PI) / 180;
  const unit = (from: number, to: number) => {
    const x = V[3 * to] - V[3 * from], y = V[3 * to + 1] - V[3 * from + 1], z = V[3 * to + 2] - V[3 * from + 2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  for (let v = 0; v < nv; v++) {
    const nb = sharpNbrs[v];
    let corner = nb.length >= 3;
    if (nb.length === 2) {
      const a = unit(v, nb[0]), b = unit(v, nb[1]);
      // A straight chain has a = −b; the turning angle is π − angle(a, b).
      corner = -(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < cosSharp;
    }
    if (!corner && !boundary[v] && Math.abs(2 * Math.PI - angleSum[v]) > deficit) corner = true;
    if (corner) corners.push(V[3 * v], V[3 * v + 1], V[3 * v + 2]);
  }
  return { edges: Float32Array.from(edges), corners: Float32Array.from(corners) };
}

// Numeric cell keys: cell coordinates offset into [0, KEY), i.e. ±80 m at 2 cm cells.
const KEY = 8192, OFF = KEY / 2;
const cellKey = (i: number, j: number, k: number) => ((i + OFF) * KEY + (j + OFF)) * KEY + (k + OFF);

/** Uniform hash grid of segments or points, for range-limited nearest-distance queries. */
export class FeatureGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly count: number;
  /** Bounding box of the features, for an early out. */
  private readonly lo = [Infinity, Infinity, Infinity];
  private readonly hi = [-Infinity, -Infinity, -Infinity];

  /** `pts`: 6 numbers per segment, or 3 per point. */
  constructor(
    private readonly pts: Float32Array,
    private readonly segments: boolean,
    private readonly cell = FEATURE_CELL,
  ) {
    const stride = segments ? 6 : 3;
    this.count = pts.length / stride;
    const f = (x: number) => Math.floor(x / cell);
    for (let s = 0; s < this.count; s++) {
      const o = stride * s;
      const e = segments ? o + 3 : o;
      for (let a = 0; a < 3; a++) {
        this.lo[a] = Math.min(this.lo[a], pts[o + a], pts[e + a]);
        this.hi[a] = Math.max(this.hi[a], pts[o + a], pts[e + a]);
      }
      for (let i = f(Math.min(pts[o], pts[e])); i <= f(Math.max(pts[o], pts[e])); i++)
        for (let j = f(Math.min(pts[o + 1], pts[e + 1])); j <= f(Math.max(pts[o + 1], pts[e + 1])); j++)
          for (let k = f(Math.min(pts[o + 2], pts[e + 2])); k <= f(Math.max(pts[o + 2], pts[e + 2])); k++) {
            const key = cellKey(i, j, k);
            const list = this.cells.get(key);
            if (list) list.push(s);
            else this.cells.set(key, [s]);
          }
    }
  }

  get size() {
    return this.count;
  }

  private dist2(s: number, x: number, y: number, z: number) {
    const P = this.pts;
    if (!this.segments) {
      const dx = x - P[3 * s], dy = y - P[3 * s + 1], dz = z - P[3 * s + 2];
      return dx * dx + dy * dy + dz * dz;
    }
    const o = 6 * s;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const abx = P[o + 3] - ax, aby = P[o + 4] - ay, abz = P[o + 5] - az;
    const l2 = abx * abx + aby * aby + abz * abz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * abx + (y - ay) * aby + (z - az) * abz) / l2)) : 0;
    const dx = x - (ax + abx * t), dy = y - (ay + aby * t), dz = z - (az + abz * t);
    return dx * dx + dy * dy + dz * dz;
  }

  /** Distance to the nearest feature, or Infinity if none is within maxDistance. */
  nearest(x: number, y: number, z: number, maxDistance: number): number {
    if (!this.count) return Infinity;
    const { lo, hi } = this;
    if (
      x < lo[0] - maxDistance || y < lo[1] - maxDistance || z < lo[2] - maxDistance ||
      x > hi[0] + maxDistance || y > hi[1] + maxDistance || z > hi[2] + maxDistance
    )
      return Infinity;
    let best = maxDistance * maxDistance;
    let found = false;
    const r = Math.ceil(maxDistance / this.cell);
    if (r > 3) {
      for (let s = 0; s < this.count; s++) {
        const d2 = this.dist2(s, x, y, z);
        if (d2 < best) (best = d2), (found = true);
      }
    } else {
      const ci = Math.floor(x / this.cell), cj = Math.floor(y / this.cell), ck = Math.floor(z / this.cell);
      for (let i = ci - r; i <= ci + r; i++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let k = ck - r; k <= ck + r; k++) {
            const list = this.cells.get(cellKey(i, j, k));
            if (!list) continue;
            for (const s of list) {
              const d2 = this.dist2(s, x, y, z);
              if (d2 < best) (best = d2), (found = true);
            }
          }
    }
    return found ? Math.sqrt(best) : Infinity;
  }
}
