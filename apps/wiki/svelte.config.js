import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// server.mjs serves the build on 127.0.0.1:5176 and puts /wiki in front of a path that lacks it, so old links
		// (:5176/page/..., :5176/raw/...) and agents' POST :5176/api/agent/* keep answering. :5184 proxies /wiki/* here.
		adapter: adapter({ out: 'build' }),
		paths: { base: '/wiki', relative: false },
		// Agents upload assets with multipart POSTs that carry no Origin (curl -F, httpx). The engine listens on loopback only
		// and :5184 fronts it, so the form CSRF check would only refuse them, as it did on 2026-11-03 after the move.
		csrf: { trustedOrigins: ['*'] },
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) => (filename.includes('node_modules') ? undefined : { runes: true }),
	},
};

export default config;
