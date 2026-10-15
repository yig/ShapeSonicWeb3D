# ShapeSonic 3D for the web: design and architecture

A browser app of ShapeSonic (Huang, Hanocka, Siu, Gingold, SIGGRAPH Asia 2023;
`../paper/main.tex`). An invisible 3D shape floats in front of the user. Their
hands are tracked in 3D, in metres, with webhands
([`@ygingold/webhands3d`](https://www.npmjs.com/package/@ygingold/webhands3d),
<https://github.com/yig/webhands3d/>): from an ordinary webcam, optionally
joined by more cameras and phones that triangulate the hands together, or from
a headset's own hand tracking through WebXR (the paper's setup was a Meta
Quest). Each fingertip is probed against the shape, and the
user hears the paper's guidance, contact, edge and corner sounds. The iOS app
(`../demo-iOS`, `../demo-iOS/DESIGN.md`) is the reference for the geometry
(this is a TypeScript port of its C++ core). The 2D web demo (`../demo`) is the
reference for the Web Audio engine.

Keep this document up to date when the implementation changes.

## Running

```sh
npm install
npm run dev          # http://localhost:5173/
npm run dev:lan      # HTTPS on the local network: to open the app itself on a phone or a Meta Quest
npm run build        # static site in dist/ (relative paths: host it anywhere)
```

Open the page and choose **Start with webcam**, **Start with mouse** (a virtual
hand, no camera needed), or **Start in headset** (shown only where immersive
WebXR is available). Use headphones: the left hand plays in the left ear.
Camera access and WebXR need a secure context: localhost or HTTPS.

To add a phone as a camera, open Menu → Hands → *Add a phone as a camera* on
the computer and scan the QR code with the phone. Both devices need internet
access (PeerJS), but not the same network, and plain `npm run dev` is enough.

URL parameters, for demos and tests:

| Parameter | Effect |
|---|---|
| `shape=<name>` | Initial demo shape (default: the last one chosen, else `cube`). |
| `show=1` | Start with the shape visible. |
| `view=camera\|orbit` | Initial view. |
| `start=mouse\|camera` | Skip the start overlay. No sound plays (browsers need a click to start audio), so this is for screenshots and tests. |

**webhands** is the npm package `@ygingold/webhands3d` (an ordinary
dependency; it brings `@mediapipe/tasks-vision`). To develop against a local
checkout of webhands, `npm link` it, or point the dependency at
`file:../webhands` and rebuild its `dist/` after changes.

## Files

```
index.html               page: stage (video + canvas), camera thumbnails, top bar, menu, start overlay
phone.html               phone page for deployed HTTPS builds (webhands' mountRemoteCamera); see Cameras
src/style.css            layout and theme tokens (light/dark)
src/main.ts              app wiring: settings, shape loading, sources, placement, UI; hands → probe → audio
src/sonify.ts            fingertips → per-hand levels (the paper's falloff table)
src/audio.ts             Web Audio engine (loops, pentatonic contact voices, plucks)
src/geometry/mesh.ts     OBJ parser; weld, normalize, orient; pseudonormals
src/geometry/bvh.ts      triangle BVH, closest point on a triangle, exact SDF, ray parity
src/geometry/octree.ts   adaptive octree SDF: subtree build, stitching, int16 storage, sampling
src/geometry/features.ts sharp edges, corners, and their hash grids
src/geometry/shape.ts    Shape: mesh + octree + features, queries; synchronous build
src/geometry/parallel.ts worker pool that builds the 64 octree subtrees in parallel
src/geometry/sdf.worker.ts the worker
src/app/hands.ts         hand sources: WebXR (webhands), virtual mouse hand; tracker → world frame
src/app/rig.ts           cameras: webhands' multi-camera tracker; main camera, more cameras, phones
src/app/placement.ts     the shape's pose and scale in the world; default placements
src/app/view.ts          three.js: shape, edges, corners, hands; camera / orbit / XR views
src/app/loaders.ts       STL, PLY, glTF/GLB (three.js loaders) and OBJ → triangle soup
models/                  demo shapes (the iOS app's; OBJ, about 0.4 m, all watertight)
public/audio/            the sounds, copied from ../demo/audio
test/                    vitest: geometry, sonification, loaders
tools/smoke.mjs          headless Chrome end-to-end check (needs a running dev server)
tools/bench.ts           octree build time, size and accuracy per model (Node, one thread)
vite.config.ts           two pages (index, phone); HTTPS for dev:lan
```

## Data flow

```
 OBJ / STL / PLY / GLB ─► TriangleSoup ─► prepareMesh ─► Mesh ──► buildShape (worker pool) ─► Shape
                          (loaders.ts)    weld, fit 0.4 m,          64 octree subtrees,         octree SDF,
                                          orient, normals           stitched + quantized        edges, corners

 cameras ─ MultiViewHandTracker ┐   (main camera + other cameras + phones, triangulated)
 headset ─ WebXRHandTracker ────┼─► WorldHand[] ─► onHands() ─► update()  [synchronous, per hand frame]
 mouse ─ virtualHand ───────────┘   (world frame)                 for each fingertip:
                                                                    world ─ toShape(placement) ─► build frame
                                                                  probe() ─► levels ─► Sonifier.update (gain targets)
                                                                            └► View.setHands
 three.js render loop (rAF, or the XR session's) draws the latest state; it is never on the audio path.
```

## Coordinate frames

- **Tracker frame** (webhands' convention): OpenCV camera axes, +x right, +y
  down, +z forward, metres. For cameras the origin is the main camera (camera
  0 of the multi-camera tracker, whose output is always in its frame); for
  WebXR it is the headset's pose when the session started ('local' space).
- **World frame**: three.js axes, (x, −y, −z) of the tracker frame: +y up,
  looking along −z from the origin. For WebXR this is exactly the session's
  'local' space, which three.js also renders in (`renderer.xr` uses 'local'),
  so drawn hands line up with real ones in the headset. `worldHands()` converts
  once, at the source; everything after uses the world frame.
- **Build frame**: the shape's mesh as built: centred on its bounding box,
  longest side 0.4 m, +y up (OBJ convention), +z its front.
- **Placement** (`placement.ts`): world = centre + R_y(yaw) · (scale · build).
  `scale` = display size / 0.4 m. The signed distance scales linearly with a
  uniform scale, so resizing the shape needs no rebuild: a fingertip is mapped
  into the build frame, and the distances found there are multiplied by
  `scale` (`probe(shape, scale, …)`).
- **Default placement**: a webcam faces the user, so the user is behind their
  hands, at −z. The shape is 50 cm from the camera and 12 cm below it (where
  hands usually are in front of a laptop), turned so its front faces the user
  (yaw = π). In a headset the user looks along −z from the origin: the shape is
  45 cm ahead and 25 cm below eye level, front toward them (yaw = 0).
  **Place at hands** counts down 3 s (beeps) and moves the shape's centre to
  the mean palm centre (wrist and four MCPs) of the hands in view. **Turn 90°**
  rotates it; **Reset** restores the default.

## Geometry

The geometry is a TypeScript port of the iOS core (`../demo-iOS/core`), with
the same algorithms and constants; see `../demo-iOS/DESIGN.md` for the full
rationale. The octree's leaf counts on every demo model match the C++ build
exactly. In brief:

- **Mesh** (`mesh.ts`): OBJ `v` and `f` records (with `v/vt/vn` forms, negative
  indices, polygons fan-triangulated). Other formats come through three.js's
  loaders (`loaders.ts`; glTF node transforms are applied, and a `.gltf` must
  embed its buffers since only one file is read). Coincident vertices are
  welded (to 1e-6 of the diagonal), so STL's unindexed triangles become a
  closed mesh. Degenerate triangles are dropped. The mesh is centred and
  scaled to 0.4 m, and flipped if its signed volume is negative. It is
  watertight if every edge has exactly two faces.
- **Exact SDF** (`bvh.ts`): a BVH (median split, 4 triangles per leaf,
  nearest-first traversal) and Ericson's closest point on a triangle, which
  also says whether the closest point is on a face, an edge or a vertex. The
  sign comes from that feature's angle-weighted pseudonormal (Bærentzen and
  Aanæs 2005), exact for closed, consistently oriented meshes. Meshes that
  are not watertight use a majority vote of 3 ray parities.
- **Octree SDF** (`octree.ts`): the domain is the bounding cube plus a 0.5 m
  margin (the guidance range), with 2 mm leaves. A cell the surface may cross
  is always split to the leaf size. Other cells are split if they are larger
  than their distance to the surface, or if trilinear interpolation of their
  corners misses the exact distance at the centre or a face centre by more
  than 0.5 mm + 1% (error-driven, as in adaptive distance fields). Each leaf
  stores 8 int16 corner values. Outside the domain, the distance to the
  bounding box is returned, a lower bound beyond the guidance range anyway.
- **Parallel build** (`parallel.ts`, `sdf.worker.ts`). *This is the one
  structural change from the C++ core*, which splits each level across
  threads. Web Workers share no memory, so instead the root and its 8 children
  are always split (they always are anyway, because the domain is the shape
  plus a 50 cm margin). That gives 64 independent subtrees. A pool of
  `hardwareConcurrency − 1` workers (at most 8) each builds its own BVH over
  the same mesh and pulls subtrees, those nearest the shape first since they
  are the slowest. Each subtree comes back as its local node array and float
  corner values (transferred, not copied). The main thread stitches them under
  the fixed top two levels, re-indexing nodes and leaves, and quantizes with
  the global maximum |d|. Corners shared across subtree boundaries are
  evaluated twice, which costs little. Starting a new build terminates the
  workers of the previous one, and its promise rejects with `AbortError`.
- **Sharp features** (`features.ts`): an edge is sharp if its faces' normals
  differ by more than the threshold (default 30°; menu slider; cat 50°).
  Boundary and non-manifold edges count as sharp. A corner is a vertex where
  ≥ 3 sharp edges meet, where a sharp chain turns by more than the threshold,
  or where the angle deficit exceeds 70° (the apex of a cone). Distances to
  edges and corners use a 2 cm hash grid. Re-detection after a threshold change
  touches the mesh only, so it is immediate.

Measured in Chrome on an 18-core Apple M-series Mac with 8 workers (build,
including the BVHs); and the worst octree error vs. the exact SDF at 20 000
random points (`npm run bench`, Node, one thread):

| model | triangles | leaves | memory | build | ≤ 2 mm from surface | outside, > 1 cm | inside, > 1 cm (÷ \|min SDF\|) | edges / corners |
|---|---|---|---|---|---|---|---|---|
| cube | 12 | 1.30 M | 26.8 MB | 0.35 s | 0.29 mm | 1.7 mm | 0.7% | 12 / 8 |
| cone | 704 | 0.52 M | 10.8 MB | 0.36 s | 0.45 mm | 3.2 mm | 1.3% | 32 / 1 |
| sphere | 960 | 0.61 M | 12.6 MB | 0.29 s | 0.06 mm | 2.9 mm | 0.9% | 0 / 0 |
| torus | 4 096 | 0.38 M | 7.8 MB | 0.36 s | 0.09 mm | 2.3 mm | 1.7% | 0 / 0 |
| cat (50°) | 10 944 | 0.22 M | 4.5 MB | 0.58 s | 0.15 mm | 3.3 mm | 3.5% | 200 / 53 |
| mug | 25 776 | 0.80 M | 16.5 MB | 1.03 s | 0.31 mm | 5.1 mm | 3.2% | 266 / 0 |

A single thread takes 1–5 s per model, so the worker pool is what makes
switching shapes feel immediate. A dense 2 mm grid over the same domain would
be about 10⁹ cells.

Before scaling, the errors are at most about 5% of the guidance volume
(`e^(−10x)` per metre), well below what webcam hand tracking contributes. At
the default 30 cm display size, every error above is multiplied by 0.75.

## Sonification (`sonify.ts`, `audio.ts`)

The paper's mapping (supplemental Table 1), `V(x) = a + b·e^(−5x/D)` for
`0 ≤ x < D`, with distances in real metres (build-frame distances × scale):

| Sound | Recording | Plays when | x | a | b | D |
|---|---|---|---|---|---|---|
| Guidance | `guidance.mp3` loop | a fingertip of the hand is outside | closest outside SDF | 0 | 1 | 50 cm |
| Contact | `contact-{left,right}.mp3` loop | this fingertip is inside | depth −SDF | 0 | 0.8 | \|min SDF\| (real size) |
| Edge | `edge-{left,right}.mp3` pluck | a fingertip is near a sharp edge | closest edge distance | 0.6 | 0.4 | 2 cm (menu) |
| Corner | `corner-{left,right}.mp3` bell | a fingertip is near a corner | closest corner distance | 0.6 | 0.4 | 2 cm (menu) |

- **Fingers are real fingers.** Unlike the touchscreen demos, which have to
  guess hands and assign notes to touches, the trackers report each hand's
  handedness and all five fingertips. The fingertip joints (4, 8, 12, 16, 20)
  are probed, and as in the paper the thumb, index, middle, ring and little
  fingers play C D E G A. The user's left hand plays in the left ear and is
  lower in pitch.
- **Engine**: the 2D demo's Web Audio graph with separate edge and corner
  families, as in the iOS mixer. All 12 loops start once at random offsets
  with gain 0, and updates only move gain targets (`setTargetAtTime`; τ:
  guidance 8 ms, contact 3 ms, edge and corner 6 ms). Plucks are retriggered
  every 0.45 s while a hand is in range (immediately on entering), through a
  gain that follows the distance. Mix: guidance 0.5, contact 0.45, edge and
  corner 0.9. Leading and trailing samples ≤ 1e-4 are trimmed from every
  decoded sound (MP3 encoder padding).
- **Edge/corner range** (menu, default the paper's 2 cm): a webcam's depth is
  noisier than a headset's, so a larger range can make edges and corners
  easier to find. The visualization's range spheres follow it.
- Audio starts from the start overlay's buttons, since browsers require a
  user gesture. The menu shows the output latency the browser reports.

## Hands (`hands.ts`, `rig.ts`)

| Source | How | Notes |
|---|---|---|
| Cameras | webhands `MultiViewHandTracker` (`rig.ts`): the main camera on the page's `<video>`, plus any other local cameras and phones | See *Cameras* below. Needs calibration for accurate depth (the library's calibration panel is in the menu). Uncalibrated, depth assumes an average hand and a 66° lens. |
| Headset | webhands `WebXRHandTracker` on the session three.js renders into (`immersive-ar` passthrough if supported, else VR; `hand-tracking` required) | No calibration. The shape and hands are drawn in the headset. Not yet tried on a real headset (the smoke test has none). |
| Mouse | `virtualHand()`: a flat hand facing the view, middle fingertip under the pointer, on a plane through the shape's centre facing the view | Hold the left button for the right hand (Shift: left). The wheel moves the plane nearer or farther (shown in the top bar). In the orbit view, right-drag turns it. For trying the app without a camera, and for tests. |

### Cameras (`rig.ts`)

All camera tracking goes through webhands' multi-camera tracker, even with one
camera, so there is one code path:

- **Camera 0 is the main camera**: the one shown on the stage, whose field of
  view the camera view uses. The tracker's output is in its frame, so it is
  the world frame, and the shape's placement is relative to it. Choosing
  another main camera changes the reference frame, so the rig builds a new
  tracker with it as camera 0 and re-adds the other cameras (their positions
  relative to the new main camera load from storage if they were calibrated
  before). The calibration panel belongs to a tracker, so it is rebuilt too.
- **More local cameras** (*Add camera*): each plays into a small live
  thumbnail at the bottom left of the stage. They must stay rendered: a video
  that is hidden or out of the document may stop delivering frames, and
  moving it in the DOM would pause it. Removing a camera removes its
  thumbnail.
- **Phones** (*Add a phone as a camera*): webhands' `createRemoteCameraJoin`,
  created the first time that section is opened, because it registers with
  the public PeerJS server. Its QR code is a link to a phone page with the
  computer's PeerJS id (`?host=<id>`). The page is webhands'
  `mountRemoteCamera`: the phone runs MediaPipe on its own camera, finds the
  computer through PeerJS by that id, and sends landmarks (about 2 KB per
  frame) directly to it over WebRTC. Because PeerJS does the finding, the
  phone page can be served from anywhere over HTTPS (phones need HTTPS for
  their camera). By default it is webhands' published copy,
  <https://yig.github.io/webhands3d/remote.html>, so a phone needs only
  internet: no local HTTPS server, certificate warning or shared network. A
  production build of this app served over HTTPS uses its own `phone.html`
  instead (`phonePageUrl` in `main.ts`). The hosted page must speak the same
  remote protocol version as the webhands3d this app was built with; a
  mismatch fails to connect rather than misbehaving. Phones stay connected
  when the source changes and rejoin the next tracker.
- **Calibration**: the panel shows the lens (per camera), hand size, bone
  lengths, and camera positions. Camera positions: hold up one hand and move
  it through the space the cameras share for 12 s. That gives each camera's
  pose and clock offset relative to camera 0, and measures the bone lengths
  by triangulation. Until a camera's position is calibrated, the tracker
  ignores it (the menu says so, in red). Calibration is saved per camera pair
  in `localStorage`.
- **Fusion** (in webhands): each joint is triangulated from every calibrated
  camera that sees the hand. When only one camera sees it, or the cameras
  disagree, the most confident single camera's 3D is used. webhands'
  simulations give about 0.5 mm median joint error triangulated, against
  about 15 mm from one camera.
- The menu lists each camera with its role, its distance from the main
  camera once calibrated, its frame rate and how far behind its frames arrive.
  The top bar counts the cameras in use when there is more than one.

**Latency.** The webhands trackers call back once per camera frame (on the
video's `requestVideoFrameCallback`) or per XR frame. `onHands` probes and
sets the audio gains synchronously in that callback, instead of waiting for
the next animation frame. A probe of 10 fingertips is 10 octree descents and
20 hash-grid queries: at most about 25 µs (the cube, whose long edges fill
the most grid cells; Node on an Apple M-series). The feature grids use numeric
cell keys and a bounding-box early-out (string keys made it 116 µs). What
remains is the camera's frame
interval and exposure, MediaPipe's inference time (one frame or more), the
library's One Euro smoothing, and the audio output latency. Bluetooth
headphones add 150–300 ms.

With the main camera alone, its frames pass straight through the multi-camera
tracker, at no extra cost. **With several calibrated cameras, the output
waits for the slowest one**: each instant is fused once every active camera
has a frame at or after it, or after that camera's usual delay (90th
percentile of arrival − capture) plus one frame interval plus 30 ms, at most
600 ms. Another local camera adds little. A phone runs MediaPipe and then
sends over Wi-Fi, so its frames typically arrive 100–200 ms after capture,
and that delay is added to the sound. Accuracy and latency trade off: remove
a slow phone (✕ in the menu) when responsiveness matters more.

## UI (`main.ts`, `index.html`, `view.ts`)

- **Start overlay**: a short explanation and the three ways to start.
- **Top bar**: Menu, Show shape (also the S key), Place at hands (P), and a
  tracking status: which hands are in view and the tracker's frame rate (for
  the mouse, the plane offset). It never names the shape.
- **Menu** (a side panel; M opens it, Esc closes it). Sound and tracking keep
  running while it is open, so settings such as the edge range or the volume
  can be tried out by ear, and calibration sees the hands. On screens at least
  760 px wide the stage shrinks to the space left of the menu, so the whole
  camera view stays visible (e.g. while calibrating); on narrower screens the
  menu covers it.
  - Shape: the demo models, each a button. The current one is checked, which,
    with the status line, is the only place its name appears. **Load model…**
    takes OBJ, STL, PLY, GLB or glTF. A size slider (default 30 cm, see below),
    and *Loaded models keep their own units* (metres). The status line gives
    the triangles, the real size, the edge and corner counts, and the SDF's
    leaves, memory and build time, or a loading error.
  - Display: show shape, show edges and corners, the view, mirror.
  - Edges and corners: the sharp-edge angle (re-detects at once) and the sound
    range.
  - Sound: volume, output latency.
  - Hands: the source; for cameras, the main camera, the list of cameras
    (with ✕ to remove), *Add camera*, *Add a phone as a camera* (QR code) and
    the calibration panel; for the headset, an *Enter headset* button.
  - Placement: place at hands, reset, turn 90°.
- **Views** (`view.ts`):
  - *From the camera* (default): a three.js camera at the webcam's position,
    with its vertical field of view taken from the tracker's (calibrated)
    intrinsics. The canvas is placed exactly over the video's displayed image
    (`object-fit: contain`, which the calibration panel's corner picking also
    expects), and both are mirrored with CSS, so the drawn hands sit on the
    real ones like a mirror. The video is never cropped: when the window's
    shape differs from the camera's (usually 16:9), the leftover space is
    letterboxed in black, like a video player.
  - *Orbit*: a free view (OrbitControls) starting over the user's shoulder,
    with the webcam's frustum and a floor grid for reference.
  - *Headset*: three.js renders the same scene into the XR session.
- **Visualization** (hidden by default): the shape as a translucent surface,
  smooth-shaded except across creases sharper than the edge threshold
  (`toCreasedNormals`). It is drawn without depth writes, inner faces first and
  then outer faces, so overlapping layers blend instead of hiding each other in
  draw order. Sharp edges are orange 3 px lines, corners red dots with
  translucent spheres of the sound range. Hands are always drawn (joints,
  bones, fingertips in the hand's colour). A fingertip turns white while it is
  inside the shape, but only while the shape is shown, so the drawing never
  gives the shape away.
- **Shape size.** The paper's study shapes fit a 40 cm cube, and in a headset
  that works well. A webcam sees a smaller volume: at 50 cm a 16:9 camera with
  webhands' default 66° lens sees about 65 × 37 cm, and hands exploring the sides of a 40 cm
  shape would leave it. The default display size is therefore 30 cm. It is
  one slider (10–60 cm), and changing it needs no rebuild (see *Coordinate
  frames*).
- Settings (demo, size, units, volume, source, view, mirror, edges and
  corners, range, camera) are remembered in `localStorage`.
- Colours are CSS custom properties with light and dark values; the 3D view
  reads them and follows changes of the colour scheme.
- `window.shapesonic` exposes `{state, settings, sonifier, view, rig, ready,
  setHands, virtualHand, loadDemo}` for debugging and tests.

## Tests

```sh
npm test                               # vitest: geometry, sonification, loaders (~30 s)
npm run dev & npm run smoke            # headless Chrome (2 fake cameras; PeerJS needs internet); SHOTS=dir saves screenshots
npm run bench [-- leaf_mm models...]   # octree size, time and accuracy (one thread)
```

- `test/geometry.test.ts`: OBJ parsing (quads, `v//vn`, negative indices,
  CRLF, bad indices); welding, normalization and orientation of an unwelded,
  inside-out cube; for every demo model: watertight, octree vs. exact SDF at
  5 000 random points (< 1 mm within 2 mm of the surface, < 3 mm within 1 cm,
  < 1 cm farther outside, < 8% of |min SDF| deeper inside), sign vs.
  independent ray parity; feature counts (cube 12/8, sphere and torus 0/0,
  cone 32/1); re-detection; edge and corner distances.
- `test/sonify.test.ts`: contact loud just inside and quiet at the centre;
  guidance only when outside, per hand, following the falloff; contact, edge
  and corner at a corner, edge only along an edge; distances scaled with the
  display size.
- `test/loaders.test.ts`: OBJ, binary STL (welded into a closed box), ASCII
  PLY with quads, GLB with a node transform; unknown formats rejected.
- `tools/smoke.mjs` (also run against `vite preview` of the production build):
  the cube is built in workers with the expected features; the top bar doesn't
  name the shape and the shape starts hidden; virtual-hand levels (contact
  just inside, guidance = e⁻² at 20 cm, edge and corner at a corner, left hand
  → left levels); S shows the shape; the mouse hand exists only while the
  button is held; the menu names the shape; switching demos (cone's apex, the
  cat's 50°); loading an OBJ file; the webcam source runs MediaPipe on Chrome's
  fake camera, audio starts, and the calibration panel is in the menu; a
  second fake camera joins the multi-camera tracker, its thumbnail plays, the
  list marks it uncalibrated, the panel offers camera-position calibration,
  and removing it removes the camera and thumbnail; switching the main camera
  keeps tracking; the phone join registers with PeerJS and links to the
  hosted phone page; a second browser page opens that link (with a fake
  camera), clicks *Start & connect*, and joins the app over PeerJS and WebRTC
  as a phone camera that streams frames; this app's own `phone.html` renders;
  no console errors.

Not automated: real hands. The fake cameras show no hands, so neither the
camera-position calibration nor triangulation runs here, and no real phone
joins (the PeerJS join itself is tested, with a browser page as the phone);
there is no headset either. Manual checks: with a calibrated webcam, guidance gets louder
toward the shape and contact plays one note per finger inside it; edges and
corners of the cube pluck and ring; Place at hands; the drawn hands line up
with the video; with a second camera or a phone, calibrate the positions and
check that the menu shows a plausible distance between the cameras and the top
bar counts them; and in a Quest, the same, plus the shape drawn in passthrough.

## Known limitations and possible extensions

- **One camera's depth.** A single webcam measures depth worst. webhands'
  target after calibration is ±10% at arm's length (its simulations give about
  2% for the wrist; real hands have not been measured yet), so near the
  surface the contact boundary can flicker with tracking noise. Add a second
  camera or a phone for triangulated hands, at the latency cost above.
- **Cameras must overlap the main camera.** Each camera's position is
  calibrated against camera 0, so it needs to share some view with it.
- **The main camera can't be removed**, only switched: it defines the world
  frame the shape is placed in.
- **Phones need internet** for the PeerJS introduction (the public server
  sees peer ids and network addresses, not hand data), and the default phone
  page is on GitHub Pages. webhands accepts `peerOptions` for a self-hosted
  PeerServer; the app doesn't expose that.
- **Fingertip position.** MediaPipe's fingertip landmark is at the tip of the
  finger, not the pad; contact may begin a few millimetres "early".
- **Headset**: untested on hardware. The menu is not reachable from inside the
  headset, so choose the shape before entering. Showing or hiding the shape
  from a hand gesture would be a natural addition.
- **Units**: *keep their own units* assumes the file is in metres. A unit
  choice (mm, cm, inches) would help with CAD exports.
- Corner detection on dense, bevelled meshes may need the threshold adjusted,
  as in the paper. Manual labels (the paper used Blender for failures) are not
  supported. A sidecar file of edges and corners would be a natural extension.
- The 34 s loops (1.3 MB each) dominate the download; the JavaScript bundle
  (three.js, webhands, MediaPipe's wrapper) is about 270 kB gzipped, and MediaPipe's
  WASM and model are fetched from a CDN when the first camera starts.
