// Fingertips → per-hand sound levels, following the paper's Method section and
// supplemental Table 1 (the same mapping as the iOS core's sonify.cpp):
//
// | Sound    | plays when                        | x                       | a   | b   | D          |
// |----------|-----------------------------------|-------------------------|-----|-----|------------|
// | Guidance | some fingertip of the hand is out | closest outside SDF     | 0   | 1   | 50 cm      |
// | Contact  | this fingertip is inside          | its depth, −SDF         | 0   | 0.8 | |min SDF|  |
// | Edge     | some fingertip near a sharp edge  | closest edge distance   | 0.6 | 0.4 | 2 cm       |
// | Corner   | some fingertip near a corner      | closest corner distance | 0.6 | 0.4 | 2 cm       |

import type { Shape } from './geometry/shape';

export const HANDS = 2; // 0 = left, 1 = right
export const FINGERS = 5; // thumb, index, middle, ring, little: C D E G A

export interface HandLevels {
  guidance: number;
  contact: number[]; // FINGERS
  edge: number;
  corner: number;
}

export interface Fingertip {
  hand: number; // 0 or 1
  slot: number; // 0..4
  /** Position in the shape's build frame (see Placement.toShape). */
  x: number;
  y: number;
  z: number;
}

export interface FingerProbe {
  /** Metres: signed distance, and edge / corner distance (Infinity when out of range). */
  sdf: number;
  edge: number;
  corner: number;
}

/** Ranges D of the volume falloff, in metres. */
export interface SonifyParams {
  guidanceRange: number;
  /** 0 = |min SDF| (the paper's choice). */
  contactRange: number;
  edgeRange: number;
  cornerRange: number;
}

export const DEFAULT_SONIFY: SonifyParams = { guidanceRange: 0.5, contactRange: 0, edgeRange: 0.02, cornerRange: 0.02 };

/** V(x) = a + b·exp(−5x/D) for 0 ≤ x < D, else 0. */
export function falloff(x: number, range: number, a: number, b: number): number {
  return x >= 0 && x < range ? a + b * Math.exp((-5 * x) / range) : 0;
}

export const silentLevels = (): HandLevels[] =>
  Array.from({ length: HANDS }, () => ({ guidance: 0, contact: new Array(FINGERS).fill(0), edge: 0, corner: 0 }));

/**
 * Measure each fingertip and compute both hands' levels. `scale` is the
 * shape's display scale: real distances are build-frame distances × scale.
 */
export function probe(
  shape: Shape | null,
  scale: number,
  fingers: Fingertip[],
  params: SonifyParams = DEFAULT_SONIFY,
  perFinger?: FingerProbe[],
): HandLevels[] {
  const levels = silentLevels();
  if (perFinger) perFinger.length = 0;
  if (!shape) {
    if (perFinger) for (let i = 0; i < fingers.length; i++) perFinger.push({ sdf: Infinity, edge: Infinity, corner: Infinity });
    return levels;
  }
  const outside = [Infinity, Infinity], edge = [Infinity, Infinity], corner = [Infinity, Infinity];
  const contactRange = params.contactRange > 0 ? params.contactRange : Math.abs(shape.minSDF) * scale;
  for (const f of fingers) {
    if (f.hand < 0 || f.hand >= HANDS) continue;
    const m: FingerProbe = {
      sdf: shape.sdf(f.x, f.y, f.z) * scale,
      edge: shape.edgeDistance(f.x, f.y, f.z, params.edgeRange / scale) * scale,
      corner: shape.cornerDistance(f.x, f.y, f.z, params.cornerRange / scale) * scale,
    };
    perFinger?.push(m);
    if (m.sdf > 0) outside[f.hand] = Math.min(outside[f.hand], m.sdf);
    else if (f.slot >= 0 && f.slot < FINGERS) levels[f.hand].contact[f.slot] = falloff(-m.sdf, contactRange, 0, 0.8);
    edge[f.hand] = Math.min(edge[f.hand], m.edge);
    corner[f.hand] = Math.min(corner[f.hand], m.corner);
  }
  for (let h = 0; h < HANDS; h++) {
    levels[h].guidance = falloff(outside[h], params.guidanceRange, 0, 1);
    levels[h].edge = falloff(edge[h], params.edgeRange, 0.6, 0.4);
    levels[h].corner = falloff(corner[h], params.cornerRange, 0.6, 0.4);
  }
  return levels;
}
