#!/usr/bin/env node
// The wiki engine's server: the adapter-node build under build/, on 127.0.0.1:5176 by default (WIKI_PORT, WIKI_HOST).
// The app is built with paths.base '/wiki', and a request whose path lacks it gets it here, inside the server, with no
// redirect, so old links (:5176/page/..., :5176/raw/...) and agents' POST :5176/api/agent/* keep answering.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = '/wiki';

// adapter-node refuses a body over 512 KB by default; the dev server it replaces took any size, and pages, session
// logs and asset uploads pass that.
process.env.BODY_SIZE_LIMIT ??= 'Infinity';
// /health names the commit this release was built from (scripts/release-wiki.mjs writes release.json).
const release = join(here, '../../release.json');
if (!process.env.WIKI_REVISION && existsSync(release)) {
	try {
		process.env.WIKI_REVISION = JSON.parse(readFileSync(release, 'utf8')).sha ?? '';
	} catch {
		// an unreadable release.json leaves the revision unknown
	}
}

const { handler } = await import('./build/handler.js');

/** `/page/x` becomes `/wiki/page/x` and `/` becomes `/wiki/`; `/wiki` and `/wiki/...` stay as they are. */
export function withBase(url) {
	const path = url.split('?')[0];
	return path === BASE || path.startsWith(`${BASE}/`) ? url : `${BASE}${url}`;
}

const port = Number(process.env.WIKI_PORT ?? 5176);
const host = process.env.WIKI_HOST ?? '127.0.0.1';
const server = createServer((req, res) => {
	req.url = withBase(req.url ?? '/');
	handler(req, res);
});
server.listen(port, host, () => console.log(`wiki engine on http://${host}:${port}${BASE}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
