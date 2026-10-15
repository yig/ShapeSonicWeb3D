// Triangle meshes: OBJ parsing, welding, normalization, orientation and the
// angle-weighted pseudonormals used for the SDF sign (Bærentzen and Aanæs 2005).
// All lengths are metres; coordinates are float64 (plain JS numbers).

/** Vertices (xyz triples) and triangles (index triples), as loaded. */
export interface TriangleSoup {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** A welded, normalized, outward-oriented mesh with the normals the SDF needs. */
export interface Mesh {
  verts: Float64Array; // 3 per vertex
  tris: Uint32Array; // 3 per triangle
  faceNormals: Float64Array; // 3 per triangle, unit
  /** 3 per triangle edge (ab, bc, ca), unnormalized sum of the adjacent face normals. */
  edgeNormals: Float64Array; // 9 per triangle
  /** Angle-weighted vertex pseudonormals, unnormalized. */
  vertexNormals: Float64Array;
  /** Every edge has exactly two faces. */
  watertight: boolean;
  lo: [number, number, number];
  hi: [number, number, number];
  /** Model units → metres factor applied by normalize (1 if units were kept). */
  scale: number;
  /** Longest bounding-box side of the model in its own units, before scaling. */
  sourceSize: number;
}

export class MeshError extends Error {}

/**
 * Wavefront OBJ: `v` and `f` records (with v/vt/vn forms, negative relative
 * indices, polygons fan-triangulated). Everything else is ignored.
 */
export function parseOBJ(text: string): TriangleSoup {
  const positions: number[] = [];
  const indices: number[] = [];
  const poly: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line.length < 2) continue;
    const c0 = line[0], c1 = line[1];
    if (c1 !== ' ' && c1 !== '\t') continue;
    if (c0 === 'v') {
      const parts = line.split(/\s+/);
      if (parts.length < 4) throw new MeshError(`Bad vertex on line ${n + 1}.`);
      for (let k = 1; k <= 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v)) throw new MeshError(`Bad vertex on line ${n + 1}.`);
        positions.push(v);
      }
    } else if (c0 === 'f') {
      poly.length = 0;
      const nv = positions.length / 3;
      const parts = line.split(/\s+/);
      for (let k = 1; k < parts.length; k++) {
        const v = parseInt(parts[k], 10); // stops at the first '/'
        if (Number.isNaN(v)) break;
        const i = v > 0 ? v - 1 : nv + v;
        if (v === 0 || i < 0 || i >= nv) throw new MeshError(`Bad face index on line ${n + 1}.`);
        poly.push(i);
      }
      for (let k = 2; k < poly.length; k++) indices.push(poly[0], poly[k - 1], poly[k]);
    }
  }
  if (!indices.length) throw new MeshError('The model has no faces.');
  return { positions, indices };
}

const edgeKey = (a: number, b: number) => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a);

/**
 * Weld coincident vertices (to 1e-6 of the diagonal), drop degenerate
 * triangles and unreferenced vertices, centre the bounding box on the origin,
 * scale the longest side to `fitSize` (0 keeps the units), orient outward
 * (flip if the signed volume is negative), and compute the pseudonormals.
 */
export function prepareMesh(soup: TriangleSoup, fitSize: number): Mesh {
  const P = soup.positions, I = soup.indices;
  const nv0 = Math.floor(P.length / 3);
  if (!I.length) throw new MeshError('The model has no triangles.');
  for (let i = 0; i < I.length; i++) {
    if (!(I[i] >= 0 && I[i] < nv0)) throw new MeshError('Triangle index out of range.');
  }
  const lo0 = [Infinity, Infinity, Infinity], hi0 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < I.length; i++) {
    for (let k = 0; k < 3; k++) {
      const x = P[3 * I[i] + k];
      if (!Number.isFinite(x)) throw new MeshError('The model has invalid coordinates.');
      if (x < lo0[k]) lo0[k] = x;
      if (x > hi0[k]) hi0[k] = x;
    }
  }
  const diag = Math.hypot(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
  const eps = Math.max(diag * 1e-6, 1e-12);

  // Weld.
  const ids = new Map<string, number>();
  const remap = new Int32Array(nv0).fill(-1);
  const welded: number[] = [];
  const weldedIndex = (v: number) => {
    if (remap[v] >= 0) return remap[v];
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      ids.set(key, id);
      welded.push(x, y, z);
    }
    return (remap[v] = id);
  };
  const tris0: number[] = [];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = weldedIndex(I[t]), b = weldedIndex(I[t + 1]), c = weldedIndex(I[t + 2]);
    if (a !== b && b !== c && c !== a) tris0.push(a, b, c);
  }
  if (!tris0.length) throw new MeshError('The model has only degenerate triangles.');
  // Drop unreferenced vertices.
  const used = new Int32Array(welded.length / 3).fill(-1);
  const vlist: number[] = [];
  const tris = new Uint32Array(tris0.length);
  for (let i = 0; i < tris0.length; i++) {
    const v = tris0[i];
    if (used[v] < 0) {
      used[v] = vlist.length / 3;
      vlist.push(welded[3 * v], welded[3 * v + 1], welded[3 * v + 2]);
    }
    tris[i] = used[v];
  }

  // Normalize.
  const center = [0, 1, 2].map((k) => 0.5 * (lo0[k] + hi0[k]));
  const longest = Math.max(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
  if (!(longest > 0)) throw new MeshError('The model is flat or empty.');
  const scale = fitSize > 0 ? fitSize / longest : 1;
  const verts = new Float64Array(vlist.length);
  for (let i = 0; i < vlist.length; i++) verts[i] = (vlist[i] - center[i % 3]) * scale;
  const lo = [0, 1, 2].map((k) => (lo0[k] - center[k]) * scale) as [number, number, number];
  const hi = [0, 1, 2].map((k) => (hi0[k] - center[k]) * scale) as [number, number, number];

  // Orient outward.
  let volume = 0;
  const nt = tris.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = 3 * tris[3 * t], b = 3 * tris[3 * t + 1], c = 3 * tris[3 * t + 2];
    volume +=
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) +
      verts[a + 1] * (verts[b + 2] * verts[c] - verts[b] * verts[c + 2]) +
      verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  if (volume < 0) {
    for (let t = 0; t < nt; t++) {
      const tmp = tris[3 * t + 1];
      tris[3 * t + 1] = tris[3 * t + 2];
      tris[3 * t + 2] = tmp;
    }
  }

  const mesh: Mesh = {
    verts,
    tris,
    faceNormals: new Float64Array(3 * nt),
    edgeNormals: new Float64Array(9 * nt),
    vertexNormals: new Float64Array(verts.length),
    watertight: true,
    lo,
    hi,
    scale,
    sourceSize: longest,
  };
  computeNormals(mesh);
  return mesh;
}

function computeNormals(m: Mesh) {
  const { verts: V, tris: T, faceNormals: FN, edgeNormals: EN, vertexNormals: VN } = m;
  const nt = T.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) (nx /= l), (ny /= l), (nz /= l);
    FN[3 * t] = nx;
    FN[3 * t + 1] = ny;
    FN[3 * t + 2] = nz;
  }
  // Edge pseudonormals: sum of the adjacent faces' normals.
  const edges = new Map<number, { n: [number, number, number]; count: number }>();
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(T[3 * t + e], T[3 * t + ((e + 1) % 3)]);
      let entry = edges.get(key);
      if (!entry) edges.set(key, (entry = { n: [0, 0, 0], count: 0 }));
      entry.n[0] += FN[3 * t];
      entry.n[1] += FN[3 * t + 1];
      entry.n[2] += FN[3 * t + 2];
      entry.count++;
    }
  }
  m.watertight = true;
  for (const entry of edges.values()) if (entry.count !== 2) m.watertight = false;
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const n = edges.get(edgeKey(T[3 * t + e], T[3 * t + ((e + 1) % 3)]))!.n;
      EN[9 * t + 3 * e] = n[0];
      EN[9 * t + 3 * e + 1] = n[1];
      EN[9 * t + 3 * e + 2] = n[2];
    }
  }
  // Vertex pseudonormals: face normals weighted by the face's angle at the vertex.
  const angles = cornerAngles(m);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = T[3 * t + k], w = angles[3 * t + k];
      VN[3 * v] += FN[3 * t] * w;
      VN[3 * v + 1] += FN[3 * t + 1] * w;
      VN[3 * v + 2] += FN[3 * t + 2] * w;
    }
  }
}

/** Each triangle's interior angle at each of its 3 vertices. */
export function cornerAngles(m: Pick<Mesh, 'verts' | 'tris'>): Float64Array {
  const { verts: V, tris: T } = m;
  const out = new Float64Array(T.length);
  for (let t = 0; t < T.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const o = 3 * T[3 * t + k], p = 3 * T[3 * t + ((k + 1) % 3)], q = 3 * T[3 * t + ((k + 2) % 3)];
      const ax = V[p] - V[o], ay = V[p + 1] - V[o + 1], az = V[p + 2] - V[o + 2];
      const bx = V[q] - V[o], by = V[q + 1] - V[o + 1], bz = V[q + 2] - V[o + 2];
      const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
      const c = la > 0 && lb > 0 ? (ax * bx + ay * by + az * bz) / (la * lb) : 1;
      out[3 * t + k] = Math.acos(Math.min(1, Math.max(-1, c)));
    }
  }
  return out;
}

export { edgeKey };
