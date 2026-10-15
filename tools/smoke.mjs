// Headless end-to-end check in Chrome (needs Google Chrome and a running dev
// server, `npm run dev`). Usage: npm run smoke [-- http://localhost:5173/]
// Screenshots go to $SHOTS (default: no screenshots).
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173/';
const shots = process.env.SHOTS;
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=2', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const open = async (query, name) => {
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 300)}`));
  await p.goto(base + query);
  return p;
};
const shot = async (p, name) => shots && (await p.screenshot({ path: `${shots}/${name}.png` }));
const waitShape = (p, name) =>
  p.waitForFunction((n) => window.shapesonic?.state.shape && window.shapesonic.state.shapeName === n, name, { timeout: 60000 });

// Put the virtual right hand's middle fingertip at a point in the shape's frame (metres, real size).
const touch = (p, x, y, z, hand = 1) =>
  p.evaluate(
    ([x, y, z, hand]) => {
      const s = window.shapesonic;
      const pl = s.state.placement;
      const c = Math.cos(pl.yaw), sn = Math.sin(pl.yaw);
      const tip = [pl.x + c * x + sn * z, pl.y + y, pl.z - sn * x + c * z];
      s.setHands([s.virtualHand(hand, tip, [1, 0, 0], [0, 1, 0])]);
      return s.state.levels;
    },
    [x, y, z, hand],
  );

// ---- mouse source, cube ----
const page = await open('?start=mouse&shape=cube', 'mouse');
await waitShape(page, 'cube');
const info = await page.evaluate(() => {
  const s = window.shapesonic.state;
  return { edges: s.shape.edgeCount, corners: s.shape.cornerCount, seconds: s.shape.buildSeconds, leaves: s.shape.octree.leafCount };
});
check(info.edges === 12 && info.corners === 8, `cube built in workers: ${info.edges} edges, ${info.corners} corners, ${info.leaves} leaves, ${info.seconds.toFixed(2)} s`);
check(!(await page.textContent('#topbar')).includes('cube'), 'the top bar does not name the shape');
check(!(await page.evaluate(() => window.shapesonic.view.showShape)), 'the shape is hidden by default');

let lv = await touch(page, 0, 0, 0.14); // cube is 30 cm: 1 cm inside the front face
check(lv[1].contact[2] > 0.5, `middle finger just inside: contact ${lv[1].contact[2].toFixed(2)}`);
lv = await touch(page, 0, 0, 0.35);
check(Math.abs(lv[1].guidance - Math.exp(-2)) < 0.02 && lv[1].contact.every((c) => c === 0), `20 cm in front (e^-2 = 0.135): guidance ${lv[1].guidance.toFixed(2)}, no contact`);
lv = await touch(page, 0.145, 0.145, 0.145);
check(lv[1].edge > 0.6 && lv[1].corner > 0.6, `at a corner: edge ${lv[1].edge.toFixed(2)}, corner ${lv[1].corner.toFixed(2)}`);
lv = await touch(page, 0.145, 0.145, 0.145, 0);
check(lv[0].corner > 0.6 && lv[1].corner === 0, 'the left hand drives the left-hand levels');
await shot(page, 'hidden');

await page.keyboard.press('s');
check(await page.evaluate(() => window.shapesonic.view.showShape), 'S shows the shape');
await page.waitForTimeout(300);
await shot(page, 'shown-camera');
const setView = (mode) =>
  page.evaluate((mode) => {
    const el = document.getElementById('viewMode');
    el.value = mode;
    el.dispatchEvent(new Event('change'));
  }, mode);
await setView('orbit');
await page.waitForTimeout(300);
await shot(page, 'shown-orbit');

// Mouse drag in the camera view: a hand appears while the button is held.
await setView('camera');
await page.mouse.move(600, 400);
await page.mouse.down();
await page.mouse.move(610, 400);
const held = await page.evaluate(() => window.shapesonic.state.hands.length);
await page.mouse.up();
const released = await page.evaluate(() => window.shapesonic.state.hands.length);
check(held === 1 && released === 0, 'the mouse hand is present only while the button is held');

// Menu: the shape's name appears only there; demos switch; the angle re-detects.
await page.click('#menuButton');
check((await page.textContent('#shapeStatus')).includes('cube'), 'the menu names the shape');
await page.click('#demos button:has-text("cone")');
await waitShape(page, 'cone');
check(await page.evaluate(() => window.shapesonic.state.shape.cornerCount === 1), 'cone: the apex is a corner');
await page.click('#demos button:has-text("cat")');
await waitShape(page, 'cat');
check(await page.evaluate(() => window.shapesonic.state.shape.sharpAngleDeg === 50), 'cat uses its 50° default');

// Loading a file.
await page.setInputFiles('#fileInput', 'models/torus.obj');
await waitShape(page, 'torus.obj');
check(await page.evaluate(() => window.shapesonic.state.shape.edgeCount === 0), 'a loaded OBJ builds (torus: no sharp edges)');
await page.close();

// ---- webcam source (fake camera; no hands in the fake video) ----
const cam = await open('', 'camera');
await cam.click('#startCamera');
await cam.waitForFunction(() => window.shapesonic?.state.started, null, { timeout: 60000 });
await cam.waitForTimeout(6000);
check(/fps/.test(await cam.textContent('#trackingStatus')), `webcam tracking runs: "${await cam.textContent('#trackingStatus')}"`);
check(await cam.evaluate(() => window.shapesonic.sonifier.ready), 'audio started');
await cam.click('#menuButton');
// Sound keeps playing with the menu open, and the video fits beside the menu.
await cam.waitForTimeout(300);
check((await cam.evaluate(() => window.shapesonic.sonifier.master.gain.value)) > 0.5, 'the menu does not mute the sound');
const fit = await cam.evaluate(() => {
  const v = document.getElementById('canvas').getBoundingClientRect(), m = document.getElementById('menu').getBoundingClientRect();
  return { right: v.right, menuLeft: m.left };
});
check(fit.right <= fit.menuLeft + 1, `the camera view fits beside the open menu (view right ${fit.right.toFixed(0)}, menu left ${fit.menuLeft.toFixed(0)})`);
await cam.click('#calibrationDetails summary');
check((await cam.locator('.webhands-calibration').count()) === 1, 'the calibration panel is in the menu');
await shot(cam, 'camera-menu');

// A second local camera: listed, shown as a thumbnail, offered for position calibration; then removed.
const cameras = () => cam.evaluate(() => window.shapesonic.rig.cameras.map((c) => c.kind));
check((await cameras()).join() === 'main', 'one camera: the main one');
await cam.click('#addCamera');
await cam.waitForFunction(() => window.shapesonic.rig.cameras.length === 2, null, { timeout: 30000 });
await cam.waitForTimeout(3000);
check((await cam.evaluate(() => window.shapesonic.rig.tracker.sources.length)) === 2, 'the second camera joined the multi-camera tracker');
check(await cam.evaluate(() => document.querySelector('#thumbs video')?.videoWidth > 0), 'its live thumbnail plays');
check(/not calibrated/.test(await cam.textContent('#cameraList')), `the list says it needs calibrating: "${(await cam.textContent('#cameraList')).replace(/\s+/g, ' ')}"`);
check((await cam.locator('button:has-text("Calibrate cameras (12 s)")').count()) === 1, 'the calibration panel offers camera-position calibration');
await shot(cam, 'two-cameras');
await cam.click('#cameraList button[aria-label^="Remove"]');
check((await cameras()).join() === 'main' && (await cam.locator('#thumbs figure').count()) === 0, 'removing it drops the camera and its thumbnail');

// Switching the main camera rebuilds the tracker.
const other = await cam.evaluate(() => [...document.querySelectorAll('#cameraSelect option')].find((o) => !o.selected)?.value);
await cam.selectOption('#cameraSelect', other);
await cam.waitForFunction((id) => window.shapesonic.rig.main?.handle?.cameraId === id, other, { timeout: 30000 });
await cam.waitForTimeout(3000);
check(/fps/.test(await cam.textContent('#trackingStatus')), 'switching the main camera keeps tracking');

// Phones: the join component (registers with the public PeerJS server, so this needs internet).
await cam.click('#phoneDetails summary');
await cam.waitForFunction(() => /Code |can't join/.test(document.querySelector('.webhands-join')?.shadowRoot?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
const joinText = await cam.evaluate(() => document.querySelector('.webhands-join')?.shadowRoot?.textContent ?? '');
// The QR link: webhands' hosted phone page, or this site's own phone.html when the app itself is served over HTTPS.
const phonePage = base.startsWith('https:') ? new URL('phone.html', base).href : 'https://yig.github.io/webhands3d/remote.html';
check(/Code /.test(joinText) && joinText.includes(`${phonePage}?host=`), `the phone QR code points to ${phonePage} (${joinText.match(/Code \S+|can't join[^.]*/)?.[0] ?? 'no status'})`);

// A "phone": another page opens the QR link (with a fake camera) and joins over PeerJS.
const link = joinText.match(/https?:\/\/\S+?host=webhands3d-[0-9a-f]+/)?.[0];
if (link) {
  const remote = await browser.newPage();
  remote.on('pageerror', (e) => errors.push(`phone page: ${e.message}`));
  await remote.goto(link);
  await remote.locator('button', { hasText: 'Start & connect' }).click({ timeout: 20000 }).catch(() => {});
  await cam.waitForFunction(() => window.shapesonic.rig.cameras.some((c) => c.kind === 'phone'), null, { timeout: 45000 }).catch(() => {});
  await cam.waitForTimeout(3000);
  const rows = await cam.evaluate(() => window.shapesonic.rig.describe().filter((d) => d.camera.kind === 'phone').map((d) => d.text));
  check(rows.length === 1 && /fps/.test(rows[0]), `the phone joined through PeerJS and streams (${rows[0] ?? 'did not join'})`);
  await remote.close();
}
await cam.close();

// This app's own phone page (used when the app is deployed over HTTPS) loads.
const phone = await open('phone.html', 'phone');
await phone.waitForTimeout(3000);
check((await phone.locator('#remote *').count()) > 0, 'the phone page renders the remote-camera component');
await phone.close();

check(!errors.length, `no console errors${errors.length ? ':\n  ' + errors.join('\n  ') : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
