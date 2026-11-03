import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

const ENABLED = dev || env.WIKI_EDITABLE === 'true';

export function load() {
	if (!ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	return {};
}
