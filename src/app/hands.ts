// Hand sources. Every source delivers hands in the world frame (three.js axes:
// +y up, −z forward from the camera or headset at the origin), with 21 joints
// in MediaPipe order:
// * camera: webhands' MonocularHandTracker on a webcam (OpenCV camera frame,
//   converted with (x, −y, −z));
// * xr: webhands' WebXRHandTracker on the session three.js renders into
//   (WebXR 'local' space, which is already the world frame);
// * mouse: a virtual flat hand under the pointer, for trying the app without
//   a camera and for tests.

import {
  MonocularHandTracker,
  NUM_JOINTS,
  WebXRHandTracker,
  openCamera,
  type CameraHandle,
  type Hand3D,
} from 'webhands';

/** Joint indices of the fingertips, thumb to little finger (= pentatonic slots C D E G A). */
export const FINGERTIPS = [4, 8, 12, 16, 20];

export interface WorldHand {
  /** 0 = the user's left hand, 1 = right. */
  hand: number;
  /** 21 × 3, world frame, metres. */
  joints: Float32Array;
}

export type HandListener = (hands: WorldHand[], timeMs: number) => void;

export function worldHands(hands: Hand3D[]): WorldHand[] {
  return hands.map((h) => {
    const j = new Float32Array(NUM_JOINTS * 3);
    for (let i = 0; i < NUM_JOINTS; i++) {
      j[3 * i] = h.joints[3 * i];
      j[3 * i + 1] = -h.joints[3 * i + 1];
      j[3 * i + 2] = -h.joints[3 * i + 2];
    }
    return { hand: h.handedness === 'Left' ? 0 : 1, joints: j };
  });
}

/** Webcam hands. Calibration (lens, hand size, bone lengths) is per camera and persists in localStorage. */
export class CameraHands {
  readonly tracker: MonocularHandTracker;
  private camera: CameraHandle | null = null;

  constructor(readonly video: HTMLVideoElement, listener: HandListener) {
    this.tracker = new MonocularHandTracker({ video });
    this.tracker.onFrame((hands, t) => listener(worldHands(hands), t));
  }

  get label() {
    return this.camera?.label ?? '';
  }
  get cameraId() {
    return this.camera?.cameraId ?? '';
  }

  async start(deviceId?: string) {
    this.stop();
    this.camera = await openCamera({ video: this.video, deviceId });
    await this.tracker.start();
  }

  stop() {
    this.tracker.stop();
    this.camera?.stop();
    this.camera = null;
  }
}

/** Headset hands, from the XR session that three.js renders into. */
export class XRHands {
  private tracker: WebXRHandTracker | null = null;

  constructor(private readonly listener: HandListener) {}

  static isSupported() {
    return WebXRHandTracker.isSupported();
  }

  /** Request a session (from a user gesture) and hand it to `useSession` (e.g. renderer.xr.setSession). */
  async start(useSession: (session: XRSession) => Promise<void>): Promise<XRSession> {
    const xr = navigator.xr;
    if (!xr) throw new Error('This browser has no WebXR. Open the page in a headset browser such as the Meta Quest Browser, over HTTPS.');
    const mode = (await xr.isSessionSupported('immersive-ar').catch(() => false)) ? 'immersive-ar' : 'immersive-vr';
    const session = await xr.requestSession(mode, { requiredFeatures: ['hand-tracking'], optionalFeatures: ['local-floor'] });
    await useSession(session);
    this.tracker = new WebXRHandTracker({ session });
    // Library axes (y down, z forward) back to WebXR axes, which are the world axes.
    this.tracker.onFrame((hands, t) => this.listener(worldHands(hands), t));
    await this.tracker.start();
    session.addEventListener('end', () => (this.tracker = null));
    return session;
  }

  stop() {
    this.tracker?.stop();
    this.tracker = null;
  }
}

type V3 = [number, number, number];

/**
 * A flat virtual hand facing the viewer: the middle fingertip at `tip`, the
 * fingertips 2 cm apart along `right` (the thumb lower and outward), the wrist
 * 15 cm below along −`up`. Left hands are mirrored.
 */
export function virtualHand(hand: number, tip: V3, right: V3, up: V3): WorldHand {
  const side = hand === 0 ? -1 : 1;
  const at = (r: number, u: number): V3 => [0, 1, 2].map((a) => tip[a] + side * r * right[a] + u * up[a]) as V3;
  // Fingertip offsets (right, up) in metres: thumb, index, middle, ring, little.
  const tips: [number, number][] = [[-0.045, -0.06], [-0.02, -0.005], [0, 0], [0.02, -0.005], [0.04, -0.02]];
  const wrist = at(0, -0.15);
  const joints = new Float32Array(NUM_JOINTS * 3);
  joints.set(wrist, 0);
  tips.forEach(([r, u], f) => {
    const t = at(r, u);
    // Base joint (CMC for the thumb, MCP otherwise), then evenly to the tip.
    const base = f === 0 ? at(-0.02, -0.12) : at(r * 0.8, -0.08);
    for (let k = 1; k <= 4; k++) {
      const s = (k - 1) / 3;
      const p = [0, 1, 2].map((a) => base[a] + (t[a] - base[a]) * s);
      joints.set(p, 3 * (1 + 4 * f + (k - 1)));
    }
  });
  return { hand, joints };
}
