import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { describe, expect, it } from 'vitest';
import { loadModelFile } from '../src/app/loaders';
import { prepareMesh } from '../src/geometry/mesh';

const box = () => new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
const cubeOf = async (file: File) => prepareMesh(await loadModelFile(file), 0.4);

describe('model loaders', () => {
  it('OBJ', async () => {
    const m = await cubeOf(new File([readFileSync('models/cube.obj', 'utf8')], 'cube.obj'));
    expect(m.watertight).toBe(true);
    expect(m.tris.length / 3).toBe(12);
  });
  it('STL (binary), welded into a closed box', async () => {
    const data = new STLExporter().parse(box(), { binary: true }) as DataView;
    const m = await cubeOf(new File([data.buffer as ArrayBuffer], 'box.STL'));
    expect(m.verts.length / 3).toBe(8);
    expect(m.watertight).toBe(true);
    expect(m.hi[0] - m.lo[0]).toBeCloseTo(0.4);
    expect(m.hi[1] - m.lo[1]).toBeCloseTo(0.2);
  });
  it('PLY (ASCII, quad faces)', async () => {
    const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
    const text = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z',
      'element face 6', 'property list uchar int vertex_indices', 'end_header',
      ...v.map((p) => p.join(' ')), ...f.map((q) => `4 ${q.join(' ')}`)].join('\n');
    const m = await cubeOf(new File([text], 'box.ply'));
    expect(m.tris.length / 3).toBe(12);
    expect(m.watertight).toBe(true);
  });
  it('GLB, applying node transforms', async () => {
    // One triangle-list box (BoxGeometry's 24 vertices), scaled by a node to 2 × 3 × 1.
    const g = new THREE.BoxGeometry(2, 1, 1);
    const pos = new Float32Array(g.getAttribute('position').array);
    const idx = new Uint16Array(g.getIndex()!.array);
    const bytes = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [1, 3, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [{ byteLength: bytes.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] },
        { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
      ],
    };
    // GLB container: header, JSON chunk, BIN chunk (both 4-byte aligned).
    const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
    const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20), bin = pad(bytes, 0);
    const chunk = (type: number, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(data.length, 0);
      h.writeUInt32LE(type, 4);
      return Buffer.concat([h, data]);
    };
    const body = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + body.length, 8);
    const glb = Buffer.concat([header, body]);
    const m = await cubeOf(new File([glb], 'box.glb'));
    expect(m.hi[1] - m.lo[1]).toBeCloseTo(0.4);
    expect(m.hi[0] - m.lo[0]).toBeCloseTo((0.4 * 2) / 3);
    expect(m.watertight).toBe(true);
  });
  it('rejects unknown formats', async () => {
    await expect(loadModelFile(new File(['x'], 'shape.fbx'))).rejects.toThrow(/Unsupported/);
  });
});
