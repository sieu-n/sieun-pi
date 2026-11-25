/**
 * The agents a duty precheck reads: GET /api/agents less test agents (a walk's throwaway, `test: true`) and archived ones. The route leaves
 * both out by default (server/threads.ts `agents`), and the prechecks filter again so a call with ?archived=1 or ?test=1, or a change of that
 * default, never brings a throwaway agent into a sweep or a count (fable auditor, 11-26).
 */
export const realAgents = <T extends { archived?: boolean; test?: boolean }>(agents: readonly T[]): T[] => agents.filter(agent => !agent.archived && !agent.test);
