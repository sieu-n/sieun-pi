// The wiki server the HTTP tests call: WIKI_BASE, else the engine on 127.0.0.1:5176 under its base path, else skip.
const DEV_SERVER = ['http://127.0.0.1:5176/wiki'];

// Every request to the wiki server takes its own socket, because the server closes a keep-alive socket idle for 5 s,
// and a test file whose event loop is held past that loses a socket already carrying its next request (ECONNRESET,
// turbo-force run 39507516434).
export const wikiFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, connection: 'close' } });

function answers(base, timeoutMs) {
	return wikiFetch(`${base}/api/agent/find?glob=apps/*`, { signal: AbortSignal.timeout(timeoutMs) })
		.then((r) => r.ok)
		.catch(() => false);
}

export async function wikiBase() {
	if (process.env.WIKI_BASE) return process.env.WIKI_BASE;
	for (const base of DEV_SERVER) {
		if (await answers(base, 15_000)) return base;
	}
	console.log(`llm-wiki UNREACHABLE at ${DEV_SERVER.join(' / ')}: tests SKIPPED, not passed`);
	return null;
}
