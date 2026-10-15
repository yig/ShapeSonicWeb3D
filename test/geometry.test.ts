import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExactSDF, insideByRays } from '../src/geometry/bvh';
import { MeshError, parseOBJ, prepareMesh } from '../src/geometry/mesh';
import { demoShape } from './helpers';

const MODELS = readdirSync('models').filter((f) => f.endsWith('.obj')).map((f) => f.replace('.obj', ''));

function random(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

describe('OBJ parsing', () => {
  it('reads quads, v//vn, v/vt/vn, negative indices and CRLF', () => {
    const obj = 'v 0 0 0\r\nv 1 0 0\r\nv 1 1 0\r\nv 0 1 0\r\nvn 0 0 1\r\nf 1//1 2//1 3//1 4//1\r\nf -4/1/1 -2/1/1 -1/1/1\r\n';
    const soup = parseOBJ(obj);
    expect(soup.positions.length).toBe(12);
    expect(Array.from(soup.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 2, 3]);
  });
  it('rejects bad indices and empty files', () => {
    expect(() => parseOBJ('v 0 0 0\nf 1 2 3\n')).toThrow(MeshError);
    expect(() => parseOBJ('# nothing\n')).toThrow(MeshError);
  });
  it('welds, normalizes to the fit size and orients outward', () => {
    // An inward-facing cube made of separate (unwelded) triangles, 2 units wide.
    const cube = prepareMesh(parseOBJ(readFileSync('models/cube.obj', 'utf8')), 0.4);
    const flipped = { positions: [] as number[], indices: [] as number[] };
    for (let t = 0; t < cube.tris.length; t += 3) {
      for (const k of [0, 2, 1]) {
        const v = cube.tris[t + k];
        flipped.indices.push(flipped.positions.length / 3);
        flipped.positions.push(cube.verts[3 * v] * 5 + 7, cube.verts[3 * v + 1] * 5, cube.verts[3 * v + 2] * 5);
      }
    }
    const m = prepareMesh(flipped, 0.3);
    expect(m.verts.length / 3).toBe(8);
    expect(m.watertight).toBe(true);
    expect(m.hi[0] - m.lo[0]).toBeCloseTo(0.3, 6);
    expect(m.lo[0]).toBeCloseTo(-0.15, 6);
    expect(new ExactSDF(m).signed(0, 0, 0)).toBeCloseTo(-0.15, 6);
  });
});

describe.each(MODELS)('model %s', (name) => {
  it('is watertight; the octree matches the exact SDF; signs agree with ray parity', () => {
    const shape = demoShape(name);
    const mesh = shape.mesh;
    expect(mesh.watertight).toBe(true);
    const exact = new ExactSDF(mesh);
    const rand = random(12345);
    const range = -shape.minSDF;
    let worst = { near: 0, mid: 0, far: 0, inside: 0 };
    for (let n = 0; n < 5000; n++) {
      const p = [0, 1, 2].map((a) => mesh.lo[a] - 0.1 + rand() * (mesh.hi[a] - mesh.lo[a] + 0.2));
      const e = exact.signed(p[0], p[1], p[2]);
      const err = Math.abs(shape.sdf(p[0], p[1], p[2]) - e);
      if (Math.abs(e) <= 0.002) worst.near = Math.max(worst.near, err);
      else if (Math.abs(e) <= 0.01) worst.mid = Math.max(worst.mid, err);
      else if (e > 0) worst.far = Math.max(worst.far, err);
      else worst.inside = Math.max(worst.inside, err / range);
      if (Math.abs(e) > 1e-4) expect(e < 0, `sign at ${p}`).toBe(insideByRays(exact.bvh, p[0], p[1], p[2]));
    }
    expect(worst.near).toBeLessThan(0.001);
    expect(worst.mid).toBeLessThan(0.003);
    expect(worst.far).toBeLessThan(0.01);
    expect(worst.inside).toBeLessThan(0.08);
  });
});

describe('features', () => {
  it.each([
    ['cube', 12, 8],
    ['sphere', 0, 0],
    ['torus', 0, 0],
    ['cone', 32, 1],
  ])('%s has %i sharp edges and %i corners', (name, edges, corners) => {
    const s = demoShape(name);
    expect(s.edgeCount).toBe(edges);
    expect(s.cornerCount).toBe(corners);
  });
  it('re-detects with a new threshold', () => {
    const cube = demoShape('cube', 100);
    expect(cube.edgeCount).toBe(0);
    expect(cube.cornerCount).toBe(8); // still corners: each has a 90° angle deficit
    cube.detectFeatures(30);
    expect(cube.edgeCount).toBe(12);
  });
  it('measures distances to edges and corners within range', () => {
    const cube = demoShape('cube');
    expect(cube.cornerDistance(0.2, 0.2, 0.21, 0.02)).toBeCloseTo(0.01, 4);
    expect(cube.edgeDistance(0.2, 0.2, 0, 0.02)).toBeCloseTo(0, 4);
    expect(cube.edgeDistance(0, 0, 0.2, 0.02)).toBe(Infinity);
  });
});
