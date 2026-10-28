import { readFileSync } from "node:fs";
import { join } from "node:path";
import { family, ownJob } from "./answer-data.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c157's cost-estimate repeat. On 10-27 at 19:14:01Z the owner asked Crawler VP what classifying creators with
 * DeepSeek Flash, Jev or GPT luna would cost, its job brief said nothing on how to price the shared instructions, its own sketch priced every
 * input token as fresh, and at 19:14:49Z he wrote "note that system prompt (instruction) should be registered as Cache read". A fresh chat in
 * auto-sns-agent gets one ordinary cost question in his style and nothing seeded. The judge passes when the estimate prices the shared
 * instructions at the cache-read rate in a text an agent of the chat wrote, each job asked for a model cost carries that rule in its brief or
 * its [corrections] block, the owner got a dollar number, and nobody stepped in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "how much would it cost to run every creator bio we have through deepseek flash or gpt luna to tag a category? ballpark is fine";
/** A text that prices the part every call repeats as cache reads, the same test as `tokenCostRuleLine`'s, with "cached" and "prompt prefix" too. */
export const PRICES_SHARED_AS_CACHED = /(?:system prompt|instructions?|shared (?:prefix|part|prompt)|prompt prefix|fixed prompt)(?:[^.\n]|\.\d){0,100}(?:cache[- ]?reads?|cached)|(?:cache[- ]?reads?|cached)(?:[^.\n]|\.\d){0,100}(?:system prompt|instructions?|shared (?:prefix|part|prompt)|prompt prefix|fixed prompt)/i;
/** The c157 line jobLedgerPrompt adds to a job that counts tokens or prices model calls, by its first words. */
const RULE_LINE = "c157 This job counts tokens or prices model calls";
const COST_ASK = /\b(?:costs?|pric(?:e|es|ed|ing)|spend|budget)\b/i;
const MODEL_ASK = /\b(?:tokens?|llms?|deepseek|luna|gpt[- ]?\w*|model calls?)\b/i;
const DOLLARS = /\$\s?\d/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };
const written = (event: SessionEvent): string => event.kind === "assistant" ? event.text : event.kind === "call" ? event.input : event.kind === "sent" ? event.text : "";

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const members = family(run, chat);
  const sessions = members.map(({ id, file }) => ({ id, file, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const told = all.filter(({ session, event }) => session === chat && event.kind === "call" && event.tool === "tell_owner")
    .map(({ event }) => ({ at: event.at, text: toldText((event as Extract<SessionEvent, { kind: "call" }>).input) }));
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const priced = all.find(({ event }) => PRICES_SHARED_AS_CACHED.test(written(event)));
  const pricedText = priced ? written(priced.event) : "";
  const match = priced ? PRICES_SHARED_AS_CACHED.exec(pricedText)![0] : "";
  add("a", priced ? true : ended ? false : null, priced
    ? `session ${priced.session} at ${iso(priced.event.at)} (${priced.event.kind}) prices the shared part as cache reads: "${clip(match, 300)}"`
    : "no text an agent of the chat wrote prices the shared instructions as cache reads yet");

  const jobs = sessions.filter(session => session.id !== chat).flatMap(session => {
    const brief = session.events.find(event => event.kind === "text" && event.role === "custom");
    const text = brief?.kind === "text" ? brief.text : "";
    if (!COST_ASK.test(text) || !MODEL_ASK.test(text)) return [];
    let raw = "";
    try { raw = session.file ? readFileSync(session.file, "utf8") : ""; } catch { raw = ""; }
    return [{ id: session.id, carried: PRICES_SHARED_AS_CACHED.test(text) ? "its brief" : [RULE_LINE, "c157 This job prices model calls"].some(line => raw.includes(line)) ? "its [corrections] block" : "" }];
  });
  const bare = jobs.filter(job => !job.carried);
  add("b", bare.length === 0, jobs.length === 0 ? "no job was asked for a model cost"
    : bare.length ? `${bare.length} of ${jobs.length} cost jobs got no cache-read rule: ${bare.map(job => job.id).join(", ")}`
      : jobs.map(job => `${job.id} carried it in ${job.carried}`).join("; "));

  const answer = told.find(said => DOLLARS.test(said.text));
  add("c", answer ? true : ended ? false : null, answer ? `the answer at ${iso(answer.at)}: "${clip(answer.text, 600)}"` : `${told.length} tell_owner calls, none with a dollar number yet`);

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

  const turns = all.filter(({ event }) => event.kind === "assistant" || event.kind === "call");
  add("e", turns.length ? true : ended ? false : null, turns.length
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

export const tokenCost: Scenario = {
  name: "token-cost",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "", "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  endsAtVerdict: true,
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
