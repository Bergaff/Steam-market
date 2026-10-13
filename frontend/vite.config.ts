import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Local dev: Vite serves the SPA on :5173 and proxies API calls to the
// Worker (wrangler dev) on :8787. Production build lands in dist/ and is
// served by the Worker itself (wrangler.jsonc -> assets).
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		host: '0.0.0.0',
		port: 5173,
		allowedHosts: ['.e2b.app'],
		proxy: {
			'/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
			'/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
	},
});
