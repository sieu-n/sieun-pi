import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sourceRevision } from '$lib/server/source-revision';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Liveness plus the revision this server runs: the source tree digest in dev, the release's commit when built (server.mjs). */
export async function GET() {
	const commit = env.WIKI_REVISION ?? '';
	const revision = dev ? await sourceRevision(process.cwd()) : FULL_SHA.test(commit) ? commit : null;
	return json({ status: 'ok', revision }, { headers: { 'cache-control': 'no-store' } });
}
