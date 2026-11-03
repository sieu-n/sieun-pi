import { serveAgent, type Method } from '$lib/server/agent-api';
import type { RequestHandler } from './$types';

const serve =
	(method: Method): RequestHandler =>
	({ params, url, request }) =>
		serveAgent(method, params.verb, url, request);

export const GET = serve('GET');
export const POST = serve('POST');
export const PUT = serve('PUT');
export const PATCH = serve('PATCH');
export const DELETE = serve('DELETE');
export const OPTIONS = serve('OPTIONS');
