/**
 * Duty precheck: agent memory works (owner's words, #sw-factory-build, 11-20, msg mwojbdrv: "is memory working as intended?", then msg
 * mwojhtg4: "ideal하게 어떤 데이터가 각각 있을거 같냐니까? 그리고 그렇게 자동적으로 알아서 시스템이 굴러갈때까지 계속 감시하고 고치라니까?", c228).
 * Each real agent of :5184 (agents.json, not archived and not a walk's test agent) keeps its own memory in its folder's Prime harness store,
 * `<agents dir>/<slug>/harness/harness_state.json`, which pi-host loads into every thread of the agent. The memory review job wrote what each
 * store should hold to `~/work/agent-memory/ideal.json`: expected entries with the words a right entry holds, 3 recall questions with the
 * words a right answer holds, the old chats whose corrections belong to the agent, and what a store must not hold.
 *
 * Metrics:
 *   agents_on_ideal_pct, the headline: the share of real agents whose store holds every expected entry and no secret value, must-not
 *     entry with `match` words or scratch entry; an agent whose ideal expects nothing matches while its store is empty. An agent made under a day ago with
 *     no ideal.json row yet is not measured (`agents_ideal_unwritten`, flag `ideal_unwritten`), like a correction under a day old: on 11-24
 *     crawler-guy, made 3 h before the run, read as off its ideal. After a day a missing row is a miss.
 *   corrections_captured_pct: the share of the owner's corrections about an agent, at least a day old, that its store names by id or msg id;
 *     a correction ideal.json lists in `general_corrections` binds every agent, reaches it through the ledger and is left out.
 *   scratch_entries: entries in the agents' stores that are session state or step status instead of lasting knowledge. Each one puts its
 *     agent off its ideal, since ideal.json rules.must_not names both, so the headline carries it and the duty lists no metric for it.
 *   recall_right_pct: a blind fresh session of each agent answers its 3 questions; the share whose answer holds the expected words. A
 *     session whose wait ran out with no reply got no model answer (`unanswered`), so its questions are not measured: the share is over
 *     the sessions that answered, `recall_agents_unmeasured` counts the rest, and when none answered the metric keeps the value of the
 *     newest run in LAST_RUNS_FILE whose detail holds an answered session (`recall_carried_at`). The
 *     session is a throwaway `test: true` agent made through POST /api/agents with a copy of the agent's brief and store, so no answer writes
 *     into the real store and no owner list shows it; it is archived and its folder deleted after the answer, and a sweep before and after
 *     the run archives and deletes any recall agent a killed run left.
 *   recall_agents_left: recall agents still unarchived or with a folder after the run (target 0).
 *   skills_drift: the items `sw skills check` lists (GET /api/skills/check), each place the skill folders on the boxes differ from the skills
 *     DB, such as a folder no row owns or a row whose git folder left main (target 0). Memory is what one agent keeps and a skill is what every
 *     agent keeps, so this duty watches both (#sw-factory-build p193, 11-24: "지금 skills sdk가 제대로 적용된거야?").
 *
 * A match word list is all-of, case-insensitive, and a word written "a|b" takes either form. A form starts at a word start, and a form of
 * up to 3 characters is a whole word, so "no" does not match "now"; a longer form may run on, so "revok" matches "revoked".
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/agent-memory.ts [--no-recall] [--only <slug,...>] [--ideal <file>]
 *   [--data-dir <dir>] [--agents-dir <dir>] [--corrections <file>] [--server http://127.0.0.1:5184]
 * Defaults: APPS_CHAT_DATA_DIR else ~/.pi/agent/chat, APPS_CHAT_AGENTS_DIR else ~/.pi/agent/agents,
 * ~/.prime/agent/browser-chat/corrections.json, APPS_CHAT_URL else http://127.0.0.1:5184. Without OUTPUT_FILE the result prints to stdout.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ChatRecords } from "../../server/chat-records.ts";
import { AGENTS } from "../../server/record-kinds.ts";

const DAY_MS = 86_400_000;
/**
 * How long a recall session gets for its first answer. On 11-20 a fresh seo session answered in 49 s. On 11-22 every Opus account was at its
 * limit until 22:44Z and 22:46Z, so pi-pool parked the seo and vent sessions for 754 s and 874 s, and vent answered 898 s after its send.
 */
const ANSWER_WAIT_MS = 20 * 60_000;
const POLL_MS = 5_000;
/**
 * How long a recall's newest turn may read over and empty (`emptyTurn`) before the recall ends with EMPTY_TURN. A fresh thread read that
 * way for 18 to 48 s on 11-20 right after a pi-host restart while it still worked, so this is 2.5 times the longest of those. On 11-22 three
 * right answers that the page drew as private notes cost the whole ANSWER_WAIT_MS each.
 */
const EMPTY_SETTLE_MS = 120_000;
export const EMPTY_TURN = "empty turn";

interface AgentRecord { id: string; slug: string; name: string; workThread: string; home?: string; archived?: boolean; test?: boolean; agentsDir?: string; comm?: Record<string, string>; createdAt?: number }
interface StoreEntry { id: string; kind: string; title: string; content: string; path?: string; created_at?: string }
interface Expected { kind?: string; title: string; match: string[] }
interface Question { q: string; answer?: string; match: string[] }
interface IdealAgent { agent?: string; slug?: string; expected?: Expected[]; questions?: Question[]; chats?: string[]; must_not?: unknown[];
  /** Corrections from this agent's chats that bind every agent and so stay out of its store (the ledger digest carries them). */
  general_corrections?: string[] }
/** A `public_values` row: a fixed dev-only credential committed in plaintext (`where`), which an entry may write out. */
interface PublicValue { value: string; where: string }
interface Ideal { agents?: IdealAgent[]; general_corrections?: string[]; public_values?: PublicValue[] }
interface Correction { id: string; at: string; chat: { id: string; name?: string }; rule: string; ref?: string; status?: string }

export interface Finding { kind: string; excerpt: string; sig: string }

/** The longest form that must match as a whole word: on 11-20 seo's "no" matched inside "now". */
const SHORT_FORM = 3;
const wordChar = (char: string | undefined): boolean => !!char && /[a-z0-9_]/.test(char);

/** A form as a pattern: it starts at a word start, and a short form also ends at a word end. */
function formPattern(form: string): RegExp {
  const text = form.toLowerCase().replace(/\s+/g, " ").trim();
  const head = wordChar(text[0]) ? "(?<![a-z0-9_])" : "";
  const tail = text.length <= SHORT_FORM && wordChar(text.at(-1)) ? "(?![a-z0-9_])" : "";
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(head + escaped + tail);
}

/** All-of match: each word, or one of its `a|b` forms, appears in the text, case-insensitive. */
export function holds(text: string, words: readonly string[]): boolean {
  const hay = text.toLowerCase().replace(/\s+/g, " ");
  return words.every(word => word.split("|").some(form => formPattern(form).test(hay)));
}

/** The entries of a store, every kind; a store that is missing or does not parse is empty. */
export function storeEntries(file: string): StoreEntry[] {
  if (!existsSync(file)) return [];
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, Record<string, Partial<StoreEntry>>> };
    return Object.entries(state.entries ?? {}).flatMap(([kind, entries]) => Object.entries(entries ?? {}).map(([id, entry]) => ({
      id, kind, title: String(entry.title ?? ""), content: String(entry.content ?? ""), ...(entry.path ? { path: String(entry.path) } : {}),
      ...(entry.created_at ? { created_at: String(entry.created_at) } : {}),
    })));
  } catch {
    return [];
  }
}

const entryText = (entry: StoreEntry): string => `${entry.title}\n${entry.content}`;

/**
 * Whether an entry is session state or step status: a title or path that says so, or a body that lists the status of two or more plan
 * steps. search-product-misc's 11-20 entry "Session state: modern-web-guidance install cleanup, p14 fixes, p11 Prospect answer" is one.
 * A title reads as session state when it says "session state", or opens with a word such as Status or WIP used as a label (followed by a
 * colon, dash or bracket, or alone) or followed by a plan step. A lasting entry about the wip 👀 reaction ("WIP and done reactions are
 * prompt-level") is not one.
 */
export function scratchReason(entry: StoreEntry): string | null {
  if (/^session\b/i.test(entry.path ?? "")) return `path ${entry.path}`;
  const label = /^(status|progress|scratch|wip|todo|next steps?|handoff|hand-off)\b\s*(?:[:(\[\-\u2013]|$|.*\b[pt]\d{1,4}\b)/i;
  if (/\bsession state\b/i.test(entry.title) || label.test(entry.title.trim())) return "title reads as session state";
  const steps = entry.content.match(/\b[pt]\d{1,4}\b[^.\n]{0,60}\b(done|open|closed|in progress|blocked|left|pending|waiting|next)\b/gi) ?? [];
  return steps.length >= 2 ? `${steps.length} step-status lines` : null;
}

/**
 * A secret value in an entry: an API key or token shape, or a password, secret or key written out after a colon or equals sign. The digest
 * copies entries into prompts, so a store names where a secret lives and never holds its value (ideal.json rules.must_not). A value
 * ideal.json lists in public_values is committed in plaintext, such as auto-sns-agent's local-agent-key, and is no secret. Neither is
 * the name of an env variable, which says where the value lives: on 11-23 search-product-misc's "x-agent-secret = STAGING_AGENT_SECRET in
 * apps/search/.env.staging" and "X-API-Key = CRAWLER_API_KEY" read as two secrets written out. A Komodo variable reference is such a name
 * in double brackets: on 11-24 devops-guy's "/alerts?secret=[[PROD__OPS_GATEWAY_SECRET]]" read as a secret written out.
 */
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_+[A-Z0-9]+)+$/;
export function secretReason(entry: StoreEntry, publicValues: ReadonlySet<string> = new Set()): string | null {
  const text = entryText(entry);
  const token = text.match(/\b(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+)/);
  if (token) return `token ${token[0].slice(0, 6)}...`;
  const pair = text.match(/\b(password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*["'`]?([^\s"'`]{8,})/i);
  const value = pair?.[2]!.replace(/[.,;:)\]]+$/, "").replace(/^\[\[/, "");
  return pair && !publicValues.has(value!) && !ENV_NAME.test(value!) && !/^(<|\$|\{|process\.env|env\.|see\b|in\b)/i.test(pair[2]!) ? `${pair[1]} written out` : null;
}

/** The must-not items of ideal.json that a script can read: an object with `match` words; a prose item is for the duty job to read. */
function mustNotHits(entries: readonly StoreEntry[], items: readonly unknown[], publicValues: ReadonlySet<string>): { entry: StoreEntry; rule: string }[] {
  const hits: { entry: StoreEntry; rule: string }[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || !Array.isArray((item as { match?: unknown }).match)) continue;
    const words = (item as { match: unknown[] }).match.map(String);
    const rule = String((item as { title?: unknown; why?: unknown }).title ?? (item as { why?: unknown }).why ?? words.join(" + "));
    for (const entry of entries) if (holds(entryText(entry), words)) hits.push({ entry, rule });
  }
  for (const entry of entries) {
    const secret = secretReason(entry, publicValues);
    if (secret) hits.push({ entry, rule: `secret value: ${secret}` });
  }
  return hits;
}

/** The corrections about an agent: from its work or comm threads, a chat named "<agent> · <room>", or an old chat ideal.json names. */
export function correctionsOf(record: AgentRecord, corrections: readonly Correction[], chats: readonly string[]): Correction[] {
  const threads = new Set([record.workThread, ...Object.values(record.comm ?? {}), ...chats]);
  return corrections.filter(c => c.status !== "retired" && (threads.has(c.chat.id) || (c.chat.name ?? "").startsWith(`${record.name} · `)));
}

const captured = (c: Correction, text: string): boolean => new RegExp(`\\b${c.id}\\b`).test(text) || (!!c.ref && text.includes(c.ref));

/** An agent made under a day ago with no ideal.json row yet: the duty job writes the row on the agent's first day, so it is not measured. */
export const idealUnwritten = (record: { createdAt?: number }, want: unknown, now: number): boolean =>
  !want && record.createdAt !== undefined && record.createdAt > now - DAY_MS;

/**
 * A store is on its ideal when its agent has a row, it holds every expected entry and it holds no must-not or scratch entry; a row that
 * expects nothing wants an empty store. ideal.json rules.must_not names session scratch and step status, so a scratch entry is a miss here.
 */
export const onIdealStore = (want: { expected?: readonly unknown[] } | undefined, counts: { entries: number; missing: number; mustNot: number; scratch: number }): boolean =>
  !!want && !counts.mustNot && !counts.scratch && (want.expected?.length ? !counts.missing : !counts.entries);

const pct = (part: number, whole: number): number => (whole ? Math.round((1000 * part) / whole) / 10 : 100);

/**
 * How long a call keeps trying while the chat server does not answer at all. An apps/chat release restarts the server for a second or two,
 * and on 11-22 releases at 05:11 and 05:16 UTC ended a detached d3 rerun with "fetch failed, ECONNREFUSED" before it graded anyone.
 */
export const RESTART_WAIT_MS = 120_000;

/** Calls the chat server; a refused or dropped connection is retried every 2 s up to `restartWaitMs`, an HTTP error is not. */
export async function call(server: string, method: string, path: string, body?: unknown, restartWaitMs = RESTART_WAIT_MS): Promise<any> {
  const started = Date.now();
  let response: Response;
  for (;;) {
    try {
      response = await fetch(`${server}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      break;
    } catch (error) {
      if (Date.now() - started >= restartWaitMs) throw error;
      await sleep(Math.min(2000, restartWaitMs));
    }
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** The numbered answers of a reply, by question number; a reply with no numbers gives its whole text to every question. */
export function splitAnswers(text: string, count: number): string[] {
  const parts = text.split(/^\s*(?:\*\*)?(\d)[.)]/m);
  const out: string[] = Array(count).fill("");
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const n = Number(parts[i]) - 1;
    if (n >= 0 && n < count) out[n] += parts[i + 1]!;
  }
  return out.every(answer => !answer.trim()) ? Array(count).fill(text) : out;
}

interface TurnItem { kind: string; live?: boolean; text?: string; sent?: string[]; stop?: string; error?: string; usage?: { cost?: number } }
/** The thread's run status as GET /api/c/<thread> reads it: "sleeping" while pi-pool parks its model call for an account slot. */
type RunStatus = "working" | "idle" | "sleeping" | "failed";

/**
 * The reply of a recall session's newest turn once it is over, or null while it runs. A turn is over when it is not live and holds an
 * answer, a stop or an error. `live` alone is not enough: without a watcher it comes from the server's cached thread status, and a fresh test
 * thread can read idle while its run works. On 11-20 at 05:43Z, right after a pi-host restart, 4 of 7 sessions read as an empty, not-live
 * turn at cost 0 within 18 to 48 s and their real answers landed in the same turn moments later.
 * A thread that is working or sleeping is not over either. A pi-pool slot wait parks the run as sleeping, which reads as not live, and ends
 * with a model call that fails with "the account slot is open" and is sent again a few seconds later. On 11-22 the vent session was graded
 * on that error at 877 s and its answer landed at 898 s.
 */
export function finishedReply(items: readonly TurnItem[], status?: RunStatus): { reply: string; cost?: number; error?: string } | null {
  if (status === "working" || status === "sleeping") return null;
  const turn = items.findLast(item => item.kind === "turn");
  if (!turn || turn.live !== false) return null;
  const reply = [turn.text ?? "", ...(turn.sent ?? []).filter(post => post !== turn.text)].join("\n");
  if (!reply.trim() && !turn.stop && !turn.error) return null;
  const failed = reply.trim() ? undefined : turn.error ?? `turn ${turn.stop}`;
  return { reply, ...(turn.usage?.cost !== undefined ? { cost: turn.usage.cost } : {}), ...(failed ? { error: failed } : {}) };
}

/** Whether the thread is idle and its newest turn is over with no text, no post, no stop and no error, which `finishedReply` waits past. */
export function emptyTurn(items: readonly TurnItem[], status?: RunStatus): boolean {
  if (status === "working" || status === "sleeping") return false;
  const turn = items.findLast(item => item.kind === "turn");
  return !!turn && turn.live === false && !turn.text?.trim() && !turn.sent?.some(post => post.trim()) && !turn.stop && !turn.error;
}

/** How the error of a recall whose wait ran out starts. */
const NO_ANSWER = "no answer within";

/** One agent's recall as a run's detail file stores it under `agents[].recall`. */
export interface RecallRow { error?: string; unanswered?: boolean; graded?: { right: boolean }[] }
/**
 * Whether a recall session got no model answer before its wait ran out, which is no wrong answer: on 11-23 at 07:31 KST all 12 sessions
 * ended "no answer within 1200 s" while 3 of 42 accounts took new work and up to 82 sessions waited, and the run stored recall 0 of 31.
 * A detail file from before the `unanswered` field says it only in the error.
 */
export const unanswered = (row: RecallRow): boolean => row.unanswered ?? !!row.error?.startsWith(NO_ANSWER);
/** The questions asked and answered right over the sessions that answered, and the number of sessions that did not. */
export function recallCount(rows: readonly RecallRow[]): { asked: number; right: number; unmeasured: number } {
  const answered = rows.filter(row => !unanswered(row));
  const graded = answered.flatMap(row => row.graded ?? []);
  return { asked: graded.length, right: graded.filter(g => g.right).length, unmeasured: rows.length - answered.length };
}
/**
 * The share of the newest earlier run whose detail file measured something, or null when no run did. `runs` is LAST_RUNS_FILE, where each
 * run names its detail file, and `count` reads a detail file as a part of a whole, with a whole of 0 when that run measured nothing. A
 * blind check that got no model answer keeps this share: the recall check here and the reply check of owner-style.ts.
 */
export function lastMeasured(runs: readonly { at: number; detail?: string }[], read: (file: string) => unknown, count: (detail: unknown) => { part: number; whole: number }): { pct: number; at: number } | null {
  for (const run of runs.filter(run => run.detail).sort((a, b) => b.at - a.at)) {
    let detail: unknown;
    try { detail = read(run.detail!); } catch { continue; }
    const { part, whole } = count(detail);
    if (whole) return { pct: pct(part, whole), at: run.at };
  }
  return null;
}
/** The recall share of the newest earlier run whose detail file holds an answered session, counted the same way, or null when no run measured one. */
export function lastMeasuredRecall(runs: readonly { at: number; detail?: string }[], read: (file: string) => unknown): { pct: number; at: number } | null {
  return lastMeasured(runs, read, detail => {
    const rows = ((detail as { agents?: { recall?: RecallRow }[] } | null)?.agents ?? []).flatMap(agent => agent.recall ? [agent.recall] : []);
    const count = recallCount(rows);
    return { part: count.right, whole: count.asked };
  });
}

/** The name every recall agent starts with; its stamp ends it. */
const RECALL_NAME = "memory recall ";
/**
 * The age past which a recall agent belongs to a run that died: a recall waits at most ANSWER_WAIT_MS after it makes its agent, plus one
 * poll and its calls, so one older than twice that is no live run's. A younger agent of another stamp is a run still going.
 */
const STALE_MS = 2 * ANSWER_WAIT_MS;

interface Made { id: string; thread: string }
const folderOf = (agentsDir: string, id: string): string => join(agentsDir, id.replace(/^ag_/, ""));

/** Deletes a recall agent's folder and archives its work thread; answers whether the server took the archive. */
async function discard(server: string, agentsDir: string, made: Made): Promise<boolean> {
  rmSync(folderOf(agentsDir, made.id), { recursive: true, force: true });
  return call(server, "PATCH", `/api/c/${made.thread}`, { archived: true }).then(() => true, () => false);
}

/**
 * Archives and deletes the recall agents a run leaves: those of `stamp`, and those older than STALE_MS that a killed run left (the duty's
 * hard stop sends SIGKILL, which skips every finally; on 11-20 seven recall agents stayed unarchived). It also deletes each recall folder
 * whose agent is archived or gone. Answers what it cleaned and the agents the server would not archive.
 */
export async function sweepRecallAgents(server: string, agentsDir: string, opts: { stamp?: string; now: number }): Promise<{ swept: string[]; left: string[] }> {
  const folders = existsSync(agentsDir) ? readdirSync(agentsDir).filter(name => name.startsWith("memory-recall-")).map(name => join(agentsDir, name)) : [];
  const agents = await call(server, "GET", "/api/agents?test=1") as { id: string; name: string; thread: string; archived?: boolean; createdAt?: number }[];
  const recall = agents.filter(agent => agent.name.startsWith(RECALL_NAME) && !agent.archived);
  const dead = recall.filter(agent => (opts.stamp && agent.name.endsWith(` ${opts.stamp}`)) || (agent.createdAt ?? 0) < opts.now - STALE_MS);
  const swept: string[] = [];
  const left: string[] = [];
  for (const agent of dead) (await discard(server, agentsDir, agent) ? swept : left).push(agent.id);
  const live = new Set(recall.filter(agent => !dead.includes(agent)).map(agent => folderOf(agentsDir, agent.id)));
  for (const folder of folders.filter(folder => !live.has(folder))) {
    rmSync(folder, { recursive: true, force: true });
    if (!swept.includes(`ag_${basename(folder)}`)) swept.push(`ag_${basename(folder)}`);
  }
  return { swept, left };
}

/**
 * One blind recall session: a throwaway test agent with a copy of the agent's brief and store gets the questions as the owner would ask
 * them, and the reply is read once its turn ends. The agent is archived and its folder removed after, on an answer, an error or the wait
 * running out.
 */
export async function recall(server: string, agentsDir: string, record: AgentRecord, questions: readonly Question[], stamp: string,
  timing: { waitMs: number; pollMs: number; settleMs?: number } = { waitMs: ANSWER_WAIT_MS, pollMs: POLL_MS }): Promise<{ reply: string; seconds: number; cost?: number; thread?: string; error?: string; unanswered?: true }> {
  const started = Date.now();
  let made: Made | undefined;
  const cwd = record.home && existsSync(record.home) ? realpathSync(record.home) : undefined;
  try {
    made = await call(server, "POST", "/api/agents", { name: `${RECALL_NAME}${record.slug} ${stamp}`, test: true, ...(cwd ? { cwd } : {}) }) as Made;
    const dir = folderOf(agentsDir, made.id);
    mkdirSync(join(dir, "harness"), { recursive: true });
    const source = join(agentsDir, record.slug);
    if (existsSync(join(source, "brief.md"))) cpSync(join(source, "brief.md"), join(dir, "brief.md"));
    if (existsSync(join(source, "harness", "harness_state.json"))) cpSync(join(source, "harness", "harness_state.json"), join(dir, "harness", "harness_state.json"));
    const text = ["Quick questions, answer each from what you remember, without searching the repo, wiki or web. Number your answers 1 to " +
      `${questions.length}, one or two sentences each, and say "don't know" when you don't.`, ...questions.map((q, i) => `${i + 1}. ${q.q}`)].join("\n");
    await call(server, "POST", `/api/c/${made.thread}/send`, { text, requestId: `memory-recall-${record.slug}-${stamp}` });
    const settleMs = timing.settleMs ?? EMPTY_SETTLE_MS;
    let emptySince: number | undefined;
    for (;;) {
      await sleep(timing.pollMs);
      // A failed poll is read again on the next one: on 11-22 a pi-host restart at 05:28 UTC answered 500 "pi-host is shutting down"
      // for ten seconds and ended 5 of 10 recalls with no answer, though durable runs resume after a restart.
      const polled = await Promise.all([
        call(server, "GET", `/api/c/${made.thread}/items`) as Promise<{ items: TurnItem[] }>,
        call(server, "GET", `/api/c/${made.thread}`) as Promise<{ summary: { status: RunStatus } }>,
      ]).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
      const done = polled instanceof Error ? null : finishedReply(polled[0].items, polled[1].summary.status);
      if (done) return { ...done, seconds: Math.round((Date.now() - started) / 1000), thread: made.thread };
      if (!(polled instanceof Error)) emptySince = emptyTurn(polled[0].items, polled[1].summary.status) ? emptySince ?? Date.now() : undefined;
      if (emptySince !== undefined && Date.now() - emptySince >= settleMs) {
        const error = `${EMPTY_TURN}: the turn ended with no text, post, stop or error and stayed so for ${Math.round(settleMs / 1000)} s`;
        return { reply: "", seconds: Math.round((Date.now() - started) / 1000), thread: made.thread, error };
      }
      if (Date.now() - started > timing.waitMs) {
        const last = polled instanceof Error ? `, last poll ${polled.message.slice(0, 160)}` : "";
        return { reply: "", seconds: Math.round((Date.now() - started) / 1000), thread: made.thread, error: `${NO_ANSWER} ${Math.round(timing.waitMs / 1000)} s${last}`, unanswered: true };
      }
    }
  } catch (error) {
    return { reply: "", seconds: Math.round((Date.now() - started) / 1000), error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (made) await discard(server, agentsDir, made);
  }
}

/** `sw skills check` as the server answers it: each place the skill folders on the boxes differ from the skills DB in chat.sqlite. */
async function skillsDrift(server: string): Promise<{ items: { kind: string; where: string; fix: string }[] } | { error: string }> {
  try {
    const response = await fetch(`${server}/api/skills/check`);
    if (!response.ok) return { error: `GET /api/skills/check answered ${response.status}` };
    const check = await response.json() as { items: { kind: string; copyId?: string; skillId?: string; box?: string; path?: string; fix: string[] }[] };
    return { items: check.items.map(item => ({ kind: item.kind, where: item.copyId ?? (item.kind === "gone" ? item.skillId! : `${item.box}:${item.path}`), fix: item.fix.join(" or ") })) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    "data-dir": { type: "string" }, "agents-dir": { type: "string" }, ideal: { type: "string" }, corrections: { type: "string" },
    server: { type: "string" }, "no-recall": { type: "boolean" }, only: { type: "string" },
  } });
  const dataDir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const agentsDir = resolve(values["agents-dir"] ?? process.env.APPS_CHAT_AGENTS_DIR ?? join(homedir(), ".pi/agent/agents"));
  const idealFile = resolve(values.ideal ?? join(homedir(), "work/agent-memory/ideal.json"));
  const correctionsFile = resolve(values.corrections ?? join(homedir(), ".prime/agent/browser-chat/corrections.json"));
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const only = values.only ? new Set(values.only.split(",")) : null;
  const now = Date.now();
  const stamp = `${new Date(now).toISOString().slice(5, 16).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;

  const records = (ChatRecords.standalone(dataDir).doc(AGENTS).value.agents as AgentRecord[])
    .filter(record => !record.archived && !record.test && (!only || only.has(record.slug)));
  const idealDoc = existsSync(idealFile) ? JSON.parse(readFileSync(idealFile, "utf8")) as Ideal : null;
  const ideal = idealDoc ? idealDoc.agents ?? [] : null;
  const idealOf = (record: AgentRecord): IdealAgent | undefined => ideal?.find(entry => entry.agent === record.id || entry.slug === record.slug);
  const publicValues = new Set((idealDoc?.public_values ?? []).map(row => row.value));
  const corrections = existsSync(correctionsFile) ? (JSON.parse(readFileSync(correctionsFile, "utf8")) as { corrections: Correction[] }).corrections : [];

  const flagged: Finding[] = [];
  const rows: Record<string, unknown>[] = [];
  let onIdeal = 0;
  let unwritten = 0;
  let correctionsDue = 0;
  let correctionsKept = 0;
  let scratch = 0;
  const recalls: Promise<void>[] = [];
  const recallOn = !values["no-recall"];
  const sweeps: { swept: string[]; left: string[] }[] = [];
  if (recallOn) {
    sweeps.push(await sweepRecallAgents(server, agentsDir, { now }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void sweepRecallAgents(server, agentsDir, { stamp, now: Date.now() }).finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
    }
  }
  const recallRows: RecallRow[] = [];

  for (const record of records) {
    const row: Record<string, unknown> = { agent: record.id };
    rows.push(row);
    if (record.agentsDir) {
      row.skipped = `folder on another box (${record.agentsDir})`;
      continue;
    }
    const entries = storeEntries(join(agentsDir, record.slug, "harness", "harness_state.json"));
    const want = idealOf(record);
    row.entries = entries.length;

    const missing = (want?.expected ?? []).filter(exp => !entries.some(entry => (!exp.kind || exp.kind === entry.kind) && holds(entryText(entry), exp.match)));
    const forbidden = mustNotHits(entries, want?.must_not ?? [], publicValues);
    const expected = want?.expected ?? [];
    const scratchHits = entries.flatMap(entry => {
      const reason = scratchReason(entry);
      return reason ? [{ entry, reason }] : [];
    });
    const matches = onIdealStore(want, { entries: entries.length, missing: missing.length, mustNot: forbidden.length, scratch: scratchHits.length });
    const fresh = idealUnwritten(record, want, now) && !forbidden.length;
    if (matches) onIdeal++;
    if (fresh) {
      unwritten++;
      flagged.push({ kind: "ideal_unwritten", excerpt: `${record.slug} was made ${Math.round((now - record.createdAt!) / 3_600_000)} h ago and ideal.json has no entry for it yet, so it is not measured; write its row from its brief and store`, sig: `idealnew:${record.slug}` });
    }
    row.ideal = fresh ? "no ideal yet for this agent, made under a day ago" : want ? { expected: want.expected?.length ?? 0, missing: missing.map(exp => exp.title), mustNot: [...forbidden.map(hit => `${hit.entry.title} (${hit.rule})`), ...scratchHits.map(hit => `${hit.entry.title} (scratch: ${hit.reason})`)] } : "no ideal for this agent";
    if (!matches && !fresh) {
      const held = [
        forbidden.length ? `holds ${forbidden.length} must-not entr${forbidden.length === 1 ? "y" : "ies"}: ${forbidden[0]!.entry.title}` : "",
        scratchHits.length ? `holds ${scratchHits.length} scratch entr${scratchHits.length === 1 ? "y" : "ies"}: ${scratchHits[0]!.entry.title}` : "",
      ].filter(Boolean).join(" and ");
      const why = !want ? ["ideal.json has no entry for it", held].filter(Boolean).join(" and it ") : !expected.length && entries.length ? `its ideal store is empty and it holds ${entries.length} entries`
        : [missing.length ? `misses ${missing.length} of ${want.expected!.length}: ${missing.slice(0, 3).map(exp => exp.title).join("; ")}` : "", held].filter(Boolean).join(", ");
      flagged.push({ kind: "off_ideal", excerpt: `${record.slug} ${why}`, sig: `ideal:${record.slug}:${missing.map(exp => exp.title).join("|")}:${forbidden.length}:${scratchHits.length}` });
    }

    const about = correctionsOf(record, corrections, want?.chats ?? []);
    const text = entries.map(entryText).join("\n");
    const general = new Set([...idealDoc?.general_corrections ?? [], ...want?.general_corrections ?? []]);
    const due = about.filter(c => Date.parse(c.at) <= now - DAY_MS && !general.has(c.id));
    const kept = due.filter(c => captured(c, text));
    correctionsDue += due.length;
    correctionsKept += kept.length;
    row.corrections = { about: about.map(c => c.id), general: about.filter(c => general.has(c.id)).map(c => c.id), due: due.length, captured: kept.map(c => c.id) };
    for (const c of due.filter(c => !kept.includes(c))) flagged.push({ kind: "correction_not_kept", excerpt: `${record.slug} ${c.id} (${c.at.slice(0, 10)}): ${c.rule.slice(0, 160)}`, sig: `corr:${record.slug}:${c.id}` });

    for (const { entry, reason } of scratchHits) {
      scratch++;
      flagged.push({ kind: "scratch_entry", excerpt: `${record.slug} ${entry.kind} "${entry.title.slice(0, 120)}" (${reason})`, sig: `scratch:${record.slug}:${entry.id}` });
    }

    const questions = want?.questions ?? [];
    if (recallOn && questions.length) {
      recalls.push(recall(server, agentsDir, record, questions, stamp).then(result => {
        const answers = splitAnswers(result.reply, questions.length);
        const graded = questions.map((q, i) => ({ q: q.q, right: !result.error && holds(answers[i]!, q.match), answer: answers[i]!.trim().slice(0, 600) }));
        row.recall = { ...result, reply: undefined, graded };
        recallRows.push({ ...result, graded });
        if (result.unanswered) {
          flagged.push({ kind: "recall_unmeasured", excerpt: `${record.slug} recall session got no model answer (${result.error}); its ${questions.length} questions are not measured`, sig: `recallnone:${record.slug}` });
          return;
        }
        if (result.error) flagged.push({ kind: "recall_failed", excerpt: `${record.slug} recall session: ${result.error}`, sig: `recallerr:${record.slug}` });
        for (const [i, g] of graded.entries()) {
          if (g.right) continue;
          flagged.push({ kind: "recall_wrong", excerpt: `${record.slug} Q${i + 1} "${g.q.slice(0, 100)}" wants ${questions[i]!.match.join(" + ")}, got: ${g.answer.slice(0, 160) || "(nothing)"}`, sig: `recall:${record.slug}:${i}` });
        }
      }));
    }
  }
  await Promise.all(recalls);
  if (recallOn) sweeps.push(await sweepRecallAgents(server, agentsDir, { stamp, now: Date.now() }));
  const left = sweeps.at(-1)?.left ?? [];
  for (const id of left) flagged.push({ kind: "recall_agent_left", excerpt: `${id} is a recall agent the server would not archive`, sig: `left:${id}` });

  const skills = await skillsDrift(server);
  if ("error" in skills) flagged.push({ kind: "source_error", excerpt: `sw skills check failed: ${skills.error}`, sig: "skills-check" });
  else for (const item of skills.items) flagged.push({ kind: "skills_drift", excerpt: `${item.kind} ${item.where}, fix with sw skills ${item.fix}`, sig: `skills:${item.kind}:${item.where}` });

  const measured = records.filter(record => !record.agentsDir).length - unwritten;
  const metrics: Record<string, number> = {
    ...("error" in skills ? {} : { skills_drift: skills.items.length }),
    corrections_captured_pct: pct(correctionsKept, correctionsDue),
    scratch_entries: scratch,
    agents_real: measured,
    agents_on_ideal: onIdeal,
    agents_ideal_unwritten: unwritten,
    corrections_due: correctionsDue,
    corrections_kept: correctionsKept,
  };
  if (ideal) metrics.agents_on_ideal_pct = pct(onIdeal, measured);
  if (recallOn) {
    metrics.recall_agents_left = left.length;
    metrics.recall_agents_swept = sweeps.reduce((sum, sweep) => sum + sweep.swept.length, 0);
  }
  const count = recallCount(recallRows);
  const lastRuns = !count.asked && count.unmeasured && process.env.LAST_RUNS_FILE && existsSync(process.env.LAST_RUNS_FILE)
    ? JSON.parse(readFileSync(process.env.LAST_RUNS_FILE, "utf8") || "[]") as { at: number; detail?: string }[] : [];
  const carried = lastMeasuredRecall(lastRuns, file => JSON.parse(readFileSync(file, "utf8")));
  if (count.asked) {
    metrics.recall_right_pct = pct(count.right, count.asked);
    metrics.recall_asked = count.asked;
    metrics.recall_right = count.right;
  } else if (carried) {
    metrics.recall_right_pct = carried.pct;
    metrics.recall_carried_at = carried.at;
  }
  if (recallOn) metrics.recall_agents_unmeasured = count.unmeasured;
  const sessions = (n: number): string => `${n} recall session${n === 1 ? "" : "s"}`;
  const recallWords = count.asked ? `${count.right} of ${count.asked} recall answers right${count.unmeasured ? `, and ${sessions(count.unmeasured)} got no model answer in time and ${count.unmeasured === 1 ? "is" : "are"} not measured` : ""}`
    : !count.unmeasured ? "no recall run"
    : `recall not measured, since none of the ${sessions(count.unmeasured)} got a model answer in time` +
      (carried ? `, so recall_right_pct keeps the ${carried.pct}% measured at ${new Date(carried.at).toISOString().slice(0, 16)}Z` : ", and no earlier run measured it");
  const skillsWords = "error" in skills ? "sw skills check failed" : `${skills.items.length} skills drift item${skills.items.length === 1 ? "" : "s"}`;
  const output = {
    metrics,
    flagged: [...(ideal ? [] : [{ kind: "source_error", excerpt: `no ideal file at ${idealFile}`, sig: "no-ideal" }]), { kind: "summary", excerpt: `${onIdeal} of ${measured} agents hold their ideal memory${unwritten ? ` (${unwritten} made under a day ago ${unwritten === 1 ? "has" : "have"} no ideal yet and ${unwritten === 1 ? "is" : "are"} not measured)` : ""}; ${correctionsKept} of ${correctionsDue} corrections a day old are kept; ` +
      `${scratch} scratch entries; ${recallWords}; ${skillsWords}`, sig: "summary" }, ...flagged],
    idealFile, agents: rows,
  };
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
