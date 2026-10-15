import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// `npm run dev:lan` serves over HTTPS on the local network: camera access and
// WebXR need a secure context, so this is how to open the app itself on a
// phone or a Meta Quest. (Phones joining as cameras don't need it: see
// phonePageUrl in src/main.ts.)
const lan = !!process.env.SHAPESONIC_LAN;

const page = (name: string) => fileURLToPath(new URL(`${name}.html`, import.meta.url));

export default defineConfig({
  base: './',
  plugins: lan ? [basicSsl()] : [],
  server: { host: lan ? true : undefined },
  build: { rollupOptions: { input: { index: page('index'), phone: page('phone') } } },
  worker: { format: 'es' },
});
