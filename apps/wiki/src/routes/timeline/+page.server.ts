import { filterLogs, getLogFacets, getLogIndex } from '$lib/server/wiki-logs';

export async function load({ url }) {
	const app = url.searchParams.get('app') ?? undefined;
	const tag = url.searchParams.get('tag') ?? undefined;
	const status = url.searchParams.get('status') ?? undefined;

	const all = await getLogIndex();
	const logs = filterLogs(all, { app, tags: tag ? [tag] : undefined, status });
	const facets = await getLogFacets();

	return { logs, facets, filter: { app, tag, status }, total: all.length };
}
