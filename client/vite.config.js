import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.PROXY_TARGET || 'http://localhost:3000';
  // Lesson media lives behind the app's own CloudFront distribution, not the
  // API backend, so it needs its own target. Proxying (rather than pointing the
  // app at the absolute URL) keeps /videos same-origin in dev too — the video
  // player and thumbnail canvas both require that.
  const mediaProxyTarget = env.MEDIA_PROXY_TARGET || 'https://d2o0cbe2zunqkr.cloudfront.net';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5174,
      // The reference-clip selector is shared with the Lambda (lambda/shared).
      fs: { allow: [__dirname, path.resolve(__dirname, '../lambda/shared')] },
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
          configure: (proxy) => {
            proxy.on('error', (err, _req, res) => {
              console.warn('[proxy error]', err.message);
              if (res.writeHead && !res.headersSent) {
                res.writeHead(502);
              }
              res.end();
            });
          },
        },
        '/videos': {
          target: mediaProxyTarget,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        '/inference/progress': {
          target: proxyTarget,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        '/train/progress': {
          target: proxyTarget,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
  };
});
