# ShapeSonic 3D for the web

Hear an invisible 3D shape with your hands, in the browser. Hands are tracked
in 3D with [webhands](https://github.com/yig/webhands3d/) (`@ygingold/webhands3d`): from a webcam (plus more cameras and phones), or from a headset's hand
tracking via WebXR (Meta Quest Browser). A mouse-driven virtual hand works
without a camera.

```sh
npm install
npm run dev        # http://localhost:5173/
npm run dev:lan    # HTTPS on the local network, to open the app on a headset
npm test           # geometry, sonification, loaders
npm run smoke      # headless Chrome end-to-end check (with `npm run dev` running)
```

Use headphones. Pick a demo shape or load your own (OBJ, STL, PLY, GLB) from
the menu; the shape is hidden until you press **Show shape** (S). For accurate
distances with a webcam, calibrate it in the menu (Hands → Calibrate). For much
better depth, add another camera or a phone (Menu → Hands; a phone scans a QR
code and needs only internet), then calibrate the camera positions.

Design and architecture: [DESIGN.md](DESIGN.md).
