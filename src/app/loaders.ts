// Model files → triangle soups. OBJ is parsed by our own parser (geometry/mesh);
// STL, PLY and glTF/GLB go through three.js's loaders.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshError, parseOBJ, type TriangleSoup } from '../geometry/mesh';

export const MODEL_EXTENSIONS = ['.obj', '.stl', '.ply', '.glb', '.gltf'];

function fromGeometry(geometries: THREE.BufferGeometry[]): TriangleSoup {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    const index = g.getIndex();
    if (index) for (let i = 0; i + 2 < index.count; i += 3) indices.push(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
    else for (let i = 0; i + 2 < pos.count; i += 3) indices.push(base + i, base + i + 1, base + i + 2);
  }
  if (!indices.length) throw new MeshError('The model has no triangles.');
  return { positions, indices };
}

/** Parse a model file by its extension. */
export async function loadModelFile(file: File): Promise<TriangleSoup> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.obj':
      return parseOBJ(await file.text());
    case '.stl':
      return fromGeometry([new STLLoader().parse(await file.arrayBuffer())]);
    case '.ply':
      return fromGeometry([new PLYLoader().parse(await file.arrayBuffer())]);
    case '.glb':
    case '.gltf': {
      const gltf = await new GLTFLoader().parseAsync(ext === '.glb' ? await file.arrayBuffer() : await file.text(), '');
      gltf.scene.updateMatrixWorld(true);
      const geometries: THREE.BufferGeometry[] = [];
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      });
      return fromGeometry(geometries);
    }
    default:
      throw new MeshError(`Unsupported file type ${ext}. Use ${MODEL_EXTENSIONS.join(', ')}.`);
  }
}
