import { describe, expect, it } from 'vitest';
import { falloff, probe, type Fingertip } from '../src/sonify';
import { demoShape } from './helpers';

const finger = (hand: number, slot: number, x: number, y: number, z: number): Fingertip => ({ hand, slot, x, y, z });

describe('probe on the cube (0.4 m, scale 1)', () => {
  const cube = demoShape('cube');
  it('contact is loud just inside and quiet at the centre', () => {
    const [left] = probe(cube, 1, [finger(0, 1, 0, 0, 0.195), finger(0, 2, 0, 0, 0)]);
    expect(left.contact[1]).toBeGreaterThan(0.6);
    expect(left.contact[2]).toBeLessThan(0.01);
    expect(left.guidance).toBe(0); // no fingertip of this hand is outside
  });
  it('guidance follows the falloff outside, per hand', () => {
    const [left, right] = probe(cube, 1, [finger(1, 0, 0, 0, 0.3)]);
    expect(left.guidance).toBe(0);
    expect(right.guidance).toBeCloseTo(falloff(0.1, 0.5, 0, 1), 3);
    expect(right.contact.every((c) => c === 0)).toBe(true);
  });
  it('a corner plays contact, edge and corner; an edge only edge', () => {
    const [, corner] = probe(cube, 1, [finger(1, 1, 0.195, 0.195, 0.195)]);
    expect(corner.contact[1]).toBeGreaterThan(0);
    expect(corner.edge).toBeGreaterThan(0.6);
    expect(corner.corner).toBeGreaterThan(0.6);
    const [, edge] = probe(cube, 1, [finger(1, 1, 0.205, 0.205, 0)]);
    expect(edge.edge).toBeGreaterThan(0.6);
    expect(edge.corner).toBe(0);
  });
  it('scales distances with the display scale', () => {
    // At scale 0.5 the cube is 0.2 m: a point 0.15 m out in build units is 0.075 m out for real.
    const [, r] = probe(cube, 0.5, [finger(1, 0, 0, 0, 0.35)]);
    expect(r.guidance).toBeCloseTo(falloff(0.075, 0.5, 0, 1), 3);
  });
});
