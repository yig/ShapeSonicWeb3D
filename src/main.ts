// App wiring: settings, shape loading, hand sources, placement, and the
// hands → probe → audio path, which runs synchronously on every hand frame.

import {
  createCalibrationPanel,
  createRemoteCameraJoin,
  listCameras,
  type CalibrationPanel,
  type MonocularHandTracker,
  type MultiViewHandTracker,
  type RemoteCameraJoin,
} from '@ygingold/webhands3d';
import { FINGERTIPS, virtualHand, XRHands, type WorldHand } from './app/hands';
import { loadModelFile } from './app/loaders';
import { defaultPlacement, toShape } from './app/placement';
import { CameraRig } from './app/rig';
import { View, type ViewMode } from './app/view';
import { Sonifier } from './audio';
import { MeshError, parseOBJ, prepareMesh, type Mesh, type TriangleSoup } from './geometry/mesh';
import { buildShape } from './geometry/parallel';
import { DEFAULT_BUILD, type Shape } from './geometry/shape';
import { DEFAULT_SONIFY, FINGERS, probe, silentLevels, type FingerProbe, type Fingertip, type HandLevels } from './sonify';

type Source = 'camera' | 'mouse' | 'xr';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- settings (remembered per browser) ----------

interface Settings {
  demo: string;
  sizeCm: number;
  keepUnits: boolean;
  volume: number;
  source: Source;
  view: ViewMode;
  mirror: boolean;
  showFeatures: boolean;
  rangeCm: number;
  deviceId: string;
}
const SETTINGS_KEY = 'shapesonic3d:settings';
const defaults: Settings = {
  demo: 'cube',
  sizeCm: 30,
  keepUnits: false,
  volume: 0.8,
  source: 'camera',
  view: 'camera',
  mirror: true,
  showFeatures: true,
  rangeCm: 2,
  deviceId: '',
};
const settings: Settings = { ...defaults };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {}
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
};

const params = new URLSearchParams(location.search);

// ---------- demo shapes ----------

const DEMO_URLS = Object.fromEntries(
  Object.entries(import.meta.glob('../models/*.obj', { query: '?url', import: 'default', eager: true }) as Record<string, string>).map(
    ([path, url]) => [path.replace(/^.*\/(.*)\.obj$/, '$1'), url],
  ),
);
const DEMOS = Object.keys(DEMO_URLS).sort();
/** Per-model sharp-edge angles (the cat is a faceted organic mesh: 30° finds spurious edges). */
const DEMO_SHARP_ANGLES: Record<string, number> = { cat: 50 };
const DEFAULT_SHARP_ANGLE = 30;

// ---------- state ----------

const state = {
  shape: null as Shape | null,
  /** Name shown only inside the menu. */
  shapeName: '',
  /** 'demo' or 'file' (a loaded file may keep its own units). */
  shapeKind: 'demo' as 'demo' | 'file',
  sharpAngle: DEFAULT_SHARP_ANGLE,
  placement: defaultPlacement('camera', settings.sizeCm / 100 / DEFAULT_BUILD.fitSize),
  hands: [] as WorldHand[],
  showShape: params.get('show') === '1',
  source: (params.get('source') as Source | null) ?? settings.source,
  started: false,
  menuOpen: false,
  placing: false,
  levels: silentLevels() as HandLevels[],
  perFinger: [] as FingerProbe[],
  fingers: [] as Fingertip[],
  /** Mouse source: the hand whose button is held (−1 none), and its depth offset from the shape's centre plane. */
  mouseHand: -1,
  mouseDepth: 0,
  mouseRay: null as null | { x: number; y: number },
};
if (!['camera', 'mouse', 'xr'].includes(state.source)) state.source = 'camera';

const sonifier = new Sonifier();
sonifier.setVolume(settings.volume);
const video = $<HTMLVideoElement>('video');
const view = new View($('stage'), video);
view.setMode((params.get('view') as ViewMode | null) ?? settings.view);
view.setMirrored(settings.mirror);
const sonifyParams = { ...DEFAULT_SONIFY };

// ---------- messages ----------

let toastTimer = 0;
function toast(text: string, kind: 'info' | 'ok' | 'error' | 'busy' = 'info', ms = 4000) {
  const el = $('toast');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (kind !== 'busy') toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- the hot path: hands → probe → audio ----------

function onHands(hands: WorldHand[]) {
  state.hands = hands;
  frameCount++;
  update();
}

/** Probe every fingertip and update the audio and the drawing. */
function update() {
  const p = state.placement;
  state.fingers.length = 0;
  for (const h of state.hands) {
    FINGERTIPS.forEach((j, slot) => {
      const [x, y, z] = toShape(p, h.joints[3 * j], h.joints[3 * j + 1], h.joints[3 * j + 2]);
      state.fingers.push({ hand: h.hand, slot, x, y, z });
    });
  }
  state.levels = probe(state.shape, p.scale, state.fingers, sonifyParams, state.perFinger);
  sonifier.update(state.placing ? silentLevels() : state.levels);
  const inside = [0, 1].map(() => new Array(FINGERS).fill(false));
  state.fingers.forEach((f, i) => (inside[f.hand][f.slot] = state.perFinger[i].sdf <= 0));
  view.setHands(state.hands, inside);
}

// ---------- shapes ----------

let loadToken = 0;

async function useMesh(mesh: Mesh, name: string, kind: 'demo' | 'file', sharpAngle: number) {
  const token = ++loadToken;
  setShapeStatus(`Building the distance field for ${name}…`);
  const shape = await buildShape(mesh, DEFAULT_BUILD, sharpAngle, (f) => {
    if (token === loadToken) setShapeStatus(`Building the distance field for ${name}… ${Math.round(f * 100)}%`);
  });
  if (token !== loadToken) return;
  state.shape = shape;
  state.shapeName = name;
  state.shapeKind = kind;
  state.sharpAngle = sharpAngle;
  $<HTMLInputElement>('angle').value = String(sharpAngle);
  applyScale();
  view.setShape(shape);
  renderDemoButtons();
  renderShapeStatus();
  update();
}

async function loadDemo(name: string) {
  if (!DEMO_URLS[name]) name = DEMOS[0];
  settings.demo = name;
  save();
  try {
    const res = await fetch(DEMO_URLS[name]);
    if (!res.ok) throw new Error(`Could not load ${name}`);
    await useMesh(prepareMesh(parseOBJ(await res.text()), DEFAULT_BUILD.fitSize), name, 'demo', DEMO_SHARP_ANGLES[name] ?? DEFAULT_SHARP_ANGLE);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) setShapeStatus(errorText(e), 'error');
  }
}

async function loadFile(file: File) {
  try {
    setShapeStatus(`Reading ${file.name}…`);
    const soup: TriangleSoup = await loadModelFile(file);
    await useMesh(prepareMesh(soup, DEFAULT_BUILD.fitSize), file.name, 'file', DEFAULT_SHARP_ANGLE);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    setShapeStatus(e instanceof MeshError ? `Couldn't load ${file.name}: ${e.message}` : errorText(e), 'error');
  }
}

/** Display scale: the size slider, or the model's own units (metres) for a loaded file. */
function applyScale() {
  const mesh = state.shape?.mesh;
  const size = state.shapeKind === 'file' && settings.keepUnits && mesh ? mesh.sourceSize : settings.sizeCm / 100;
  state.placement.scale = size / DEFAULT_BUILD.fitSize;
  view.setPlacement(state.placement);
}

function setShapeStatus(text: string, kind: 'info' | 'error' = 'info') {
  const el = $('shapeStatus');
  el.textContent = text;
  el.dataset.kind = kind;
}

function renderShapeStatus() {
  const s = state.shape;
  if (!s) return;
  const size = s.mesh.hi.map((h, a) => ((h - s.mesh.lo[a]) * state.placement.scale * 100).toFixed(0)).join(' × ');
  setShapeStatus(
    [
      `${state.shapeName}: ${s.mesh.tris.length / 3} triangles, ${size} cm`,
      `${s.edgeCount} sharp edges, ${s.cornerCount} corners`,
      `SDF ${(s.octree.leafCount / 1e6).toFixed(2)} M leaves, ${(s.octree.bytes / 1e6).toFixed(1)} MB, built in ${s.buildSeconds.toFixed(1)} s`,
      s.mesh.watertight ? '' : 'Not watertight: inside/outside is decided by ray parity.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function renderDemoButtons() {
  const box = $('demos');
  box.replaceChildren(
    ...DEMOS.map((name) => {
      const b = document.createElement('button');
      b.textContent = name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.shapeKind === 'demo' && state.shapeName === name));
      b.addEventListener('click', () => loadDemo(name));
      return b;
    }),
  );
}

// ---------- hand sources ----------

const xrHands = new XRHands(onHands);
const rig = new CameraRig(video, onHands, onCamerasChanged);
let panel: CalibrationPanel | null = null;
let panelTracker: MultiViewHandTracker | null = null;
let join: RemoteCameraJoin | null = null;

async function startSource(source: Source) {
  state.source = source;
  settings.source = source;
  save();
  if (source !== 'camera') rig.stop();
  if (source !== 'xr') xrHands.stop();
  onHands([]);
  view.reserveLeftButton(source === 'mouse');
  $<HTMLSelectElement>('source').value = source;
  $('cameraControls').hidden = source !== 'camera';
  $('mouseHint').hidden = source !== 'mouse';
  $('enterXR').hidden = source !== 'xr';
  $('sourceStatus').textContent = '';
  view.setWebcam(null, false);
  if (source === 'camera') await startCamera(settings.deviceId || undefined);
  if (source === 'xr') await startXR();
}

/** (Re)start the cameras with `deviceId` as the main camera. */
async function startCamera(deviceId?: string) {
  toast('Opening the camera and loading hand tracking…', 'busy');
  try {
    await rig.startMain(deviceId);
  } catch (e) {
    if (deviceId) return startCamera(); // the remembered camera may be gone
    throw e;
  }
  const main = rig.main!;
  settings.deviceId = main.handle!.cameraId;
  save();
  const missing = (main.source as MonocularHandTracker).calibrator.status.missing;
  toast(`${main.name} running.${missing.length ? ' Calibrate it in the menu for accurate distances.' : ''}`, 'ok');
  await renderCameraChoices();
}

/** The main camera's field of view sets the camera view's. */
function updateWebcamView() {
  const main = rig.main;
  view.setWebcam(main?.source.intrinsics ?? null, !!main);
}

/** Cameras came or went, or the tracker was replaced. */
function onCamerasChanged() {
  const tracker = rig.tracker;
  if (tracker && tracker !== panelTracker) {
    // The calibration panel belongs to a tracker: make a new one.
    panel?.destroy();
    panelTracker = tracker;
    panel = createCalibrationPanel($('calibration'), {
      tracker,
      steps: ['lens', 'handSize', 'skeleton', 'positions'],
      videoFor: (source) => rig.cameras.find((c) => c.source === source)?.video ?? null,
      nameFor: (source, i) => (i === 0 ? 'Main camera' : rig.cameras.find((c) => c.source === source)?.name ?? `Camera ${i}`),
      mirrored: () => settings.mirror,
      banner: false,
      onStatus: (text, kind) => toast(text, kind, 6000),
    });
    (rig.main?.source as MonocularHandTracker | undefined)?.calibrator.onChange(updateWebcamView);
  }
  panel?.refresh();
  updateWebcamView();
  renderCameraList();
  renderCameraChoices();
}

/** The camera list in the menu (rebuilt on changes; its details refresh every second). */
function renderCameraList() {
  $('cameraList').replaceChildren(
    ...rig.cameras.map((camera) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'text';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${camera.kind === 'main' ? 'Main: ' : camera.kind === 'phone' ? 'Phone: ' : ''}${camera.name}`;
      const detail = document.createElement('div');
      detail.className = 'detail';
      text.append(name, detail);
      li.append(text);
      if (camera.kind !== 'main') {
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.title = `Remove ${camera.name}`;
        remove.setAttribute('aria-label', `Remove ${camera.name}`);
        remove.addEventListener('click', () => rig.remove(camera.source));
        li.append(remove);
      }
      return li;
    }),
  );
  refreshCameraDetails();
}

function refreshCameraDetails() {
  const rows = $('cameraList').querySelectorAll<HTMLElement>('.detail');
  rig.describe().forEach((d, i) => {
    if (!rows[i]) return;
    rows[i].textContent = d.text;
    rows[i].dataset.ok = String(d.calibrated);
  });
}

/** Main-camera choice, and the other local cameras that can be added. */
async function renderCameraChoices() {
  if (state.source !== 'camera') return;
  const cameras = await listCameras().catch(() => [] as MediaDeviceInfo[]);
  const used = new Set(rig.cameras.flatMap((c) => (c.handle ? [c.handle.cameraId] : [])));
  const mainId = rig.main?.handle?.cameraId;
  $<HTMLSelectElement>('cameraSelect').replaceChildren(
    ...cameras.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === mainId)),
  );
  const free = cameras.filter((c) => !used.has(c.deviceId));
  $<HTMLSelectElement>('extraCameraSelect').replaceChildren(
    ...(free.length ? free.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)) : [new Option('No other cameras', '')]),
  );
  $<HTMLButtonElement>('addCamera').disabled = !free.length;
}

/** Add another local camera, shown as a small live view on the stage. */
async function addLocalCamera(deviceId: string) {
  const figure = document.createElement('figure');
  const thumb = document.createElement('video');
  thumb.muted = true;
  thumb.playsInline = true;
  const caption = document.createElement('figcaption');
  figure.append(thumb, caption);
  $('thumbs').append(figure);
  try {
    const camera = await rig.addLocal(deviceId, thumb);
    caption.textContent = camera.name;
    toast(`Added ${camera.name}. Calibrate the camera positions in the menu to use it.`, 'ok', 6000);
  } catch (e) {
    figure.remove();
    throw e;
  }
}

/**
 * The page a phone opens from the QR code. Phones find this computer through
 * PeerJS, so the page can be served from anywhere over HTTPS: by default
 * webhands' published phone page, so a phone needs only internet (no local
 * HTTPS server, certificate or shared network). A production build of this
 * app served over HTTPS uses its own phone.html instead.
 */
const HOSTED_PHONE_PAGE = 'https://yig.github.io/webhands3d/remote.html';
const phonePageUrl = () =>
  import.meta.env.PROD && location.protocol === 'https:' ? new URL('phone.html', location.href).href : HOSTED_PHONE_PAGE;

/** Phones join through webhands' PeerJS component (made when first opened: it registers with the PeerJS server). */
function openPhoneJoin() {
  if (join || !rig.tracker) return;
  join = createRemoteCameraJoin($('join'), {
    tracker: rig.tracker,
    phonePageUrl: phonePageUrl(),
    onStatus: (text, kind) => toast(text, kind, 6000),
    addCamera: (camera) => rig.addPhone(camera),
    removeCamera: (camera) => rig.remove(camera),
  });
}

async function startXR() {
  if (!(await XRHands.isSupported())) {
    $('sourceStatus').textContent = 'This browser has no immersive WebXR. Open the page in a headset browser such as the Meta Quest Browser, over HTTPS (npm run dev:lan).';
    return;
  }
  try {
    const session = await xrHands.start((s) => view.renderer.xr.setSession(s));
    resetPlacement();
    session.addEventListener('end', () => {
      onHands([]);
      toast('Left the headset view.');
    });
    toast('In the headset. Hands are tracked by the headset.', 'ok');
  } catch (e) {
    $('sourceStatus').textContent = `Couldn't start the headset with hand tracking: ${errorText(e)}. Click "Enter headset" to try again.`;
  }
}

// Mouse: a virtual hand under the pointer, on a plane through the shape's
// centre facing the view, moved nearer or farther by the wheel.
function mouseUpdate() {
  if (state.source !== 'mouse') return;
  if (state.mouseHand < 0 || !state.mouseRay) return onHands([]);
  const ray = view.pointerRay(state.mouseRay.x, state.mouseRay.y);
  const { right, up, forward } = view.viewBasis();
  const p = state.placement;
  const plane = [p.x + forward.x * state.mouseDepth, p.y + forward.y * state.mouseDepth, p.z + forward.z * state.mouseDepth];
  const denom = ray.direction.dot(forward);
  if (Math.abs(denom) < 1e-6) return;
  const t = ((plane[0] - ray.origin.x) * forward.x + (plane[1] - ray.origin.y) * forward.y + (plane[2] - ray.origin.z) * forward.z) / denom;
  const tip: [number, number, number] = [ray.origin.x + ray.direction.x * t, ray.origin.y + ray.direction.y * t, ray.origin.z + ray.direction.z * t];
  onHands([virtualHand(state.mouseHand, tip, [right.x, right.y, right.z], [up.x, up.y, up.z])]);
}
const canvas = view.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (state.source !== 'mouse' || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  state.mouseHand = e.shiftKey ? 0 : 1;
  state.mouseRay = { x: e.clientX, y: e.clientY };
  mouseUpdate();
});
canvas.addEventListener('pointermove', (e) => {
  if (state.source !== 'mouse' || state.mouseHand < 0) return;
  state.mouseRay = { x: e.clientX, y: e.clientY };
  mouseUpdate();
});
const mouseUp = () => {
  if (state.source !== 'mouse' || state.mouseHand < 0) return;
  state.mouseHand = -1;
  mouseUpdate();
};
canvas.addEventListener('pointerup', mouseUp);
canvas.addEventListener('pointercancel', mouseUp);
canvas.addEventListener(
  'wheel',
  (e) => {
    if (state.source !== 'mouse') return;
    e.preventDefault();
    state.mouseDepth = Math.max(-0.6, Math.min(0.6, state.mouseDepth + e.deltaY * 0.0004));
    mouseUpdate();
  },
  { passive: false },
);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Tracking status in the top bar (never mentions the shape).
let frameCount = 0;
setInterval(() => {
  const el = $('trackingStatus');
  if (!state.started) return (el.textContent = '');
  const n = state.hands.length;
  const hands = n ? `${n === 2 ? 'Both hands' : state.hands[0].hand === 0 ? 'Left hand' : 'Right hand'}` : 'No hands';
  if (state.source === 'mouse') {
    el.textContent = `${n ? hands : 'Hold the mouse button'} · depth ${state.mouseDepth >= 0 ? '+' : ''}${(state.mouseDepth * 100).toFixed(0)} cm`;
  } else {
    const n = rig.describe().filter((d) => d.calibrated).length;
    el.textContent = `${hands} · ${frameCount} fps${n > 1 ? ` · ${n} cameras` : ''}`;
  }
  frameCount = 0;
  if (state.menuOpen) refreshCameraDetails();
}, 1000);

// ---------- placement ----------

function resetPlacement() {
  const scale = state.placement.scale;
  state.placement = defaultPlacement(state.source, scale);
  view.setPlacement(state.placement);
  update();
}

/** Beep (a short sine) to count down placement without looking. */
function beep(freq: number) {
  const ctx = sonifier.ctx;
  if (!ctx) return;
  const osc = new OscillatorNode(ctx, { frequency: freq });
  const g = new GainNode(ctx, { gain: 0 });
  osc.connect(g).connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setTargetAtTime(0.2, t, 0.005);
  g.gain.setTargetAtTime(0, t + 0.12, 0.02);
  osc.start(t);
  osc.stop(t + 0.3);
}

/** After a 3 s countdown, centre the shape between the palms of the hands in view. */
async function placeAtHands() {
  if (state.placing) return;
  state.placing = true;
  const button = $<HTMLButtonElement>('placeButton');
  for (let s = 3; s > 0; s--) {
    button.textContent = `Placing in ${s}…`;
    toast(`Hold your hands where the shape should be: ${s}…`, 'busy');
    beep(660);
    await new Promise((r) => setTimeout(r, 1000));
  }
  button.textContent = 'Place at hands';
  state.placing = false;
  const palms = state.hands.map((h) => {
    const c = [0, 0, 0];
    for (const j of [0, 5, 9, 13, 17]) for (let a = 0; a < 3; a++) c[a] += h.joints[3 * j + a] / 5;
    return c;
  });
  if (!palms.length) {
    toast('No hands in view: the shape was not moved.', 'error');
    update();
    return;
  }
  beep(990);
  const c = [0, 1, 2].map((a) => palms.reduce((s, p) => s + p[a], 0) / palms.length);
  state.placement = { ...state.placement, x: c[0], y: c[1], z: c[2] };
  view.setPlacement(state.placement);
  toast('Placed.', 'ok');
  update();
}

// ---------- UI ----------

function setShowShape(show: boolean) {
  state.showShape = show;
  $<HTMLInputElement>('showShape').checked = show;
  const b = $('showButton');
  b.setAttribute('aria-pressed', String(show));
  b.textContent = show ? 'Hide shape' : 'Show shape';
  view.setVisibility(show, settings.showFeatures);
  update();
}

function setMenuOpen(open: boolean) {
  state.menuOpen = open;
  $('menu').hidden = !open;
  $('menuButton').setAttribute('aria-expanded', String(open));
  // Silence while the menu is open (tracking keeps running, e.g. for calibration).
  sonifier.setMuted(open);
  if (open) {
    renderShapeStatus();
    renderAudioStatus();
    $('closeMenu').focus();
  } else $('menuButton').focus();
}

function renderAudioStatus() {
  const ms = sonifier.latencyMs;
  $('audioStatus').textContent = sonifier.ready
    ? `Audio output latency ${ms !== null ? `${ms.toFixed(0)} ms` : 'unknown'}. Bluetooth headphones add 150–300 ms.`
    : 'Audio is not started yet.';
}

function bindRange(id: string, value: number, format: (v: number) => string, onInput: (v: number) => void) {
  const input = $<HTMLInputElement>(id), out = $(`${id}Out`);
  input.value = String(value);
  const show = () => out && (out.textContent = format(Number(input.value)));
  show();
  input.addEventListener('input', () => {
    show();
    onInput(Number(input.value));
  });
}

bindRange('size', settings.sizeCm, (v) => `${v} cm`, (v) => {
  settings.sizeCm = v;
  save();
  applyScale();
  renderShapeStatus();
  update();
});
bindRange('angle', state.sharpAngle, (v) => `${v}°`, (v) => {
  if (!state.shape) return;
  state.shape.detectFeatures(v);
  state.sharpAngle = v;
  view.setShape(state.shape);
  renderShapeStatus();
  update();
});
bindRange('range', settings.rangeCm, (v) => `${v} cm`, (v) => {
  settings.rangeCm = v;
  save();
  sonifyParams.edgeRange = sonifyParams.cornerRange = v / 100;
  view.setFeatures(state.shape, v / 100);
  update();
});
sonifyParams.edgeRange = sonifyParams.cornerRange = settings.rangeCm / 100;
view.setFeatures(null, settings.rangeCm / 100);
bindRange('volume', settings.volume, () => '', (v) => {
  settings.volume = v;
  save();
  sonifier.setVolume(v);
});

const keepUnits = $<HTMLInputElement>('keepUnits');
keepUnits.checked = settings.keepUnits;
keepUnits.addEventListener('change', () => {
  settings.keepUnits = keepUnits.checked;
  save();
  applyScale();
  renderShapeStatus();
  update();
});
$<HTMLInputElement>('fileInput').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) loadFile(file);
  (e.target as HTMLInputElement).value = '';
});

$('showButton').addEventListener('click', () => setShowShape(!state.showShape));
$<HTMLInputElement>('showShape').addEventListener('change', (e) => setShowShape((e.target as HTMLInputElement).checked));
const showFeatures = $<HTMLInputElement>('showFeatures');
showFeatures.checked = settings.showFeatures;
showFeatures.addEventListener('change', () => {
  settings.showFeatures = showFeatures.checked;
  save();
  view.setVisibility(state.showShape, settings.showFeatures);
});
const viewMode = $<HTMLSelectElement>('viewMode');
viewMode.value = view.mode;
viewMode.addEventListener('change', () => {
  settings.view = viewMode.value as ViewMode;
  save();
  view.setMode(settings.view);
  mouseUpdate();
});
const mirror = $<HTMLInputElement>('mirror');
mirror.checked = settings.mirror;
mirror.addEventListener('change', () => {
  settings.mirror = mirror.checked;
  save();
  view.setMirrored(mirror.checked);
});

$<HTMLSelectElement>('source').addEventListener('change', (e) => {
  startSource((e.target as HTMLSelectElement).value as Source).catch((err) => toast(errorText(err), 'error', 8000));
});
$<HTMLSelectElement>('cameraSelect').addEventListener('change', (e) => {
  startCamera((e.target as HTMLSelectElement).value).catch((err) => toast(errorText(err), 'error', 8000));
});
$('enterXR').addEventListener('click', () => startXR());
$('addCamera').addEventListener('click', () => {
  const id = $<HTMLSelectElement>('extraCameraSelect').value;
  if (id) addLocalCamera(id).catch((err) => toast(errorText(err), 'error', 8000));
});
$('phoneDetails').addEventListener('toggle', () => {
  if (($('phoneDetails') as HTMLDetailsElement).open) openPhoneJoin();
});
navigator.mediaDevices?.addEventListener('devicechange', () => renderCameraChoices());

$('menuButton').addEventListener('click', () => setMenuOpen(!state.menuOpen));
$('closeMenu').addEventListener('click', () => setMenuOpen(false));
$('placeButton').addEventListener('click', () => placeAtHands());
$('placeMenuButton').addEventListener('click', () => {
  setMenuOpen(false);
  placeAtHands();
});
$('resetPlacement').addEventListener('click', () => resetPlacement());
$('turn').addEventListener('click', () => {
  state.placement.yaw = (state.placement.yaw + Math.PI / 2) % (2 * Math.PI);
  view.setPlacement(state.placement);
  update();
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && state.menuOpen) setMenuOpen(false);
  else if (e.key === 'm' || e.key === 'M') setMenuOpen(!state.menuOpen);
  else if (e.key === 's' || e.key === 'S') setShowShape(!state.showShape);
  else if ((e.key === 'p' || e.key === 'P') && state.started) placeAtHands();
});

// ---------- start ----------

async function start(source: Source) {
  const status = $('startStatus');
  status.textContent = 'Starting…';
  status.dataset.kind = 'info';
  try {
    // Audio must start within the click (autoplay policies).
    const audio = sonifier.start();
    state.placement = defaultPlacement(source, state.placement.scale);
    view.setPlacement(state.placement);
    await startSource(source);
    await audio;
    state.started = true;
    $('start').hidden = true;
  } catch (e) {
    status.textContent = errorText(e);
    status.dataset.kind = 'error';
  }
}
$('startCamera').addEventListener('click', () => start('camera'));
$('startMouse').addEventListener('click', () => start('mouse'));
$('startXR').addEventListener('click', () => start('xr'));
XRHands.isSupported().then((ok) => ($('startXR').hidden = !ok));

setShowShape(state.showShape);
view.setPlacement(state.placement);
renderDemoButtons();
const ready = loadDemo(params.get('shape') ?? settings.demo);

// ?start=mouse (or camera) skips the start overlay without audio, for screenshots and tests.
const autostart = params.get('start');
if (autostart === 'mouse' || autostart === 'camera') {
  $('start').hidden = true;
  state.started = true;
  state.placement = defaultPlacement(autostart, state.placement.scale);
  view.setPlacement(state.placement);
  startSource(autostart).catch((e) => toast(errorText(e), 'error'));
}

// For debugging and tests.
Object.assign(window, {
  shapesonic: {
    state,
    settings,
    sonifier,
    view,
    rig,
    ready,
    /** Feed hands directly (world frame), bypassing the tracker. */
    setHands: (hands: WorldHand[]) => onHands(hands),
    virtualHand,
    loadDemo,
  },
});
