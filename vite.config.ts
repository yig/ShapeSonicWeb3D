import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

// `npm run dev:lan` serves over HTTPS on the local network: camera access and
// WebXR need a secure context, so this is how to open the app on a phone or a
// Meta Quest, and how phones join as cameras.
const lan = !!process.env.SHAPESONIC_LAN;

/** Dev only: /shapesonic-info → this server's LAN addresses, so the phone QR code works when the page is on localhost. */
function lanInfo(): Plugin {
  return {
    name: 'shapesonic-lan-info',
    configureServer(server) {
      server.middlewares.use('/shapesonic-info', (_req, res) => {
        const address = server.httpServer?.address();
        const port = address && typeof address === 'object' ? address.port : server.config.server.port;
        const protocol = server.config.server.https ? 'https' : 'http';
        const urls = Object.values(networkInterfaces())
          .flat()
          .filter((a) => a && a.family === 'IPv4' && !a.internal)
          .map((a) => `${protocol}://${a!.address}:${port}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ urls }));
      });
    },
  };
}

const page = (name: string) => fileURLToPath(new URL(`${name}.html`, import.meta.url));

export default defineConfig({
  base: './',
  plugins: [lanInfo(), ...(lan ? [basicSsl()] : [])],
  server: { host: lan ? true : undefined },
  build: { rollupOptions: { input: { index: page('index'), phone: page('phone') } } },
  worker: { format: 'es' },
});
