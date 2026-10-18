import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

/*
 * The record of outside sends (c37). Every guard layer that judges a send writes one JSON line here: the tool_call guard
 * (guard.ts), the kernel's run-time check (send-check.ts), the cua-driver proxy (cua-guard.ts) and the aside-browser skill.
 * A line says who (chat, session), when, what (target), the guard's decision and the OWNER_OK token. A backfill on 10-13
 * added the sends it found in older session transcripts. Chats read it with board.sends(), so "did an agent send anything" has one answer.
 */

/** "allowed": the guard let a send run with an approved OWNER_OK. "refused": the guard stopped it. "ran" and "failed": a transcript shows a send call that ran unchecked, or errored. */
export type SendDecision = "allowed" | "refused" | "ran" | "failed";

export interface SendEntry {
	at: string;
	decision: SendDecision;
	/** guard.ts, send-check.ts (the Python kernel), cua-guard.ts, aside-browser, or transcript (the backfill). */
	layer: "tool_call" | "kernel" | "cua-driver" | "aside-browser" | "transcript";
	/** The root chat session id, when known. */
	chat: string | null;
	/** The session that made the call: an id, or a path under session-artifacts such as <chat>/sub-5bbdac13. */
	session: string | null;
	/** What the send went to: a URL, a command, a page and its recipients. */
	target: string;
	/** Why the guard counts it as an outside send. */
	reason: string;
	ownerOk: string | null;
	/** For a transcript entry, <transcript file>:<line>. */
	where?: string;
}

/**
 * GLOBAL_RULES_SEND_LOG, else <AGENT_CHAT_DATA_DIR>/sends.jsonl, else next to GLOBAL_RULES_LOG (so every guard test that moves the
 * guard log also moves this one), else ~/.prime/agent/browser-chat/sends.jsonl, next to the boards that hold the OWNER_OK todos.
 */
export function sendLogPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.GLOBAL_RULES_SEND_LOG) return env.GLOBAL_RULES_SEND_LOG;
	if (env.AGENT_CHAT_DATA_DIR) return join(env.AGENT_CHAT_DATA_DIR, "sends.jsonl");
	if (env.GLOBAL_RULES_LOG) return join(dirname(env.GLOBAL_RULES_LOG), "sends.jsonl");
	return join(homedir(), ".prime", "agent", "browser-chat", "sends.jsonl");
}

/** The chat and session behind a session dir or transcript path: the parts after session-artifacts or sessions. */
export function sessionOf(path: string | undefined | null): { chat: string | null; session: string | null } {
	if (!path) return { chat: null, session: null };
	const parts = path.split(sep).filter(Boolean);
	const at = parts.findIndex((part) => part === "session-artifacts" || part === "sessions");
	if (at === -1 || at + 1 >= parts.length) return { chat: null, session: path };
	const rest = parts.slice(at + 1).map((part) => part.replace(/\.jsonl$/, ""));
	return { chat: rest[0] ?? null, session: rest.join("/") };
}

/** The guard's "refused, because X. <help>" text cut to X. */
export function sendReason(refusal: string): string {
	const why = refusal.replace(/^[\w -]*send guard: refused, because /, "");
	const cut = why.search(/\.\s+[A-Z]/);
	return cut === -1 ? why : why.slice(0, cut);
}

/** Appends one line. Never throws: the callers sit on the tool_call hot path, and a log that cannot be written must not stop a call. */
export function recordSend(entry: Omit<SendEntry, "at"> & { at?: string }, path: string = sendLogPath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const line: SendEntry = { ...entry, at: entry.at ?? new Date().toISOString(), target: entry.target.slice(0, 600), reason: entry.reason.slice(0, 300) };
		appendFileSync(path, `${JSON.stringify(line)}\n`);
	} catch {
		// See above.
	}
}

export function readSends(path: string = sendLogPath()): SendEntry[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: SendEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as SendEntry);
		} catch {
			// A torn line from a crashed writer is skipped.
		}
	}
	return out.sort((a, b) => a.at.localeCompare(b.at));
}
