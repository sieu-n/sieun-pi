import { error, json } from '@sveltejs/kit';
import { isComponent, type RunsExport } from '$lib/run-history';
import { runHistory } from '$lib/server/run-history';

/** GET [?component=c] → `{ runs }` from the shared run history. Read-only, so the served wiki answers it too. */
export async function GET({ url }) {
	const component = url.searchParams.get('component');
	if (component !== null && !isComponent(component)) error(400, `component must be a slug: ${component}`);
	try {
		const args = component ? ['export', '--component', component] : ['export'];
		return json(await runHistory<RunsExport>(args), { headers: { 'cache-control': 'no-store' } });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		error(500, `run history export failed: ${msg}`);
	}
}
