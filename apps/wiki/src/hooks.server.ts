import type { Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { ALGO_PERF_PATH } from '$lib/algo-perf/markdown';
import { algoPerfMarkdown } from '$lib/server/algo-perf';

/**
 * `?format=md` returns the same view as text/plain markdown. A co-located `+server.ts` would split by Accept header, so
 * curl and a browser would get different answers for one URL.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname === `${base}${ALGO_PERF_PATH}` && event.url.searchParams.get('format') === 'md') {
		return algoPerfMarkdown(event.url);
	}
	return resolve(event);
};
