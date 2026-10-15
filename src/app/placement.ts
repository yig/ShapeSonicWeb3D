// Where the invisible shape is: a rigid placement plus a uniform scale, in the
// world frame (three.js axes: +y up, −z forward from the camera or headset at
// the origin). The shape's own frame is its build frame (centred, +y up, +z
// its front), scaled by `scale` = display size / build size.

export interface Placement {
  /** Centre in world coordinates (m). */
  x: number;
  y: number;
  z: number;
  /** Rotation about +y (radians); 0 = the shape's front (+z) faces +z (toward a headset user). */
  yaw: number;
  /** Display size / build size. */
  scale: number;
}

/** World point → build frame. */
export function toShape(p: Placement, x: number, y: number, z: number): [number, number, number] {
  const dx = x - p.x, dy = y - p.y, dz = z - p.z;
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  // Inverse of R_y(yaw): rotate by −yaw.
  return [(c * dx - s * dz) / p.scale, dy / p.scale, (s * dx + c * dz) / p.scale];
}

/**
 * The default placement for a hand source. A webcam faces the user, who is
 * behind the hands (−z), so the shape's front turns toward −z; it sits 50 cm
 * from the camera and a little below it, where hands usually are in front of a
 * laptop. A headset user looks along −z from the origin: the shape is 45 cm in
 * front, a little below eye level, its front toward them.
 */
export function defaultPlacement(source: 'camera' | 'mouse' | 'xr', scale: number): Placement {
  return source === 'xr'
    ? { x: 0, y: -0.25, z: -0.45, yaw: 0, scale }
    : { x: 0, y: -0.12, z: -0.5, yaw: Math.PI, scale };
}
