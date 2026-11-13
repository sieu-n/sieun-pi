// The CPU-heavy checks of one page write, which agent-api.ts runs in a worker thread so the server's thread keeps
// answering reads. measured on us-metal02 on 2026-11-13 at load 140 to 190: the prose lint took 190 to 390 ms, the
// betterleaks spawn 160 to 190 ms and the duplicate check of a curated page 510 to 720 ms, all on that thread. During
// the 15:44Z wiki dream run a GET of the wiki gave no answer within 15 s from the M2 Air twice (devbox-wiki-public-down
// at 15:56Z), and 40 session-page writes at once held a GET of a static asset for 19.7 s.
import { parentPort } from 'node:worker_threads';
import { isLintedPath, ratchet } from '../src/lib/prose-lint.mjs';
import { scanWikiFiles } from '../src/lib/server/wiki-secrets.mjs';
import { heldByWrite } from './dup-held.mjs';

function settle(work) {
	try {
		return { value: work() };
	} catch (error) {
		return { error: String(error) };
	}
}

/** The lint ratchet (null for a path the lint skips), the secret findings and the duplicate rows of one write. */
export function writeChecks({ root, rel, before, after }) {
	return {
		lint: isLintedPath(rel) ? ratchet(before, after, { path: rel }) : null,
		secrets: settle(() => scanWikiFiles([{ path: rel, bytes: Buffer.from(after) }]).findings),
		held: settle(() => heldByWrite(root, rel, after)),
	};
}

parentPort?.on('message', ({ id, input }) => {
	try {
		parentPort.postMessage({ id, result: writeChecks(input) });
	} catch (error) {
		parentPort.postMessage({ id, error: String(error?.stack ?? error) });
	}
});
