import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { readSessionFile, sessionFile, sessionFiles, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the slop cuts of 10-16 (owner: "scrap all that slop", and before it tokens per second fell from 500k-600k to
 * about 100k). A fresh chat in auto-sns-agent gets one ordinary read-only question with a number and runs an hour alone. The judge reads the
 * family's session files for the server notices the cuts removed, the chat's first [corrections] block, the chat's turn waits, and system
 * tokens per second from a copy of usage.duckdb. The criteria live in the run folder's criteria.md.
 */
/** One ordinary task per chat name, so each run gets a new chat and a new task; `counts` and `section` find the answer in its first reply. */
export const TASKS: Record<string, { message: string; counts: RegExp; section: RegExp; drop: RegExp }> = {
  "wiki edits this week": {
    message: "how many llm-wiki pages changed in the last 7 days, and which section changed the most? then find the 10 pages that changed " +
      "the most and what changed in each, and keep a report with that list updated. i want all 10 explained by tonight",
    counts: /\b\d[\d,]*\s+(llm-wiki |wiki |distinct |unique |changed )?(pages?|changes?|edits?|commits?|files?)\b/gi,
    section: /\b(apps|domains|projects|experiments|agents|sessions|archive)\b/i,
    drop: /\b(the|top|all) 10\b|\b10 pages\b|\b7 days\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  },
  "apps file changes": {
    message: "how many files under auto-sns-agent's apps folder changed in the last 7 days, and which app changed the most? then find the 10 " +
      "files that changed the most and what changed in each, and keep a report with that list updated. i want all 10 explained by tonight",
    counts: /\b\d[\d,]*\s+(files?|changes?|commits?|lines?)\b/gi,
    section: /\b(admin|anything|anything-be|api-portal|blog|crawler-v3|dm-extension|infra|llm-wiki|research-agent-be|research-app|search|vent|virev-demo)\b/i,
    drop: /\b(the|top|all) 10\b|\b10 files\b|\b7 days\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  },
  "sieun-pi main commits": {
    message: "how many commits landed on sieun-pi main in the last 3 days, and which component got the most of them? then find the 10 biggest " +
      "commits and what each one changed, and keep a report with that list updated. i want all 10 explained by tonight",
    counts: /\b\d[\d,]*\s+(commits?|changes?|files?|lines?)\b/gi,
    section: /\b(user-history|pi-pool|global-rules|skills|scripts|docs|tests|deploy|config)\b/i,
    drop: /\b(the|top|all) 10\b|\b10 (biggest )?commits\b|\b3 days\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  },
  "sieun-pi changes this week": {
    message: "how many commits landed on sieun-pi main in the last 5 days, and which component got the most of them? then find the 10 biggest " +
      "commits and what each one changed, and keep a report with that list updated. i want all 10 explained by tonight",
    counts: /\b\d[\d,]*\s+(commits?|changes?|files?|lines?)\b/gi,
    section: /\b(user-history|pi-pool|global-rules|skills|scripts|docs|tests|deploy|config)\b/i,
    drop: /\b(the|top|all) 10\b|\b10 (biggest )?commits\b|\b5 days\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  },
  "dev branch commits": {
    message: "how many commits landed on auto-sns-agent's sieun/dev in the last 7 days, and which app got the most of them? then find the 10 " +
      "biggest commits and what each one changed, and keep a report with that list updated. i want all 10 explained by tonight",
    counts: /\b\d[\d,]*\s+(commits?|changes?|files?|lines?)\b/gi,
    section: /\b(admin|anything|anything-be|api-portal|blog|crawler-v3|dm-extension|infra|llm-wiki|research-agent-be|research-app|search|vent|virev-demo)\b/i,
    drop: /\b(the|top|all) 10\b|\b10 (biggest )?commits\b|\b7 days\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  },
};
const taskOf = (name: string) => { const task = TASKS[name]; if (!task) throw new Error(`no ordinary-hour task for the chat name "${name}"; known: ${Object.keys(TASKS).join(", ")}`); return task; };
const HOUR = 60 * 60_000;
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
/** measure.md (slop-cuts work folder), tokens per second in thousands. */
const BEFORE = { day1013: 109, last12h: 97 };

/** The server notices the cuts removed, by the opening words their code wrote (cuts.md; the old text is in 0fd072f). */
const REMOVED: readonly [string, RegExp][] = [
  ["brief check quote or Split finding", /^\[brief check\][\s\S]*(Owner's words \(verbatim\):|is not in any owner message|The newest owner message you quoted|It says no owner message started|No `Split:` line)/],
  ["[brief] rules changed", /^\[brief\] Your chat rules changed/],
  ["step scan", /^(\[job\] )?Step scan/],
  ["Mac usable watch ask", /^\[job\] [^\n]*\(session [0-9a-f]{8}\) (holds its kernel and worker|ended its turn \d+ min ago and still holds|has been in one )/],
  ["hung call interrupt", /^The chat service interrupted your /],
  ["[alert]", /^\[alert\] /],
  ["job cleanup notice", /^\[job\] [^\n]*? was (archived|ended) after |^\[job\] [^\n]*? (was deleted|is gone)\. The service stopped/],
  ["[board] Ops not applied", /^\[board\] Ops not applied/],
  ["[corrections] update", /^\[corrections\] Update to the owner's rules\./],
  ["[duty] send-back", /^\[duty\] (Your .+? run is not done:|.+? still misses)/],
];
/** Refusals the cuts removed, read from tool results other than ipython and bash, so an agent reading the code is not counted. */
const REFUSALS: readonly string[] = ["is a Build step and cannot move to", "c66: the owner keeps duties daily", "it needs the owner's go. Add one For you todo",
  "This todo holds the owner's answer on a step that needs the owner's go", "This todo holds a place for something not ready"];
/**
 * Refusals the cuts removed that reach an ipython or bash result: a guard's block opens the result, and a CLI's refusal (pi-pool set, duties
 * add.ts) shows anywhere in it. Their source lines are gone at HEAD, so code an agent reads cannot carry them.
 */
const GUARD_REFUSALS: readonly string[] = ["global-rules grep guard:", "global-rules merge guard:", "repo guard (guard-error)"];
const CLI_REFUSALS: readonly string[] = ["refused: an agent may lower", "refused: an agent may not switch", "counts the size of text ("];
/** A duty fix job the duty fix opener used to start: a root named "fix <duty> <chat> HH:MM". */
const FIX_JOB = /^fix .+ \d{1,2}:\d{2}$/;
const SKIP = new Set(["harness_digest", "refinement_outcome", "ipython_state", "ipython_state_restored"]);

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const median = (values: readonly number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0; };
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Custom { at: number; customType: string; data: Record<string, unknown> }

/** The `custom` entries of a session file (not sent to the model): correction checkpoints and pi-pool queue places. */
function customs(file: string): Custom[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    if (!line.includes('"type":"custom"')) return [];
    try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; timestamp?: string; data?: Record<string, unknown> };
      return entry.type === "custom" ? [{ at: Date.parse(entry.timestamp ?? "") || 0, customType: entry.customType ?? "", data: entry.data ?? {} }] : [];
    } catch { return []; }
  });
}

/** Tool results in a session file at or after `since` that carry a removed refusal. */
function refusals(file: string, since: number): { at: number; tool: string; text: string }[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    if (!line.includes('"toolResult"') || ![...REFUSALS, ...GUARD_REFUSALS, ...CLI_REFUSALS].some(words => line.includes(words))) return [];
    try {
      const entry = JSON.parse(line) as { timestamp?: string; message?: { role?: string; toolName?: string; content?: unknown } };
      const at = Date.parse(entry.timestamp ?? "") || 0;
      const tool = entry.message?.toolName ?? "";
      if (entry.message?.role !== "toolResult" || at < since) return [];
      const text = JSON.stringify(entry.message.content ?? "");
      const first = Array.isArray(entry.message.content) ? String((entry.message.content[0] as { text?: unknown } | undefined)?.text ?? "") : "";
      const shell = tool === "ipython" || tool === "bash";
      const words = shell ? GUARD_REFUSALS.find(candidate => first.startsWith(candidate)) ?? CLI_REFUSALS.find(candidate => text.includes(candidate))
        : REFUSALS.find(candidate => text.includes(candidate));
      return words ? [{ at, tool, text: text.slice(Math.max(0, text.indexOf(words) - 120), text.indexOf(words) + 120) }] : [];
    } catch { return []; }
  });
}

/** The chat's family: the chat, the sessions its Agents card listed, its check-in jobs, and every session file under their folders. */
function family(run: string, state: RunState): { files: Map<string, string>; duty: Map<string, string>; names: Map<string, string> } {
  const roots = new Set([state.chat.id]);
  const names = new Map<string, string>([[state.chat.id, state.chat.name]]);
  const duty = new Map<string, string>();
  const agents = join(run, "agents");
  for (const file of existsSync(agents) ? readdirSync(agents).sort() : []) {
    for (const agent of JSON.parse(readFileSync(join(agents, file), "utf8")) as { sessionId?: string; name?: string }[]) {
      if (!agent.sessionId) continue;
      roots.add(agent.sessionId);
      names.set(agent.sessionId, agent.name ?? "");
      if (/^check-in /.test(agent.name ?? "")) duty.set(agent.sessionId, agent.name!);
    }
  }
  const runs = join(run, "runs.jsonl");
  for (const line of existsSync(runs) ? readFileSync(runs, "utf8").split("\n") : []) {
    if (!line.trim()) continue;
    const job = (JSON.parse(line) as { job?: { id?: string; name?: string } }).job;
    if (job?.id) { roots.add(job.id); duty.set(job.id, job.name ?? ""); names.set(job.id, job.name ?? ""); }
  }
  const files = new Map<string, string>();
  for (const id of roots) {
    for (const file of sessionFiles(id)) if (/^[0-9a-f-]{36}$/.test(basename(file, ".jsonl"))) files.set(basename(file, ".jsonl"), file);
    const own = sessionFile(id, [state.chat.id]);
    if (own) files.set(id, own);
  }
  return { files, duty, names };
}

/** The [corrections] block of the chat's first prompt: its first correction checkpoint, else the first Prompt view capture that holds one. */
function firstCorrections(run: string, chatFile: string, chat: string): { from: string; text: string } | null {
  const first = customs(chatFile).find(entry => entry.customType === "chat_correction_checkpoint");
  if (first && typeof first.data.text === "string") return { from: `checkpoint ${iso(first.at)}`, text: first.data.text };
  const dir = join(run, "prompts", chat);
  for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const found: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === "string") { const at = value.indexOf("[corrections]"); if (at >= 0) found.push(value.slice(at).split(/\n\s*\n/)[0]!); }
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (found.length) return { from: `Prompt view capture ${file}`, text: found[0]! };
  }
  return null;
}

/** The first text the owner reads: the chat's first tell_owner, else the last text of its first turn. */
function firstReply(events: readonly SessionEvent[], since: number, task: string): { at: number; text: string } | null {
  const told = events.find(event => event.kind === "call" && event.tool === "tell_owner" && event.at >= since);
  if (told && told.kind === "call") return { at: told.at, text: String((JSON.parse(told.input) as { text?: string }).text ?? "") };
  const next = events.find(event => event.kind === "text" && event.at > since + 1000 && !SKIP.has(event.customType ?? "") && event.text.trim() !== task);
  const text = events.filter(event => event.kind === "assistant" && event.at >= since && (!next || event.at < next.at)).at(-1);
  return text && text.kind === "assistant" ? { at: text.at, text: text.text } : null;
}

interface Usage { system: number; family: number; chat: number; calls: number; last: number; chatCalls: { start: number; end: number }[]; error?: string }
/** Tokens in the window from a copy of usage.duckdb (input+output+cache_read+cache_write, source prime-agent, by ended_at), as in measure.md. */
async function usage(run: string, start: number, end: number, ids: readonly string[], chat: string): Promise<Usage> {
  const empty: Usage = { system: 0, family: 0, chat: 0, calls: 0, last: 0, chatCalls: [] };
  try {
    const copy = join(run, "usage.duckdb");
    copyFileSync(join(DATA, "usage.duckdb"), copy);
    if (existsSync(join(DATA, "usage.duckdb.wal"))) copyFileSync(join(DATA, "usage.duckdb.wal"), copy + ".wal");
    const instance = await DuckDBInstance.create(copy, { threads: "2", memory_limit: "512MB" });
    const db = await instance.connect();
    const where = `source = 'prime-agent' AND ended_at >= ${Math.floor(start)} AND ended_at < ${Math.floor(end)}`;
    const list = ids.filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => `'${id}'`).join(", ") || "''";
    const sum = "coalesce(sum(input + output + cache_read + cache_write), 0)";
    const [row] = (await db.runAndReadAll(`SELECT ${sum}, count(*), max(ended_at), (SELECT ${sum} FROM calls WHERE ${where} AND session_id IN (${list})),
      (SELECT ${sum} FROM calls WHERE ${where} AND session_id = '${chat}') FROM calls WHERE ${where}`)).getRowsJS() as unknown[][];
    const calls = (await db.runAndReadAll(`SELECT started_at, ended_at FROM calls WHERE source = 'prime-agent' AND session_id = '${chat}' AND ended_at >= ${Math.floor(start) - HOUR}
      ORDER BY started_at`)).getRowsJS() as unknown[][];
    db.closeSync(); instance.closeSync();
    const num = (value: unknown): number => Number(value ?? 0);
    return { system: num(row![0]), calls: num(row![1]), last: num(row![2]), family: num(row![3]), chat: num(row![4]),
      chatCalls: calls.map(([started, ended]) => ({ start: num(started ?? ended), end: num(ended) })) };
  } catch (error) { return { ...empty, error: error instanceof Error ? error.message : String(error) }; }
}

async function judge(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const start = state.windowStart;
  const task = taskOf(state.chat.name);
  const now = Date.now();
  const end = Math.min(now, start + HOUR);
  const { files, duty, names } = family(run, state);
  const chatFile = files.get(state.chat.id) ?? "";
  const sessions = [...files].map(([id, file]) => ({ id, file, events: readSessionFile(file) }));
  const ids = new Set(sessions.map(session => session.id));
  const label = (id: string): string => `${names.get(id) || id.slice(0, 8)}`;
  const checks: Check[] = [];

  const outside: string[] = [];
  const hits: string[] = [];
  const kept: string[] = [];
  const tags = new Map<string, number>();
  for (const { id, file, events } of sessions) {
    for (const event of events) {
      if (event.kind !== "text" || event.at < start || SKIP.has(event.customType ?? "")) continue;
      const text = event.text.trimStart();
      if (id === state.chat.id && event.role === "user" && text === task.message) continue;
      if (id === state.chat.id && event.role === "user" && !text.startsWith("[")) outside.push(`a typed message in the chat at ${iso(event.at)}: "${clip(text, 120)}"`);
      if (event.customType === "agent_message" && event.fromId && !ids.has(event.fromId) && event.relation !== "child" && event.relation !== "parent") {
        outside.push(`${event.from ?? event.fromId} messaged ${label(id)} at ${iso(event.at)}: "${clip(text, 120)}"`);
      }
      const tag = /^\[([a-z][a-z -]*)\]/.exec(text)?.[1] ?? (event.customType || (event.role === "user" ? "user text" : "custom"));
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
      for (const [kind, pattern] of REMOVED) if (pattern.test(text)) hits.push(`${kind} in ${label(id)} at ${iso(event.at)}: "${clip(text, 200)}"`);
      if (/^\[brief check\]/.test(text) && !REMOVED[0]![1].test(text)) kept.push(`${label(id)} at ${iso(event.at)}: "${clip(text, 160)}"`);
    }
    for (const refusal of refusals(file, start)) hits.push(`refusal in ${label(id)}'s ${refusal.tool} result at ${iso(refusal.at)}: "${clip(refusal.text, 200)}"`);
    const checkpoints = customs(file).filter(entry => entry.customType === "chat_correction_checkpoint");
    for (const again of checkpoints.slice(1)) if (again.at >= start) hits.push(`[corrections] re-send (${String(again.data.kind)}) in ${label(id)} at ${iso(again.at)}: "${clip(String(again.data.text ?? ""), 200)}"`);
  }
  for (const [id, name] of names) if (FIX_JOB.test(name)) hits.push(`fix job ${name} (${id}) started in the chat's family`);
  const serviceLog = join(run, "service.log");
  for (const line of existsSync(serviceLog) ? readFileSync(serviceLog, "utf8").split("\n") : []) if (/opened fix .+$/.test(line)) hits.push(`service.log: "${clip(line, 200)}"`);
  const elapsed = now - start;
  checks.push({ id: "a", ok: outside.length ? false : elapsed >= HOUR ? true : null, detail: `${Math.round(elapsed / 60_000)} min since ${iso(start)}; ` +
    (outside.length ? outside.join("; ") : `no typed message after the first and no message from outside the family of ${sessions.length} sessions`) });
  checks.push({ id: "b", ok: hits.length === 0, detail: hits.length ? `${hits.length} removed injections:\n${hits.slice(0, 20).map(hit => `    - ${hit}`).join("\n")}`
    : `none in ${sessions.length} sessions (${[...duty.values()].join(", ") || "no check-in job"} among them)` });

  const block = firstCorrections(run, chatFile, state.chat.id);
  const lines = block ? block.text.split("\n").map(line => line.trim()).filter(Boolean) : [];
  const header = lines[0] ?? "";
  const rules = lines.slice(1);
  const oneSentence = (line: string): boolean => !/[.!?]\s+[A-Z(]/.test(line.replace(/^- c\d+ /, ""));
  const bad = rules.filter(line => !/^- c\d+ /.test(line) || line.includes("(reopened:") || /Steps on .* belong to/.test(line) || !oneSentence(line));
  const headerOk = /^\[corrections\] The owner's corrections (in force|that bind jobs)/.test(header);
  checks.push({ id: "c", ok: block ? headerOk && rules.length > 0 && bad.length === 0 : null, detail: block
    ? `${block.from}: header "${clip(header, 90)}", ${rules.length} rule lines, ${block.text.length} chars, longest rule line ${Math.max(0, ...rules.map(line => line.length))} chars` +
      (bad.length ? `; ${bad.length} lines are not "- cN <first sentence>":\n${bad.slice(0, 8).map(line => `    - (${line.length}) "${clip(line, 200)}"`).join("\n")}` : "")
    : "no [corrections] block found in the chat's checkpoints or Prompt view captures" });

  const used = await usage(run, start, end, [...ids], state.chat.id);
  const seconds = Math.max(1, (end - start) / 1000);
  const rate = (tokens: number): string => `${(tokens / seconds / 1000).toFixed(1)}k/s`;
  checks.push({ id: "d", ok: used.error ? false : true, detail: used.error ? `usage.duckdb copy could not be read: ${used.error}`
    : `system ${rate(used.system)} over ${Math.round(seconds / 60)} min (${used.calls} calls), against ${BEFORE.day1013}k/s on 10-13 and ${BEFORE.last12h}k/s in the 12 h before the cuts; ` +
      `the chat's family ${rate(used.family)}, the chat ${rate(used.chat)}; the copy's newest call ended ${used.last ? iso(used.last) : "never"}` });

  const queued = customs(chatFile).filter(entry => entry.customType === "pi-pool-queue" && entry.at >= start - 5 * 60_000 && entry.at < end);
  const chatEvents = sessions.find(session => session.id === state.chat.id)?.events ?? [];
  const waits = chatEvents.filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.at >= start - 5 * 60_000 && event.at < end && !SKIP.has(event.customType ?? "")).flatMap(event => {
    if (used.chatCalls.some(call => call.start <= event.at && event.at <= call.end)) return [];
    const next = used.chatCalls.find(call => call.start >= event.at);
    return next ? [{ at: event.at, wait: (next.start - event.at) / 1000, what: clip(event.text, 60) }] : [];
  });
  const waitSeconds = waits.map(entry => entry.wait);
  checks.push({ id: "d2", ok: queued.length === 0 && !used.error, detail: `${queued.length} pi-pool-queue entries in the chat${queued.length ? ` (${queued.map(entry => `${iso(entry.at)} "${String(entry.data.text ?? "")}"`).join("; ")})` : ""}; ` +
    `${waits.length} turns, wait median ${median(waitSeconds).toFixed(1)} s, longest ${Math.max(0, ...waitSeconds).toFixed(1)} s` +
    (waits.length ? `:\n${waits.map(entry => `    - ${iso(entry.at)} ${entry.wait.toFixed(1)} s "${entry.what}"`).join("\n")}` : "") });

  const reply = firstReply(chatEvents, start - 5 * 60_000, task.message);
  const plain = reply ? reply.text.replace(task.drop, "") : "";
  const counts = plain.match(task.counts) ?? [];
  const section = plain.match(task.section)?.[0];
  checks.push({ id: "e", ok: reply ? counts.length > 0 && section !== undefined : null, detail: reply
    ? `${iso(reply.at)}, counts ${counts.length ? counts.join(", ") : "none"}, section ${section ?? "none"}: "${clip(reply.text, 600)}"` : "the chat has not replied" });

  const boardFile = join(DATA, "boards", `${state.chat.id}.json`);
  const todos = existsSync(boardFile) ? (JSON.parse(readFileSync(boardFile, "utf8")) as { todos?: { id: string; text: string }[] }).todos ?? [] : [];
  const ledger = existsSync(join(DATA, "corrections.json")) ? readFileSync(join(DATA, "corrections.json"), "utf8") : "";
  const leaks = [...todos.map(todo => `todo ${todo.id} "${clip(todo.text, 100)}"`), ...(ledger.includes(state.chat.id) ? ["a correction in corrections.json names this chat"] : [])];
  checks.push({ id: "f", ok: leaks.length === 0, detail: leaks.length ? leaks.join("; ") : "the chat's board has no todo and corrections.json does not name the chat" });

  const touched: string[] = [];
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+(pr\s+merge|run\s+(rerun|cancel))/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/];
  for (const { id, events } of sessions) for (const event of events) {
    if (event.kind === "call" && event.at >= start) for (const pattern of MUTATING) { const match = pattern.exec(event.input); if (match) touched.push(`${label(id)} ran "${clip(event.input.slice(Math.max(0, match.index - 40), match.index + 80), 140)}"`); }
  }

  const voided = checks.find(check => check.id === "a")!.ok === false;
  const verdict: Verdict = voided ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${basename(run)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(start)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one owner-style message and nothing seeded. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${run}/agents, boards, prompts, runs.jsonl, usage.duckdb and the ${sessions.length} session files of the family.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
    "## Seen, not judged", "",
    `- Texts that reached the family in the window, by opening tag: ${[...tags].sort((a, b) => b[1] - a[1]).map(([tag, count]) => `${tag} ${count}`).join(", ") || "none"}.`,
    `- Kept [brief check] steers (c47 findings only): ${kept.length ? kept.join("; ") : "none"}.`,
    `- Commands that push, deploy or write to production: ${touched.length ? touched.join("; ") : "none"}.`,
    `- Sessions: ${sessions.map(session => `${label(session.id)} ${session.id}`).join(", ")}.`, "",
  ].join("\n");
  return { verdict, text };
}

export const ordinaryHour: Scenario = {
  name: "ordinary-hour",
  headMessage: name => taskOf(name).message,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min on the server's clock. Nobody types into it or its jobs for the hour.`, "",
    "## The first message", "", `> ${taskOf(state.chat.name).message}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline; measure.md in the slop-cuts work folder holds the before numbers"); },
};
