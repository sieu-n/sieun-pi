import { error } from '@sveltejs/kit';
import { gitStatus } from '$lib/server/git-status';

/** GET → the live branch snapshot of scripts/ci/git-status.mjs: staging, main, each dev branch, the newest lands, release runs going now. */
export async function GET() {
	try {
		return new Response(await gitStatus(), {
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	} catch (e) {
		error(500, `git status failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
