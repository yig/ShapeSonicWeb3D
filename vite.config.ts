import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// webhands is used from its source (../webhands/src), so changes there are
// picked up without rebuilding its dist/. `npm run dev:lan` serves over HTTPS
// on the local network: camera access and WebXR need a secure context, so this
// is how to open the app on a phone or a Meta Quest.
const lan = !!process.env.SHAPESONIC_LAN;
const webhands = fileURLToPath(new URL('../webhands/src/index.ts', import.meta.url));

export default defineConfig({
  base: './',
  plugins: lan ? [basicSsl()] : [],
  resolve: {
    alias: { webhands },
    // Resolve these from this project even when imported by ../webhands/src.
    dedupe: ['@mediapipe/tasks-vision', 'three'],
  },
  server: {
    host: lan ? true : undefined,
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120000,
  },
});
