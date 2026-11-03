import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { visualEnrich } from '$lib/server/visual-enrich-runs';

// Same gate as /edit: the playground drives a paid vision call against the
// staging crawler — never available on a read-only (deployed) wiki, even if
// crawler env vars happen to be present.
const ENABLED = dev || env.WIKI_EDITABLE === 'true';

export async function POST({ request }) {
	if (!ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	const base = env.CRAWLER_API_URL;
	const key = env.CRAWLER_API_KEY;
	if (!base || !key)
		error(
			500,
			'CRAWLER_API_URL / CRAWLER_API_KEY missing from the env of the wiki server (the EnvironmentFile of sieun-pi-wiki.service).',
		);

	const { username, ...body } = await request.json();
	if (!username || typeof username !== 'string') error(400, 'username is required');

	// Each call is recorded as a kind=probe run in the shared run history (scripts/run_history.py).
	const out = await visualEnrich({ base, key, username, body, wikiDir: process.cwd() });
	if (!out.ok) error(out.status === 404 ? 404 : 502, out.message);
	const { answer, ok: _ok, ...run } = out;
	return json({ ...answer, ...run });
}
