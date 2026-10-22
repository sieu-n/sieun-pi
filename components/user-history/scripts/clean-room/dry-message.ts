import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ownJob } from "./answer-data.ts";
import { shape } from "./dm-replies.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c18 (owner 10-22, repeated: "dry simple message."), after sieun-pi 03705d8b reworded the c104 line of the chat
 * brief to one point per owner message, best as one dry, plain sentence and at most 2, with the detail on the board or a wiki page. Chats had
 * answered him with long, chatty messages that packed several points and their detail. A fresh chat gets one owner-style status question about
 * the crawler on the box, which tempts a long answer. Nothing is seeded, and the judge reads every tell_owner call of the chat on its own:
 * one point in at most 2 sentences of at most 25 words, no bullets, bold, headings or labels, and the detail written to the board or a wiki
 * page. The criteria live in the run folder's criteria.md. Run3 (10-22) passed with a message that asked for three owner decisions (t92, t61
 * and t62) and with step ids the judge never read, so each todo id and each question now counts as its own point, and a cited step counts as
 * the place of the detail only when the board the chat read holds that step with words on the citing sentence's topic and more besides.
 */
export const TASK = "what's going on with the crawler today, anything i need to do?";
export const MAX_SENTENCES = 2;
export const MAX_WORDS = 25;
const BULLET = /^\s*(?:[-*+\u2022]|\d{1,2}[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/m;
const WIKI_LINK = /(?:wiki:|:5176\/page\/|apps\/llm-wiki\/content\/)[^\s`"'<>()[\]]+?\.(?:html?|md)/;
/** A plan step id written bare, which the chat shows as a chip: the board step that holds the rest of a status answer (brief line c18). */
const STEP_ID = /\bp\d{1,4}\b/g;
/** An owner todo id written bare: each one is a decision he must make, so each is its own point. */
const TODO_ID = /\bt\d{1,4}\b/g;
/** A chat session id in a call, such as `board.open(chat="01a115e2-...")`: the boards the chat read, where the steps it cites live. */
const CHAT_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** A cited step must share this many topic words with the sentence that cites it, and hold this many words the message does not. */
export const TOPIC_WORDS = 2;
export const NEW_WORDS = 5;
const BOARDS = join(process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat"), "boards");
const STOP = new Set(("the and for that this with from are was were has have had not but its his her him our you your they them then than " +
  "into onto out over under about after before when while until can can't cannot will would could should may might all any each one two " +
  "also only still just more most some such very what which who whom why how there here now today his she via per off yet").split(" "));
/** A write to the chat's board: the chat_board tool with ops, or the board-apply script and agent-board route its jobs use. */
const BOARD_SCRIPT = /board-apply\.ts|\/agent-board\b/;
/** A write of a wiki page: the wiki's agent page route, or a file write under the wiki content folder. */
const WIKI_WRITE = /api\/agent\/page|apps\/llm-wiki\/content\/(?!sessions\/)[^\s"'\\]+\.(?:html?|md)[\s\S]{0,400}(?:write_text|writeFile|open\([^)]*['"][wa]|>\s*\S)|(?:write_text|writeFile|open\([^)]*['"][wa])[\s\S]{0,400}apps\/llm-wiki\/content\/(?!sessions\/)/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };
const readable = (text: string): string => text.replace(/```[\s\S]*?```/g, "\n\n").replace(/`[^`\n]*`/g, "x").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "url");

/** The sentences of a message: a line, a list item or a clause after a semicolon is its own sentence, and "vs." or "e.g." ends none. */
export function sentences(text: string): string[] {
  return readable(text).split("\n").map(line => line.replace(BULLET, "").trim()).filter(line => /[\p{L}\p{N}]/u.test(line))
    .flatMap(line => line.replace(/\b(vs|e\.g|i\.e|approx|etc)\.(?=\s)/gi, "$1").split(/(?<=[.!?])["')\]]*\s+(?=\S)|;\s+/))
    .map(part => part.trim()).filter(part => /[\p{L}\p{N}]/u.test(part));
}
export const words = (line: string): number => line.split(/\s+/).filter(Boolean).length;

/** What breaks c18 in one message: more than one point, too many or too long sentences, or a bullet, bold, heading or label. */
export function faults(text: string): { size: string[]; format: string[] } {
  const parts = sentences(text);
  const form = shape(text);
  const asks = parts.filter(part => part.endsWith("?")).length;
  const todos = [...new Set(readable(text).match(TODO_ID) ?? [])];
  const decisions = Math.max(todos.length, asks);
  const size = [
    ...(decisions > 1 ? [`${decisions} owner decisions or questions${todos.length > 1 ? ` (${todos.join(", ")})` : ""}`] : []),
    ...(parts.length > MAX_SENTENCES ? [`${parts.length} sentences`] : []),
    ...parts.filter(part => words(part) > MAX_WORDS).map(part => `a sentence of ${words(part)} words ("${clip(part, 80)}")`),
    ...(form.paragraphs > 1 ? [`${form.paragraphs} paragraphs`] : []),
    ...(asks && asks < parts.length ? ["a statement and a question in separate sentences"] : []),
  ];
  const format = [
    ...(form.bullets ? [`${form.bullets} bullets`] : []), ...(form.bold ? ["bold"] : []),
    ...(HEADING.test(text) ? ["a heading"] : []), ...(form.label ? ["a label"] : []),
  ];
  return { size, format };
}

/** Whether a call writes the chat's board or a wiki page. */
export function detailWrite(tool: string, input: string): boolean {
  if (tool === "chat_board") { try { return ((JSON.parse(input) as { ops?: unknown[] }).ops ?? []).length > 0; } catch { return false; } }
  return BOARD_SCRIPT.test(input) || WIKI_WRITE.test(input);
}

/** The topic words of a text: lowercase words of 3 or more letters and numbers without their commas, less stop words, ids and a plural s. */
export function topic(text: string): Set<string> {
  return new Set((text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length >= 3 && !STOP.has(word) && !/^[ptd]\d+$/.test(word)).map(word => word.length > 4 ? word.replace(/(?<!s)s$/, "") : word));
}

interface Step { id: string; text: string; note?: string; waitFor?: string; children?: Step[] }
function findStep(plan: readonly Step[], id: string): Step | undefined {
  for (const item of plan) { if (item.id === id) return item; const found = findStep(item.children ?? [], id); if (found) return found; }
  return undefined;
}
function boardPlan(chat: string): Step[] {
  try { return (JSON.parse(readFileSync(join(BOARDS, `${chat}.json`), "utf8")) as { plan?: Step[] }).plan ?? []; } catch { return []; }
}
/** The boards a chat points at: its own and each board whose chat id a call of the chat or its jobs names, as `board.open(chat=...)` does. */
export function pointedBoards(chat: string, inputs: readonly string[]): string[] {
  return [...new Set([chat, ...inputs.flatMap(input => input.match(CHAT_ID) ?? [])])].filter(id => existsSync(join(BOARDS, `${id}.json`)));
}

/**
 * Whether each step a message cites holds the detail the message left out: the step is on one of the boards, its text, note and waitFor share
 * at least TOPIC_WORDS topic words with the sentence that cites it, and they hold at least NEW_WORDS topic words the message does not.
 */
export function citations(text: string, boards: readonly string[]): { id: string; ok: boolean; why: string }[] {
  const said = topic(text);
  return sentences(text).flatMap(sentence => [...new Set(sentence.match(STEP_ID) ?? [])].map(id => {
    const asked = topic(sentence);
    const read = boards.flatMap(chat => { const step = findStep(boardPlan(chat), id); return step ? [{ chat, step }] : []; }).map(({ chat, step }) => {
      const held = topic([step.text, step.note ?? "", step.waitFor ?? ""].join(" "));
      const shared = [...held].filter(word => asked.has(word));
      const fresh = [...held].filter(word => !said.has(word)).length;
      const where = `${id} on board ${chat.slice(0, 8)} ("${clip(step.text, 90)}")`;
      return shared.length < TOPIC_WORDS ? { id, ok: false, why: `${where} shares ${shared.length} topic words with "${clip(sentence, 90)}"` }
        : fresh < NEW_WORDS ? { id, ok: false, why: `${where} holds ${fresh} words the message leaves out` }
        : { id, ok: true, why: `${where} shares ${shared.join(", ")} with its sentence and holds ${fresh} more words` };
    });
    return read.find(entry => entry.ok) ?? read[0] ?? { id, ok: false, why: `${id}, a step on none of the ${boards.length} boards the chat read` };
  }));
}

/** The session ids of the chat and every job collect saw under it: its subagent files, and root jobs from the agents snapshots. */
function family(run: string, chat: string): { id: string; file: string }[] {
  const out = new Map<string, string>();
  for (const file of sessionFiles(chat)) out.set(file.split("/").at(-1)!.replace(/\.jsonl$/, ""), file);
  const dir = join(run, "agents");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    let agents: { sessionId?: string }[] = [];
    try { agents = JSON.parse(readFileSync(join(dir, name), "utf8")) as { sessionId?: string }[]; } catch { continue; }
    for (const agent of agents) if (agent.sessionId && !out.has(agent.sessionId)) out.set(agent.sessionId, "");
  }
  return [...out].map(([id, file]) => ({ id, file }));
}

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const sessions = family(run, chat).map(({ id, file }) => ({ id, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const calls = all.filter((entry): entry is { session: string; event: Extract<SessionEvent, { kind: "call" }> } => entry.event.kind === "call");
  const told = calls.filter(entry => entry.session === chat && entry.event.tool === "tell_owner").map(entry => ({ at: entry.event.at, text: toldText(entry.event.input) }));
  const judged = told.map(said => ({ ...said, ...faults(said.text) }));
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const none = ended ? false : null;

  const long = judged.filter(said => said.size.length);
  add("a", long.length ? false : told.length ? true : none, long.length
    ? long.map(said => `${iso(said.at)} has ${said.size.join(", ")}: "${clip(said.text, 400)}"`).join("; ")
    : told.length ? `${told.length} tell_owner calls, each one point in at most ${MAX_SENTENCES} sentences of at most ${MAX_WORDS} words (${judged.map(said => sentences(said.text).map(words).join("+")).join(", ")} words)`
      : "no tell_owner yet");

  const formatted = judged.filter(said => said.format.length);
  add("b", formatted.length ? false : told.length ? true : none, formatted.length
    ? formatted.map(said => `${iso(said.at)} has ${said.format.join(", ")}: "${clip(said.text, 400)}"`).join("; ")
    : `${told.length} tell_owner calls, none with a bullet, bold, heading or label`);

  const writes = calls.filter(({ event }) => detailWrite(event.tool, event.input));
  const linked = told.filter(said => WIKI_LINK.test(said.text));
  const boards = pointedBoards(chat, calls.map(({ event }) => event.input));
  const cited = told.map(said => ({ ...said, refs: citations(said.text, boards) })).filter(said => said.refs.length);
  const bad = cited.flatMap(said => said.refs.filter(ref => !ref.ok).map(ref => `${iso(said.at)} cites ${ref.why}`));
  const named = cited.filter(said => said.refs.every(ref => ref.ok));
  const detail = writes[0] ? `${writes[0].session.slice(0, 8)} wrote it at ${iso(writes[0].event.at)} (${writes[0].event.tool}): "${clip(writes[0].event.input, 240)}"`
    : linked[0] ? `${iso(linked[0].at)} links a wiki page: "${clip(linked[0].text, 240)}"`
      : named[0] ? `${iso(named[0].at)} names the board steps that hold the rest, ${named[0].refs.map(ref => ref.why).join("; ")}: "${clip(named[0].text, 240)}"` : "";
  const tally = `${writes.length} board or wiki writes, ${linked.length} wiki links and ${named.length} messages whose cited steps hold the rest in all`;
  add("c", bad.length ? (ended ? false : null) : detail ? true : none, bad.length ? `${bad.join("; ")}; ${tally}`
    : detail ? `${detail}; ${tally}` : `none of ${calls.length} calls wrote the board or a wiki page, and no tell_owner links one or names a step that holds the rest`);

  const head = sessions.find(session => session.id === chat)?.events ?? [];
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !ownJob(state.chat.name, event) && !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("d", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  // A window in which pi-pool held every session for want of an Anthropic token (c150 run2, 10-22) tested nothing, so it is void.
  const turns = all.filter(({ event }) => event.kind === "assistant" || event.kind === "call");
  add("e", turns.length ? true : none, turns.length
    ? `${turns.length} model turns and calls in ${new Set(turns.map(turn => turn.session)).size} sessions; first at ${iso(turns[0]!.event.at)}`
    : "no session of the chat took a model turn in the window");

  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false || checks.find(check => check.id === "e")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of the chat and its ${sessions.length - 1} jobs and subagents.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Every tell_owner", "", ...told.map(said => `- ${iso(said.at)}: "${clip(said.text, 600)}"`), "",
  ].join("\n");
  return { verdict, text };
}

export const dryMessage: Scenario = {
  name: "dry-message",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "The crawler runs on this box, so the chat has real state to report.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
