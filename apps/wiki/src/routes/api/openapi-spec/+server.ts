import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// The wiki documents the production API from any environment; OPENAPI_SPEC_URL overrides it for self-hosted forks.
const UPSTREAM = env.OPENAPI_SPEC_URL || 'https://api.virev.ai/openapi.json';

export async function GET({ fetch, setHeaders }) {
	let res: Response;
	try {
		res = await fetch(UPSTREAM);
	} catch (cause) {
		error(502, `Could not reach OpenAPI spec at ${UPSTREAM}: ${(cause as Error).message}`);
	}
	if (!res.ok) error(502, `OpenAPI spec upstream returned ${res.status} from ${UPSTREAM}`);
	const spec = await res.json();
	setHeaders({ 'cache-control': 'public, max-age=300' });
	return json(spec);
}
