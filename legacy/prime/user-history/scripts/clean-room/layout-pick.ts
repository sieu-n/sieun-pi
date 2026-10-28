import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { family, ownJob } from "./answer-data.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";
import { layoutTodoFlag } from "../../src/shared/chat-board.ts";
import { designPageForScreens, layoutPickInWords, screenOptionsOnPage } from "../../src/shared/layout-ask.ts";
import type { ChatBoard } from "../../src/shared/types.ts";

/**
 * The clean-room scenario for c124 after its repeat of 10-28 (owner, 15:08:59Z: "siwpe layout, 직접 만들어보라니까 이런건?"). frontend bro had
 * answered "swip는 좀 재편이 필요해. what is the purpose first of all and what exactly does it do?" with a job that wrote three Swipe layouts on
 * a wiki page, then asked him to pick one by its text in tell_owner and t51. A fresh chat gets the same kind of ask about another 5180 app. It
 * passes once a brief of the chat or its jobs has the new layout built as a 5180 variant, before any layout ask in words reaches him; it fails
 * on a tell_owner that went out or a todo that asks him to pick a layout from words with no 5180 link, or on a brief that asks a job for a
 * page of layout options and builds none. The run ends at its first verdict, so teardown stops the builders before they write much.
 * The criteria live in ~/.prime/agent/clean-room/c124-layout-pick/criteria.md.
 */
export const TASK = "watchlist on 5180 needs a rethink. what is it even for, and it should feel more like a feed where i can skim the actual posts fast";
/** A spawn of a job or subagent. */
const SPAWN = /rlm\.(?:spawn|create_session)\s*\(/;
/** A brief that builds the layout on 5180: a variant fork, or a variant named with 5180 or the version picker. */
export const BUILDS = /variant:fork|\bfork(?:s|ed|ing)?\b[^.\n]{0,80}\bvariants?\b|\bvariants?\b[^.\n]{0,160}(?:\b5180\b|version picker)|(?:\b5180\b|version picker)[^.\n]{0,160}\bvariants?\b/i;
/** A message to another chat, such as the one that owns the 5180 sandbox. */
const ASKS_BUILD = /agent_message\.send\s*\(/;
/** A brief that asks for layout options written on a page. */
const OPTIONS = /\b(?:layout|redesign|design|wireframe|mock-?up)s?\s+(?:options?|choices|alternatives)\b|\b(?:two|three|2|3)\s+(?:or\s+(?:three|four|3|4)\s+)?(?:layouts|redesigns|designs|options)\b/i;
const PAGE = /\bwiki\s+page\b|\bwrite\s+(?:a|one|ONE|the)\s+(?:short\s+)?(?:wiki\s+)?page\b|\bdecision\s+page\b|\bdesign\s+(?:page|doc)\b/i;
/**
 * A shell run of the demo's fork script, through bash or a bash() call in the REPL. Run1 on 10-28 passed on a search_history call whose query
 * held "variant:fork", 30 s in, before the chat had briefed anyone.
 */
const FORK_RUN = /\b(?:pnpm|npm|node)\b[^\n'"]{0,120}variant:fork\b/;
export const forkRun = (tool: string, input: string): boolean => (tool === "bash" || tool === "ipython") && FORK_RUN.test(input);
export const pageOfOptions = (brief: string): boolean => (OPTIONS.test(brief) && PAGE.test(brief) || screenOptionsOnPage(brief) !== null) && !BUILDS.test(brief);

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

/** The tell_owner texts of a session file that went out: a call whose tool result reads "told the owner". */
export function sentTells(file: string): { at: number; text: string }[] {
  if (!file || !existsSync(file)) return [];
  const calls = new Map<string, { at: number; text: string }>();
  const out: { at: number; text: string }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("tell_owner")) continue;
    let entry: { type?: string; timestamp?: string; message?: { role?: string; toolCallId?: string; toolName?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    const at = Date.parse(entry.timestamp ?? "") || 0;
    if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: { text?: unknown } }[]) {
      if (part.type === "toolCall" && part.name === "tell_owner" && part.id && typeof part.arguments?.text === "string") calls.set(part.id, { at, text: part.arguments.text });
    }
    if (message.role === "toolResult" && message.toolName === "tell_owner" && message.toolCallId && calls.has(message.toolCallId)) {
      const text = Array.isArray(message.content) ? (message.content as { text?: string }[]).map(part => part.text ?? "").join("") : String(message.content ?? "");
      if (text.trim() === "told the owner") out.push(calls.get(message.toolCallId)!);
    }
  }
  return out;
}

/** Every agent todo on any board revision collect kept. */
function boardTodos(run: string): { id: string; text: string; choices?: string[]; links?: { label: string; target: string }[]; at?: string }[] {
  const dir = join(run, "boards");
  const seen = new Map<string, { id: string; text: string; choices?: string[]; links?: { label: string; target: string }[]; at?: string }>();
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    let board: ChatBoard;
    try { board = JSON.parse(readFileSync(join(dir, name), "utf8")) as ChatBoard; } catch { continue; }
    for (const todo of board.todos) if (todo.from !== "owner") seen.set(`${todo.id}\n${todo.text}\n${(todo.choices ?? []).join("|")}\n${(todo.links ?? []).map(link => link.target).join("|")}`,
      { id: todo.id, text: todo.text, ...(todo.choices ? { choices: [...todo.choices] } : {}), ...(todo.links ? { links: [...todo.links] } : {}), at: todo.at });
  }
  return [...seen.values()];
}

/** What a scenario judged by `judge` asks and which briefs count as a page in place of the screens. */
export interface PickTask { task: string; pageBrief: (brief: string) => boolean }

export function judge(run: string, state: RunState, now = Date.now(), { task, pageBrief }: PickTask = { task: TASK, pageBrief: pageOfOptions }): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const members = family(run, chat);
  const sessions = members.map(({ id, file }) => ({ id, file, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const calls = all.filter((entry): entry is { session: string; event: Extract<SessionEvent, { kind: "call" }> } => entry.event.kind === "call");
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const head = sessions.find(session => session.id === chat);
  const told = (head?.file ? sentTells(head.file) : []).filter(said => said.at >= state.windowStart);
  const wordy = told.filter(said => layoutPickInWords(said.text) !== null || designPageForScreens(said.text) !== null);
  const todos = boardTodos(run);
  const wordyTodos = todos.filter(todo => layoutTodoFlag({ text: todo.text, ...(todo.choices ? { choices: todo.choices } : {}), ...(todo.links ? { links: todo.links } : {}) }) !== null);
  add("a", wordy.length || wordyTodos.length ? false : true, wordy.length || wordyTodos.length
    ? [...wordy.map(said => `${iso(said.at)} told him "${clip(said.text, 300)}"`), ...wordyTodos.map(todo => `todo ${todo.id} "${clip([todo.text, ...todo.choices ?? []].join(" / "), 300)}"`)].join("; ")
    : `${told.length} tell_owner messages went out and ${todos.length} agent todos were added, none asking him to pick a layout from words or handing him a design page without a 5180 link`);

  const briefs = calls.filter(({ event }) => SPAWN.test(event.input)).map(({ session, event }) => ({ session, at: event.at, text: event.input }));
  const forks = calls.filter(({ event }) => forkRun(event.tool, event.input));
  // An ask to the chat that owns 5180 counts as a build too: in run1 of design-page on 10-28 the chat asked frontend bro for "two layouts as
  // switchable fork variants, one builder each", and the clean room's wall refused the send.
  const asks = calls.filter(({ event }) => ASKS_BUILD.test(event.input) && BUILDS.test(event.input)).map(({ session, event }) => ({ session, at: event.at, text: event.input }));
  const builds = [...briefs.filter(brief => BUILDS.test(brief.text)), ...asks].sort((a, b) => a.at - b.at);
  const pages = briefs.filter(brief => pageBrief(brief.text));
  const built = builds[0] ?? (forks[0] ? { session: forks[0].session, at: forks[0].event.at, text: forks[0].event.input } : undefined);
  const paged = pages[0];
  add("b", built && (!paged || built.at <= paged.at) ? true : paged ? false : ended ? false : null, built && (!paged || built.at <= paged.at)
    ? `${built.session.slice(0, 8)} at ${iso(built.at)} builds it on 5180: "${clip(built.text, 400)}"`
    : paged ? `${paged.session.slice(0, 8)} at ${iso(paged.at)} asks for layout options on a page and builds none: "${clip(paged.text, 400)}"`
      : `${briefs.length} briefs so far, none that builds the layout on 5180 or asks for a page of layout options`);

  const typed = (head?.events ?? []).filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== task);
  const asked = new Map<string, number>();
  for (const event of head?.events ?? []) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = (head?.events ?? []).filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !ownJob(state.chat.name, event) && !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("c", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  const turns = all.filter(({ event }) => event.kind === "assistant" || event.kind === "call");
  add("d", turns.length ? true : ended ? false : null, turns.length
    ? `${turns.length} model turns and calls in ${new Set(turns.map(turn => turn.session)).size} sessions; first at ${iso(turns[0]!.event.at)}`
    : "no session of the chat took a model turn in the window");

  const of = (id: string) => checks.find(check => check.id === id)!.ok;
  const verdict: Verdict = of("c") === false || of("d") === false ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of the chat and its ${sessions.length - 1} jobs and subagents, and ${existsSync(join(run, "boards")) ? readdirSync(join(run, "boards")).length : 0} board revisions.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Every tell_owner that went out", "", ...told.map(said => `- ${iso(said.at)}: "${clip(said.text, 600)}"`), "",
    "## Every brief", "", ...briefs.map(brief => `- ${brief.session.slice(0, 8)} at ${iso(brief.at)}: "${clip(brief.text, 600)}"`), "",
  ].join("\n");
  return { verdict, text };
}

export const layoutPick: Scenario = {
  name: "layout-pick",
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
