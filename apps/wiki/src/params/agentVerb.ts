/** The agent API verbs that src/lib/server/agent-api.ts serves. A matcher runs in the browser too, so it holds names only. */
export const AGENT_VERBS = [
	'search',
	'grep',
	'find',
	'tree',
	'page',
	'backlinks',
	'graph',
	'recent',
	'context-pack',
	'verify',
	'history',
	'activity',
	'diff',
	'changes',
	'stale',
	'supersede',
	'sessions',
	'assets',
	'gaps',
	'watches',
	'lint',
	'health',
	'manifest',
	'favorites',
	'skill-metrics',
	'openapi',
] as const;
export type AgentVerb = (typeof AGENT_VERBS)[number];

const verbs = new Set<string>(AGENT_VERBS);

export function match(param: string): boolean {
	return verbs.has(param) || param.startsWith('sessions/');
}
