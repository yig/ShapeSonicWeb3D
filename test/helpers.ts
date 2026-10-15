import { readFileSync } from 'node:fs';
import { parseOBJ, prepareMesh } from '../src/geometry/mesh';
import { buildShapeSync, DEFAULT_BUILD, type Shape } from '../src/geometry/shape';

const shapes = new Map<string, Shape>();
/** A demo model built at 0.4 m (cached per test file). */
export function demoShape(name: string, sharpAngle = 30): Shape {
  let s = shapes.get(name);
  if (!s) shapes.set(name, (s = buildShapeSync(prepareMesh(parseOBJ(readFileSync(`models/${name}.obj`, 'utf8')), 0.4), DEFAULT_BUILD)));
  if (s.sharpAngleDeg !== sharpAngle) s.detectFeatures(sharpAngle);
  return s;
}

