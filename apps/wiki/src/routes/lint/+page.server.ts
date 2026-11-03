import { getLintReport } from '$lib/server/wiki-lint';

export async function load() {
	return { report: await getLintReport() };
}
