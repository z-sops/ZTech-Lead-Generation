import { defineConfig } from 'vite';

const devWsOrigin = `ws://localhost:${process.env.VITE_PORT || 5173}`;

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist-renderer'
  },
  plugins: [
    {
      name: 'ztech-dev-csp-hmr-websocket',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace("connect-src 'self'", `connect-src 'self' ${devWsOrigin}`);
      }
    }
  ]
});
