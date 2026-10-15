// A shape ready for sonification: the prepared mesh, its octree SDF and its
// sharp edges and corners, with the distance queries the probe needs. Shape
// coordinates are metres in the shape's local frame (centred on its bounding
// box, +y up, +z its front).

import { ExactSDF } from './bvh';
import { detectFeatures, FeatureGrid, type Features } from './features';
import type { Mesh } from './mesh';
import { assembleOctree, buildSubtree, octreeLayout, subtreeTasks, type OctreeLayout, type OctreeSDF } from './octree';

export interface BuildOptions {
  /** Longest bounding-box side the mesh is normalized to (m). The paper's study shapes fit 0.4 m. */
  fitSize: number;
  /** Finest octree cell (m). */
  leafSize: number;
  /** SDF domain margin around the bounding box (m): the guidance range. */
  margin: number;
}

export const DEFAULT_BUILD: BuildOptions = { fitSize: 0.4, leafSize: 0.002, margin: 0.5 };

export class Shape {
  features: Features = { edges: new Float32Array(), corners: new Float32Array() };
  private edgeGrid = new FeatureGrid(new Float32Array(), true);
  private cornerGrid = new FeatureGrid(new Float32Array(), false);
  sharpAngleDeg = 30;

  constructor(
    readonly mesh: Mesh,
    readonly octree: OctreeSDF,
    readonly buildSeconds: number,
    sharpAngleDeg: number,
  ) {
    this.detectFeatures(sharpAngleDeg);
  }

  /** (Re-)detect sharp edges and corners with a new threshold (fast: mesh only). */
  detectFeatures(sharpAngleDeg: number) {
    this.sharpAngleDeg = sharpAngleDeg;
    this.features = detectFeatures(this.mesh, sharpAngleDeg);
    this.edgeGrid = new FeatureGrid(this.features.edges, true);
    this.cornerGrid = new FeatureGrid(this.features.corners, false);
  }

  get edgeCount() {
    return this.features.edges.length / 6;
  }
  get cornerCount() {
    return this.features.corners.length / 3;
  }
  /** Most negative SDF value: minus the largest inscribed radius. */
  get minSDF() {
    return this.octree.minValue;
  }

  sdf(x: number, y: number, z: number) {
    return this.octree.sample(x, y, z);
  }
  edgeDistance(x: number, y: number, z: number, maxDistance: number) {
    return this.edgeGrid.nearest(x, y, z, maxDistance);
  }
  cornerDistance(x: number, y: number, z: number, maxDistance: number) {
    return this.cornerGrid.nearest(x, y, z, maxDistance);
  }
}

export function layoutFor(mesh: Mesh, options: BuildOptions): OctreeLayout {
  return octreeLayout(mesh.lo, mesh.hi, options.margin, options.leafSize);
}

/** Build on this thread (tests, and a fallback where workers are unavailable). */
export function buildShapeSync(mesh: Mesh, options: BuildOptions = DEFAULT_BUILD, sharpAngleDeg = 30): Shape {
  const start = performance.now();
  const layout = layoutFor(mesh, options);
  const exact = new ExactSDF(mesh);
  const results = subtreeTasks(layout).map((task) => buildSubtree(layout, task, exact));
  const octree = assembleOctree(layout, results, mesh.lo, mesh.hi);
  return new Shape(mesh, octree, (performance.now() - start) / 1000, sharpAngleDeg);
}
