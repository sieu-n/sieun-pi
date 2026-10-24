import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ChatBoard } from "../../src/shared/types.ts";
import { inputRoots } from "./inputs.ts";

/** What `clean-room.ts setup` recorded about a run: the test chat, its fixture jobs, the seeds it sent, and when the measured window began. */
export interface RunState {
  scenario: string; chat: { id: string; name: string }; fixtures: Record<string, string>; sandbox: string; everyMs: number; release: string;
  board: string; seeds: string[]; setupAt: number; windowStart: number;
  /** When the measured window ends, set by `collect --until`; evaluate tears an open run down once it has passed. */
  until?: number;
  /** A second chat opened at the same time with its check-in paused, to compare against. */
  control?: { id: string; name: string };
}
/** A clean-room scenario: how it seeds the test chat, and how it judges the evidence against the criteria written before the run. */
export interface Scenario {
  name: string;
  /** The AGENTS.md of a sandbox folder the chat works in; absent: the chat works in `--cwd` like a chat the owner opens there. */
  agentsMd?(sandbox: string): string;
  /** Builds the folder the chat works in outside the run folder and returns it, so the chat sees no run file; `cleanup` removes it at teardown. */
  prepare?(run: string): string;
  /** Removes what `prepare` built, or what else the trial made, and returns the line teardown logs. */
  cleanup?(state: RunState): void | string;
  headMessage(chatName: string): string;
  /** A control chat with its own ordinary first message, opened with the chat and kept without a check-in. */
  control?: { name: string; message(name: string): string };
  fixtures: { name: string; brief(context: { chat: string; chatName: string; logFile: string; sandbox: string }): string }[];
  /** The board seeded from `--board`; absent: the chat makes its own board. */
  board?(copy: ChatBoard, context: { fixtures: Record<string, string>; sandbox: string }): { board: ChatBoard; changes: string[] };
  setupNotes(state: RunState, changes: readonly string[]): string;
  evaluate(run: string, state: RunState): { verdict: Verdict; text: string } | Promise<{ verdict: Verdict; text: string }>;
  /**
   * Collect judges the run on each pass and ends it at its first pass or fail, for a scenario whose every criterion waits for a send to exist
   * or fails on a fault that stays failed. Run-1 to run-3 of the c104 long-reply clean room ended open on 10-22 and 10-23 at their 4 h window
   * ends, since its jobs took 3.4 h and 3.5 h to report through account limit pauses and the third had not reported.
   */
  endsAtVerdict?: boolean;
  baseline(before: string): { verdict: Verdict; text: string };
}
/** `open`: the run has not yet reached a state a criterion needs, so it runs more cycles before a verdict. */
export type Verdict = "pass" | "fail" | "void" | "open";

/** One thing a session saw or did, read from its session file. */
export type SessionEvent =
  | { kind: "text"; at: number; role: "user" | "custom"; customType?: string; from?: string; fromId?: string; relation?: string; text: string }
  | { kind: "assistant"; at: number; text: string }
  | { kind: "call"; at: number; tool: string; input: string }
  | { kind: "sent"; at: number; to: string; toName: string; text: string };

export const PRIME_DIR = inputRoots().primeDir;
const SESSIONS = join(PRIME_DIR, "sessions");
const ARTIFACTS = join(PRIME_DIR, "session-artifacts");

const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

/** The events of one session file, in order. A missing or unreadable file gives none. */
/**
 * The turn Prime writes when a provider usage pause ends (its retry.provider.waitForUsage.pauseUntilReset path), word for word. Prime records
 * the pause first as a `provider_quota_park` entry in the same file, so a user turn with exactly these words counts as Prime's own only when an
 * unanswered park comes before it. On 10-20 clean-room run8 was voided by one such resume at 15:44:44.975Z.
 */
export const QUOTA_RESUME = "<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset; this resume is automatic " +
  "(retry.provider.waitForUsage.pauseUntilReset). Continue the interrupted task from where it stopped.\n</provider_quota_resumed>";

export function readSessionFile(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  const events: SessionEvent[] = [];
  let parks = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "custom_message") {
      const details = (entry.details ?? {}) as { from?: { sessionId?: string; sessionName?: string }; fromRelationship?: string };
      events.push({ kind: "text", at, role: "custom", customType: String(entry.customType ?? ""), text: blockText(entry.content),
        ...(details.from?.sessionName ? { from: details.from.sessionName } : {}), ...(details.from?.sessionId ? { fromId: details.from.sessionId } : {}),
        ...(details.fromRelationship ? { relation: details.fromRelationship } : {}) });
      continue;
    }
    if (entry.type === "custom" && entry.customType === "provider_quota_park") { parks += 1; continue; }
    if (entry.type !== "message") continue;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; details?: { sentAgentMessages?: { message?: string; target?: { sessionId?: string; sessionName?: string } }[] } };
    if (message.role === "user") {
      const text = blockText(message.content);
      if (parks > 0 && text.trim() === QUOTA_RESUME) { parks -= 1; events.push({ kind: "text", at, role: "custom", customType: "provider_quota_resumed", text }); }
      else events.push({ kind: "text", at, role: "user", text });
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = blockText(message.content);
      if (text.trim()) events.push({ kind: "assistant", at, text });
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "toolCall") events.push({ kind: "call", at, tool: String(block.name ?? ""), input: JSON.stringify(block.arguments ?? {}) });
      }
    }
    if (message.role === "toolResult") {
      for (const sent of message.details?.sentAgentMessages ?? []) {
        events.push({ kind: "sent", at, to: sent.target?.sessionId ?? "", toName: sent.target?.sessionName ?? "", text: sent.message ?? "" });
      }
    }
  }
  return events;
}

/** A root session's own file and every subagent file under its session-artifacts folder. */
export function sessionFiles(id: string): string[] {
  const files = [join(SESSIONS, `${id}.jsonl`)].filter(existsSync);
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith(id)) files.push(path);
    }
  };
  walk(join(ARTIFACTS, id));
  return files;
}
/** A session's own file: a root's under sessions/, else a subagent's `<id>.jsonl` anywhere under the session-artifacts folder of `roots`. */
export function sessionFile(id: string, roots: readonly string[] = []): string | undefined {
  const root = join(SESSIONS, `${id}.jsonl`);
  if (existsSync(root)) return root;
  const find = (dir: string, depth: number): string | undefined => {
    if (depth > 4 || !existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === `${id}.jsonl`) return path;
      if (entry.isDirectory()) { const found = find(path, depth + 1); if (found) return found; }
    }
    return undefined;
  };
  for (const parent of roots) { const found = find(join(ARTIFACTS, parent), 0); if (found) return found; }
  return undefined;
}
/** The id of the session whose file a session file's header names as its parent (`parentSession`), by that file's name; undefined when none. */
export function sessionParent(file: string): string | undefined {
  return existsSync(file) ? headerParent(readFileSync(file, "utf8")) : undefined;
}
/** The parent session id the first line of a session file's text names, by the file name of its `parentSession`; undefined when none. */
export function headerParent(text: string): string | undefined {
  try {
    const header = JSON.parse(text.split("\n", 1)[0] ?? "") as { type?: unknown; parentSession?: unknown };
    return header.type === "session" && typeof header.parentSession === "string" ? basename(header.parentSession).replace(/\.jsonl$/, "") : undefined;
  } catch { return undefined; }
}

/**
 * The sessions below `roots` by recorded ancestry, each with its file: a session file under the session-artifacts folder of a root in `scope`
 * whose header names a root or a session already found as its parent, repeated until none is added. Only recorded ids count, never a name.
 * Clean-room carried-wait run-4 on 10-24: the subagent free-space-page-writer (01a16f95), whose header names the chat's job "free space page"
 * (01a16f7c) as its parent, reported to that job, and the judge read it as outside because it knew only the chat's direct agents. A session
 * whose file is not in the store or the archive is not found, so its messages stay unproven.
 */
export function ownedDescendants(roots: Iterable<string>, scope: Iterable<string>): Map<string, string> {
  const owned = new Set(roots);
  const files = new Map<string, string>();
  for (const root of new Set(scope)) for (const file of sessionFiles(root)) {
    const id = basename(file).replace(/\.jsonl$/, "");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) && !files.has(id)) files.set(id, file);
  }
  const found = new Map<string, string>();
  for (let added = true; added;) {
    added = false;
    for (const [id, file] of files) {
      if (owned.has(id)) continue;
      const parent = sessionParent(file);
      if (parent === undefined || !owned.has(parent)) continue;
      owned.add(id);
      found.set(id, file);
      added = true;
    }
  }
  return found;
}

export const readSession = (id: string, roots: readonly string[] = []): SessionEvent[] => { const file = sessionFile(id, roots); return file ? readSessionFile(file) : []; };
