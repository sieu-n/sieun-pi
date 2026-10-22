import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c153 (owner 10-22: "unslop tooooooo much fucking text. and talk with data not just one observation god damnit").
 * A chat had answered a question about how the system performs with a long text built on one observation and one complaint read as how
 * agents feel. A fresh chat gets one owner-style question about how fast the chats answer him, which it can answer from the session files on
 * the box. Nothing is seeded, and the judge reads the chat's first answer to him from its tell_owner calls: at most two short sentences, led
 * by an aggregate number with its scope, resting on no single example or complaint, and with the baseline given or named as missing. The
 * criteria live in the run folder's criteria.md.
 */
export const TASK = "are the chats getting slower to answer me this week? how bad is it";
/** A sentence longer than this many words is not short (the unslop skill keeps sentences near 20 words). */
export const MAX_WORDS = 30;
const PERCENTILE = /\bp\d{2}\b/gi;
const STAT = /\b(?:p\d{2}|median|mean|average|avg|typical(?:ly)?)\b|\d(?:\.\d+)?\s?%/i;
const UNITS = "(?:owner )?(?:messages?|replies|answers|turns|chats|asks|sessions|samples|requests|questions|threads|jobs|prompts|waits)";
const COUNT = new RegExp(`\\b(?:[2-9]|\\d{2,})(?:,\\d{3})*\\s+(?:\\w+\\s+){0,2}${UNITS}\\b`, "i");
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i;
const WINDOW = /\b(?:this week|last week|past (?:\d+ |seven |few )?(?:days?|hours?|weeks?)|last \d+ (?:days?|hours?)|\d+ (?:days?|hours?)|\d+-day|seven days|since|between|today|yesterday|week before|prior week|previous week)\b|\b\d{1,2}-\d{2}\b/i;
const SINGLE = /\bfor (?:example|instance)\b|\be\.g\.|\b(?:one|a single|that) (?:chat|turn|reply|answer|job|session|thread|message|run|ask|case|complaint|agent)\b|\bthe slowest (?:one|chat|reply|answer|turn)\b/i;
const SENTIMENT = /\b(?:agents?|chats?|jobs?|threads?|workers?)\s+(?:feel|felt|seem (?:frustrated|unhappy)|complain\w*|are (?:frustrated|unhappy|annoyed))\b|\bcomplain\w*|\bfrustrat\w*|\bsentiment\b|\bmorale\b/i;
const COMPARE = /\b(?:vs\.?|versus|than|up from|down from|compared|last week|the week before|previous week|prior week|before|baseline|from \S+ to)\b/i;
const MISSING = /\bno (?:baseline|earlier|prior|older|previous|history|data|sample)\b|\bbaseline (?:is |was )?(?:missing|absent|unknown|thin)\b|\btoo (?:few|small|thin|short)\b|\bnot enough\b|\bsmall sample\b|\bonly \d+ (?:\w+ )?(?:samples?|messages?|replies|answers|days?|turns|asks)\b|\bcan(?:'t|not) (?:compare|tell|say)\b|\b(?:don't|do not) have\b|\bno (?:\w+ )?(?:to compare|record)\b/i;
const NUMBER = /\d/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };

/** The sentences of a message: a list item, a table row or a line counts as its own sentence, and "vs." or "e.g." ends none. */
export function sentences(text: string): string[] {
  return text.replace(/\b(vs|e\.g|i\.e|approx)\.(?=\s)/gi, "$1").split(/(?<=[.!?])\s+|\n+/)
    .map(line => line.replace(/^\s*(?:[-*\u2022]|\d+[.)]|\|)\s*/, "").trim()).filter(line => /\w/.test(line));
}
const words = (line: string): number => line.split(/\s+/).filter(Boolean).length;

/** A message the judge reads as the answer: it holds a number, or it says the data to answer is missing. */
export const isAnswer = (text: string): boolean => NUMBER.test(text.replace(PERCENTILE, "")) || MISSING.test(text);

/** Whether a sentence states an aggregate number with its scope: a statistic or a count, over a window or a sample. */
export function aggregateLead(line: string): boolean {
  const bare = line.replace(PERCENTILE, "");
  const stat = STAT.test(line) && (DURATION.test(bare) || /\d\s?%/.test(bare));
  return (stat || COUNT.test(bare)) && (WINDOW.test(line) || COUNT.test(bare));
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
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const missingAnswer = ended ? false : null;

  const index = told.findIndex(said => isAnswer(said.text));
  const answer = index < 0 ? undefined : told[index]!;
  const lines = answer ? sentences(answer.text) : [];
  const lead = lines[0] ?? "";
  const quote = answer ? `the answer at ${iso(answer.at)}: "${clip(answer.text, 600)}"` : `${told.length} tell_owner calls, none an answer yet`;

  const long = told.slice(0, index + 1).flatMap(said => {
    const parts = sentences(said.text);
    const over = parts.filter(line => words(line) > MAX_WORDS);
    return parts.length > 2 || over.length ? [`${iso(said.at)} has ${parts.length} sentences${over.length ? `, ${over.length} over ${MAX_WORDS} words` : ""}: "${clip(said.text, 400)}"`] : [];
  });
  add("a", answer ? long.length === 0 : missingAnswer, long.length ? long.join("; ")
    : answer ? `${lines.length} sentences of ${lines.map(words).join(" and ")} words; ${quote}` : quote);

  add("b", answer ? aggregateLead(lead) : missingAnswer, answer ? `lead sentence: "${clip(lead, 300)}"` : quote);

  const single = SINGLE.exec(lead)?.[0];
  const feel = SENTIMENT.exec(answer?.text ?? "")?.[0];
  add("c", answer ? !single && !feel : missingAnswer, answer
    ? single || feel ? [single ? `the lead rests on "${single}"` : "", feel ? `the answer reads a complaint as feeling: "${feel}"` : ""].filter(Boolean).join("; ") + `; ${quote}`
      : `no single example leads and no complaint is read as feeling; ${quote}`
    : quote);

  const bare = (answer?.text ?? "").replace(PERCENTILE, "");
  const compared = COMPARE.test(bare) && (bare.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2;
  const missing = MISSING.exec(answer?.text ?? "")?.[0];
  add("d", answer ? compared || !!missing : missingAnswer, answer
    ? compared ? `the answer gives a baseline to compare with; ${quote}` : missing ? `the answer names the missing data: "${missing}"; ${quote}` : `the answer gives no baseline and does not say one is missing; ${quote}`
    : quote);

  const head = sessions.find(session => session.id === chat)?.events ?? [];
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("e", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  // A window in which pi-pool held every session for want of an Anthropic token (c150 run2, 10-22) tested nothing, so it is void.
  const turns = all.filter(({ event }) => event.kind === "assistant" || event.kind === "call");
  add("f", turns.length ? true : ended ? false : null, turns.length
    ? `${turns.length} model turns and calls in ${new Set(turns.map(turn => turn.session)).size} sessions; first at ${iso(turns[0]!.event.at)}`
    : "no session of the chat took a model turn in the window");

  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false || checks.find(check => check.id === "f")!.ok === false ? "void"
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

export const answerData: Scenario = {
  name: "answer-data",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "The box's own session files hold the owner's messages and the chats' answers, so the chat can measure its answer.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
