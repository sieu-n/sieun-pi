import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/*
 * Where a session keeps its files, on Prime Agent and on upstream Pi. Prime names a root's transcript <agent dir>/sessions/<id>.jsonl and
 * keeps its kernel files in <agent dir>/session-artifacts/<id>. Pi names it <session dir>/<timestamp>_<id>.jsonl, with the session dir
 * <agent dir>/sessions/<cwd slug> or the one pi-host was given, and pi-rlm keeps the kernel files in <Pi agent dir>/session-artifacts/<id>
 * (packages/pi-family/paths.ts). A subagent's transcript sits in its own sub-<n> folder on both.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PI_TRANSCRIPT = new RegExp(`^[^_/]+_(${UUID})\\.jsonl$`);

/** The agent dir: Prime's own variable, else Pi's, else ~/.prime/agent. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PRIME_AGENT_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(homedir(), ".prime", "agent");
}

/** Pi's agent dir as upstream Pi's getAgentDir() finds it: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** The session id in a Pi transcript name, <timestamp>_<id>.jsonl, or null for any other name. */
export function piTranscriptId(file: string): string | null {
	return PI_TRANSCRIPT.exec(basename(file))?.[1] ?? null;
}

/**
 * The session's kernel folder (the kernel's RLM_SESSION_DIR) for its transcript: a subagent's own sub-<n> folder, else the root's folder
 * under session-artifacts. `sessionId` names a Pi root whose file name does not carry it. Null when the file is unknown.
 */
export function sessionDirOf(sessionFile: string | null | undefined, sessionId?: string | null): string | null {
	if (!sessionFile) return null;
	const dir = dirname(sessionFile);
	if (basename(dir).startsWith("sub-")) return dir;
	const piId = piTranscriptId(sessionFile);
	if (!piId) return basename(dir) === "sessions" ? join(dirname(dir), "session-artifacts", basename(sessionFile, ".jsonl")) : null;
	return join(piAgentDir(), "session-artifacts", sessionId || piId);
}
