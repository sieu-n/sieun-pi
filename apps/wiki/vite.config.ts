import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
	plugins: [sveltekit()],
	server: {
		host: 'localhost',
		port: 5177,
		strictPort: true,
		allowedHosts: ['.ts.net'],
		// content/ holds agent-written files that no module imports; the server reads and watches them itself
		// (src/lib/server/wiki.ts). Watching them here costs memory and CPU.
		watch: { ignored: ['**/content/**'] },
	},
}));
