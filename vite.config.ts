import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// `npm run dev:lan` serves over HTTPS on the local network: camera access and
// WebXR need a secure context, so this is how to open the app on a phone or a
// Meta Quest.
const lan = !!process.env.SHAPESONIC_LAN;

export default defineConfig({
  base: './',
  plugins: lan ? [basicSsl()] : [],
  server: { host: lan ? true : undefined },
  worker: { format: 'es' },
});
