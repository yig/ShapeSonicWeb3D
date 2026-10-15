// three.js rendering: the (normally hidden) shape with its sharp edges and
// corners, the tracked hands, and three ways of looking at them:
// * camera: from the webcam, with its field of view, drawn over the video and
//   mirrored with it, so the drawn hands sit on the real ones;
// * orbit: a free 3D view (drag to turn, wheel to zoom);
// * XR: three.js renders into the headset session.
// World frame: +y up, −z forward from the camera / headset at the origin.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HAND_BONES, NUM_JOINTS } from '@ygingold/webhands3d';
import type { Shape } from '../geometry/shape';
import { FINGERTIPS, type WorldHand } from './hands';
import type { Placement } from './placement';

export type ViewMode = 'camera' | 'orbit';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const color = (name: string) => new THREE.Color(css(name));

const JOINT_RADIUS = 0.005, TIP_RADIUS = 0.008, CORNER_RADIUS = 0.005;

interface HandMeshes {
  joints: THREE.InstancedMesh;
  tips: THREE.InstancedMesh;
  bones: THREE.LineSegments;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  private readonly orbit: OrbitControls;
  mode: ViewMode = 'camera';
  mirrored = true;
  /** Vertical field of view of the webcam (degrees), or null without one. */
  private cameraFov: number | null = null;
  private videoActive = false;

  private readonly shapeGroup = new THREE.Group(); // placement transform
  private readonly surface = new THREE.Group();
  private readonly featureGroup = new THREE.Group();
  private edges: LineSegments2 | null = null;
  private readonly edgeMaterial: LineMaterial;
  private corners: THREE.InstancedMesh | null = null;
  private ranges: THREE.InstancedMesh | null = null;
  private readonly handMeshes: HandMeshes[] = [];
  private readonly orbitOnly = new THREE.Group(); // floor, webcam frustum
  private placement: Placement | null = null;
  private cornerRange = 0.02;
  private shape: Shape | null = null;
  showShape = false;
  showFeatures = true;
  private colors = this.readColors();

  constructor(
    private readonly stage: HTMLElement,
    private readonly video: HTMLVideoElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local'); // the hand tracker's space
    this.renderer.domElement.id = 'canvas';
    stage.append(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(sun);

    this.edgeMaterial = new LineMaterial({ color: this.colors.edge.getHex(), linewidth: 3, worldUnits: false });
    this.shapeGroup.add(this.surface, this.featureGroup);
    this.scene.add(this.shapeGroup, this.orbitOnly);

    // Webcam frustum and a floor grid, seen only in the orbit view.
    const frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(
        [[-1, -0.6], [1, -0.6], [1, 0.6], [-1, 0.6]].flatMap(([x, y], i, all) => {
          const c = new THREE.Vector3(x * 0.06, y * 0.06, -0.08);
          const n = all[(i + 1) % 4];
          return [new THREE.Vector3(), c, c, new THREE.Vector3(n[0] * 0.06, n[1] * 0.06, -0.08)];
        }),
      ),
      new THREE.LineBasicMaterial({ color: 0x8899aa }),
    );
    const grid = new THREE.GridHelper(2, 20, 0x3a4652, 0x26303a);
    grid.position.set(0, -0.45, -0.6);
    this.orbitOnly.add(frustum, grid);

    for (let h = 0; h < 2; h++) {
      const c = h === 0 ? this.colors.left : this.colors.right;
      const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(JOINT_RADIUS, 10, 6), new THREE.MeshStandardMaterial({ color: c }), NUM_JOINTS);
      const tips = new THREE.InstancedMesh(new THREE.SphereGeometry(TIP_RADIUS, 16, 10), new THREE.MeshStandardMaterial({ color: 0xffffff }), 5);
      const bones = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3)),
        new THREE.LineBasicMaterial({ color: c }),
      );
      for (const o of [joints, tips, bones]) {
        o.frustumCulled = false;
        o.visible = false;
        o.renderOrder = 10;
        this.scene.add(o);
      }
      this.handMeshes.push({ joints, tips, bones });
    }

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enabled = false;

    new ResizeObserver(() => this.layout()).observe(stage);
    video.addEventListener('loadedmetadata', () => this.layout());
    video.addEventListener('resize', () => this.layout());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.colors = this.readColors();
      this.applyColors();
    });
    this.renderer.setAnimationLoop(() => this.render());
    this.layout();
  }

  private readColors() {
    return {
      left: color('--left'),
      right: color('--right'),
      surface: color('--surface'),
      edge: color('--edge'),
      corner: color('--corner'),
      background: color('--stage'),
      inside: color('--inside'),
    };
  }

  private applyColors() {
    this.handMeshes.forEach((m, h) => {
      const c = h === 0 ? this.colors.left : this.colors.right;
      (m.joints.material as THREE.MeshStandardMaterial).color.copy(c);
      (m.bones.material as THREE.LineBasicMaterial).color.copy(c);
    });
    this.edgeMaterial.color.copy(this.colors.edge);
    if (this.shape) this.setShape(this.shape);
  }

  get inXR() {
    return this.renderer.xr.isPresenting;
  }

  /** Webcam intrinsics for the camera view: vertical FOV from the focal length. */
  setWebcam(intrinsics: { fy: number; height: number } | null, videoActive: boolean) {
    this.cameraFov = intrinsics ? (2 * Math.atan(intrinsics.height / 2 / intrinsics.fy) * 180) / Math.PI : null;
    this.videoActive = videoActive;
    this.layout();
  }

  setMode(mode: ViewMode) {
    if (mode === 'orbit' && this.mode !== 'orbit') {
      // Start from over the user's shoulder, looking at the shape.
      const p = this.placement;
      const target = new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? -0.5);
      const away = new THREE.Vector3(Math.sin(p?.yaw ?? 0), 0, Math.cos(p?.yaw ?? 0)); // the shape's front
      this.camera.position.copy(target).addScaledVector(away, 0.9).add(new THREE.Vector3(0.35, 0.35, 0));
      this.orbit.target.copy(target);
      this.orbit.update();
    }
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    this.layout();
  }

  setMirrored(mirrored: boolean) {
    this.mirrored = mirrored;
    this.layout();
  }

  /** Mouse buttons for orbiting; the mouse hand source takes the left button and the wheel. */
  reserveLeftButton(reserve: boolean) {
    this.orbit.mouseButtons = reserve
      ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.enableZoom = !reserve;
  }

  /** Size the canvas: over the video's displayed image in the camera view, else the whole stage. */
  layout() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    let x = 0, y = 0, w = W, h = H;
    const overVideo = this.mode === 'camera' && this.videoActive && this.video.videoWidth > 0;
    if (overVideo) {
      const s = Math.min(W / this.video.videoWidth, H / this.video.videoHeight);
      w = this.video.videoWidth * s;
      h = this.video.videoHeight * s;
      x = (W - w) / 2;
      y = (H - h) / 2;
    }
    const el = this.renderer.domElement;
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    const mirror = this.mode === 'camera' && this.mirrored;
    el.style.transform = mirror ? 'scaleX(-1)' : '';
    this.video.style.transform = this.mirrored ? 'scaleX(-1)' : '';
    this.video.hidden = !(this.mode === 'camera' && this.videoActive);
    this.scene.background = overVideo ? null : this.colors.background;
    // Letterbox bars around the video are dark, like a video player's, rather than UI-coloured.
    this.stage.classList.toggle('video', overVideo);
    this.orbitOnly.visible = this.mode === 'orbit';
    if (!this.inXR) this.renderer.setSize(Math.max(1, w), Math.max(1, h), false);
    this.edgeMaterial.resolution.set(w, h);
    this.camera.aspect = w / Math.max(1, h);
    if (this.mode === 'camera') {
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      this.camera.fov = this.cameraFov ?? 50;
    } else this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  /** World ray through a client (CSS pixel) point on the canvas, honouring the mirror. */
  pointerRay(clientX: number, clientY: number): THREE.Ray {
    const r = this.renderer.domElement.getBoundingClientRect();
    let nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((clientY - r.top) / r.height) * 2 - 1);
    if (this.mode === 'camera' && this.mirrored) nx = -nx;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return raycaster.ray;
  }

  /** The view camera's right, up and forward directions in world coordinates (right flipped when mirrored). */
  viewBasis() {
    const q = this.camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    if (this.mode === 'camera' && this.mirrored) right.negate();
    return { right, up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), forward: new THREE.Vector3(0, 0, -1).applyQuaternion(q) };
  }

  setShape(shape: Shape | null) {
    this.shape = shape;
    for (const o of [...this.surface.children]) {
      this.surface.remove(o);
      (o as THREE.Mesh).geometry.dispose();
    }
    if (shape) {
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.mesh.verts), 3));
      indexed.setIndex(new THREE.BufferAttribute(shape.mesh.tris, 1));
      // Smooth-shaded except across creases sharper than the edge threshold.
      const geometry = toCreasedNormals(indexed, (shape.sharpAngleDeg * Math.PI) / 180);
      indexed.dispose();
      // Transparent triangles aren't sorted within a mesh, so don't write depth;
      // draw the inner faces first, then the outer ones.
      for (const [side, order] of [[THREE.BackSide, 1], [THREE.FrontSide, 2]] as const) {
        const material = new THREE.MeshStandardMaterial({
          color: this.colors.surface,
          transparent: true,
          opacity: side === THREE.BackSide ? 0.25 : 0.35,
          depthWrite: false,
          side,
          roughness: 0.6,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = order;
        this.surface.add(mesh);
      }
    }
    this.setFeatures(shape, this.cornerRange);
  }

  /** Rebuild the sharp edges and corners (after re-detection or a range change). */
  setFeatures(shape: Shape | null, cornerRange: number) {
    this.cornerRange = cornerRange;
    for (const o of [this.edges, this.corners, this.ranges]) {
      if (!o) continue;
      this.featureGroup.remove(o);
      o.geometry.dispose();
    }
    this.edges = this.corners = this.ranges = null;
    if (!shape) return;
    const { edges, corners } = shape.features;
    if (edges.length) {
      const g = new LineSegmentsGeometry().setPositions(edges);
      this.edges = new LineSegments2(g, this.edgeMaterial);
      this.edges.renderOrder = 3;
      this.featureGroup.add(this.edges);
    }
    const n = corners.length / 3;
    if (n) {
      this.corners = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ color: this.colors.corner }), n);
      this.ranges = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 20, 12),
        new THREE.MeshStandardMaterial({ color: this.colors.corner, transparent: true, opacity: 0.18, depthWrite: false }),
        n,
      );
      this.corners.renderOrder = 4;
      this.ranges.renderOrder = 5;
      this.featureGroup.add(this.corners, this.ranges);
    }
    this.sizeFeatures();
  }

  /** Corner dots and range spheres have fixed real sizes, so they depend on the placement's scale. */
  private sizeFeatures() {
    const scale = this.placement?.scale ?? 1;
    const corners = this.shape?.features.corners;
    if (!corners || !this.corners || !this.ranges) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < corners.length / 3; i++) {
      const p = new THREE.Vector3(corners[3 * i], corners[3 * i + 1], corners[3 * i + 2]);
      this.corners.setMatrixAt(i, m.compose(p, new THREE.Quaternion(), new THREE.Vector3().setScalar(CORNER_RADIUS / scale)));
      this.ranges.setMatrixAt(i, m.compose(p, new THREE.Quaternion(), new THREE.Vector3().setScalar(this.cornerRange / scale)));
    }
    this.corners.instanceMatrix.needsUpdate = true;
    this.ranges.instanceMatrix.needsUpdate = true;
  }

  setPlacement(p: Placement) {
    const rescaled = p.scale !== this.placement?.scale;
    this.placement = { ...p };
    this.shapeGroup.position.set(p.x, p.y, p.z);
    this.shapeGroup.rotation.set(0, p.yaw, 0);
    this.shapeGroup.scale.setScalar(p.scale);
    if (rescaled) this.sizeFeatures();
  }

  setVisibility(showShape: boolean, showFeatures: boolean) {
    this.showShape = showShape;
    this.showFeatures = showFeatures;
    this.shapeGroup.visible = showShape;
    this.featureGroup.visible = showFeatures;
  }

  /**
   * Draw the hands. `inside[h][f]`: fingertip f of hand h is inside the shape;
   * shown (as a filled, bright fingertip) only while the shape is shown, so
   * the drawing never gives the shape away.
   */
  setHands(hands: WorldHand[], inside: boolean[][]) {
    const m = new THREE.Matrix4();
    this.handMeshes.forEach((mesh, h) => {
      const hand = hands.find((x) => x.hand === h);
      mesh.joints.visible = mesh.tips.visible = mesh.bones.visible = !!hand;
      if (!hand) return;
      const j = hand.joints;
      for (let i = 0; i < NUM_JOINTS; i++) mesh.joints.setMatrixAt(i, m.makeTranslation(j[3 * i], j[3 * i + 1], j[3 * i + 2]));
      mesh.joints.instanceMatrix.needsUpdate = true;
      const handColor = h === 0 ? this.colors.left : this.colors.right;
      FINGERTIPS.forEach((t, f) => {
        mesh.tips.setMatrixAt(f, m.makeTranslation(j[3 * t], j[3 * t + 1], j[3 * t + 2]));
        mesh.tips.setColorAt(f, this.showShape && inside[h]?.[f] ? this.colors.inside : handColor);
      });
      mesh.tips.instanceMatrix.needsUpdate = true;
      if (mesh.tips.instanceColor) mesh.tips.instanceColor.needsUpdate = true;
      const pos = mesh.bones.geometry.getAttribute('position') as THREE.BufferAttribute;
      HAND_BONES.forEach(([a, b], i) => {
        pos.setXYZ(2 * i, j[3 * a], j[3 * a + 1], j[3 * a + 2]);
        pos.setXYZ(2 * i + 1, j[3 * b], j[3 * b + 1], j[3 * b + 2]);
      });
      pos.needsUpdate = true;
    });
  }

  private render() {
    if (this.inXR) this.scene.background = null; // passthrough (AR) or black (VR)
    this.renderer.render(this.scene, this.camera);
  }
}
