// Camera hands: webhands' multi-camera tracker. Camera 0 is the main camera,
// shown on the stage; its frame is the world frame (converted with
// (x, −y, −z)). More cameras can join: other cameras on this computer, and
// phones that scan a QR code (webhands' PeerJS join). Once a camera's position
// is calibrated against camera 0, hands it sees are triangulated with camera
// 0's; until then it is ignored. With camera 0 alone, its frames pass straight
// through the tracker, so a single webcam costs no extra latency.

import {
  MonocularHandTracker,
  MultiViewHandTracker,
  RemoteCamera,
  openCamera,
  type CameraHandle,
  type ViewSource,
} from '@ygingold/webhands3d';
import { worldHands, type HandListener } from './hands';

export interface RigCamera {
  source: ViewSource;
  kind: 'main' | 'local' | 'phone';
  name: string;
  /** Local cameras: the playing video (the stage video for the main camera). */
  video?: HTMLVideoElement;
  handle?: CameraHandle;
}

export class CameraRig {
  tracker: MultiViewHandTracker | null = null;
  /** In the tracker's camera order (camera 0 first). */
  cameras: RigCamera[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly mainVideo: HTMLVideoElement,
    private readonly listener: HandListener,
    /** Cameras were added, removed or reordered, or the tracker was replaced. */
    private readonly onChange: () => void,
  ) {}

  get main(): RigCamera | undefined {
    return this.cameras.find((c) => c.kind === 'main');
  }

  /**
   * (Re)start with `deviceId` as the main camera. Changing camera 0 changes the
   * reference frame, so this builds a new tracker and re-adds the other
   * cameras (their positions relative to the new camera 0 load from storage
   * if they were calibrated before).
   */
  async startMain(deviceId?: string) {
    const others = this.cameras.filter((c) => c.kind !== 'main');
    this.stopTracker();
    this.main?.handle?.stop();
    const handle = await openCamera({ video: this.mainVideo, deviceId });
    const main: RigCamera = {
      source: new MonocularHandTracker({ video: this.mainVideo }),
      kind: 'main',
      name: handle.label || 'Main camera',
      video: this.mainVideo,
      handle,
    };
    const tracker = new MultiViewHandTracker([main.source]);
    this.tracker = tracker;
    this.cameras = [main];
    this.unsubscribe = tracker.onFrame((hands, t) => this.listener(worldHands(hands), t));
    await tracker.start();
    for (const c of others) {
      await tracker.addSource(c.source);
      this.cameras.push(c);
    }
    this.onChange();
  }

  /** Add another camera on this computer, playing into `video` (which must stay in the document). */
  async addLocal(deviceId: string, video: HTMLVideoElement): Promise<RigCamera> {
    if (!this.tracker) throw new Error('Start the main camera first.');
    const handle = await openCamera({ video, deviceId });
    const camera: RigCamera = { source: new MonocularHandTracker({ video }), kind: 'local', name: handle.label || 'Camera', video, handle };
    await this.tracker.addSource(camera.source);
    this.cameras.push(camera);
    this.onChange();
    return camera;
  }

  /** A phone that joined (from createRemoteCameraJoin's addCamera). */
  async addPhone(phone: RemoteCamera) {
    const camera: RigCamera = { source: phone, kind: 'phone', name: phone.label || 'Phone' };
    this.cameras.push(camera);
    if (this.tracker) await this.tracker.addSource(phone);
    camera.name = phone.label || 'Phone';
    this.onChange();
  }

  /** Remove a camera other than the main one (phones are disconnected). */
  remove(source: ViewSource) {
    const camera = this.cameras.find((c) => c.source === source);
    if (!camera || camera.kind === 'main') return;
    this.tracker?.removeSource(source);
    this.cameras.splice(this.cameras.indexOf(camera), 1);
    camera.handle?.stop();
    if (camera.video && camera.video !== this.mainVideo) (camera.video.closest('figure') ?? camera.video).remove();
    if (source instanceof RemoteCamera) source.close();
    this.onChange();
  }

  /** Stop tracking and every local camera. Phones stay connected and rejoin the next tracker. */
  stop() {
    this.stopTracker();
    for (const c of this.cameras) {
      if (c.kind === 'phone') continue;
      c.handle?.stop();
      if (c.video && c.video !== this.mainVideo) (c.video.closest('figure') ?? c.video).remove();
    }
    this.cameras = this.cameras.filter((c) => c.kind === 'phone');
    this.onChange();
  }

  private stopTracker() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tracker?.stop();
    this.tracker = null;
  }

  /** One line per camera for the menu: role, calibration, frame rate and delay. */
  describe(): { camera: RigCamera; text: string; calibrated: boolean }[] {
    const st = this.tracker?.status;
    return this.cameras.map((camera) => {
      const i = this.tracker ? this.tracker.sources.indexOf(camera.source) : -1;
      const v = i >= 0 ? st?.views[i] : undefined;
      const rate = v ? ` · ${v.fps.toFixed(0)} fps${v.delayMs !== null ? `, ${v.delayMs.toFixed(0)} ms behind` : ''}` : '';
      const where =
        i === 0
          ? 'reference'
          : v?.calibration
            ? `${(Math.hypot(...v.calibration.t) * 100).toFixed(0)} cm from the main camera`
            : 'position not calibrated: ignored';
      return { camera, text: `${where}${rate}`, calibrated: i === 0 || !!v?.calibration };
    });
  }
}
