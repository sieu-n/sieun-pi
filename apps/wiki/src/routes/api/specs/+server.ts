import type { RequestEvent } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { localAccess, pageData } from './store.server';
/** The same data the page loads; the page re-fetches it after a run or an edit. */
export const GET = (event: RequestEvent) =>
	json(pageData(localAccess(event)), { headers: { 'Cache-Control': 'no-store' } });
