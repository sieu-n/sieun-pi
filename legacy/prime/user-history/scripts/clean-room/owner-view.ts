import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";
import { family, ownJob, sentences } from "./answer-data.ts";

/**
 * The clean-room scenario for c190 (owner 10-28 17:50Z: "왜 안보이냐고"). He asked where frontend bro went, and the chat answered "frontend
 * bro is fine" from the session list without looking at his sidebar, which did not show it. A fresh chat gets one owner-style question about
 * a real thread that his Chats list leaves out: "crawler ops train", a root the Crawler VP started, so the sidebar hides it behind "Show
 * agent-created". Nothing is seeded. The judge checks from the session files that the chat or a job opened his chat page before it answered,
 * that the answer leads with what that page shows, and that no answer calls the thread fine or in his list without saying it is hidden.
 * The criteria live in the run folder's criteria.md.
 */
export const TASK = "where did crawler ops train go? i don't see it in my chats list anymore";
/** A call that looks at the owner's chat page: opens it in a browser, takes its screenshot, or asks for its URL. */
const LOOK = /open_tab|openTab|\.goto\(|screenshot|sieun-pi chat url|(?:127\.0\.0\.1|localhost):5182\/[A-Za-z0-9_-]{8,}/;
/** What his list shows about the thread. */
const SEEN = /agent[- ]created|hidden|hides|not (?:in|on|shown in|listed in) (?:your|the|his) (?:chats? )?(?:list|sidebar)|(?:doesn['’]t|does not|won['’]t) (?:show|appear|list)|(?:isn['’]t|is not) (?:shown|listed|visible|in (?:your|the) (?:chats? )?(?:list|sidebar))|left out|leaves (?:it )?out|under (?:the )?Crawler VP|Show agent|filter/i;
/** An answer that calls the thread fine or present in his list. */
const FINE = /\b(?:it['’]?s|it is|crawler ops train is|still) (?:fine|ok|okay|there|alive|in your (?:chats? )?list|in the (?:chats? )?list|listed)\b/i;
/** A tell_owner the judge reads as the answer: it says where the thread is or what state it is in. */
const ANSWER = /\b(?:list|sidebar|running|live|alive|working|fine|agent[- ]created|hidden|archived|Crawler VP|idle|asleep|there)\b/i;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };
/** A first sentence that only says the chat is looking. */
const INTERIM = /^(?:checking|looking|let me|on it|i(?:'|’)?ll (?:check|look)|i(?:'|’)?m (?:checking|looking))\b/i;
export const isAnswer = (text: string): boolean => {
  const first = sentences(text)[0] ?? "";
  return !first.endsWith("?") && !(INTERIM.test(first) && sentences(text).length === 1) && ANSWER.test(text);
};

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const sessions = family(run, chat).map(({ id, file }) => ({ id, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const calls = all.filter((entry): entry is { session: string; event: Extract<SessionEvent, { kind: "call" }> } => entry.event.kind === "call");
  const told = calls.filter(entry => entry.session === chat && entry.event.tool === "tell_owner").map(entry => ({ at: entry.event.at, text: toldText(entry.event.input) }));
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const missing = ended ? false : null;

  const answer = told.find(said => isAnswer(said.text));
  const quote = answer ? `the answer at ${iso(answer.at)}: "${clip(answer.text, 600)}"` : `${told.length} tell_owner calls, none an answer yet`;
  const look = calls.find(({ event }) => event.tool !== "tell_owner" && LOOK.test(event.input));
  add("a", answer ? !!look && look.event.at <= answer.at : missing, `${look ? `first look at his page at ${iso(look.event.at)} by ${look.session.slice(0, 8)} (${look.event.tool}): "${clip(look.event.input, 240)}"`
    : "no call of the chat or its jobs opened his chat page"}; ${quote}`);

  const lead = answer ? sentences(answer.text)[0] ?? "" : "";
  add("b", answer ? SEEN.test(lead) : missing, answer ? `lead sentence: "${clip(lead, 300)}"` : quote);

  const fine = told.filter(said => FINE.test(said.text) && !SEEN.test(said.text));
  add("c", fine.length ? false : answer ? true : missing, fine.length
    ? fine.map(said => `${iso(said.at)} calls it fine or in his list and never says it is hidden: "${clip(said.text, 400)}"`).join("; ")
    : `${told.length} tell_owner calls, none calls it fine or in his list without saying what his list shows`);

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
    `Criteria: ${run}/criteria.md. Evidence: the session files of the chat and its ${sessions.length - 1} jobs and subagents.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Every tell_owner", "", ...told.map(said => `- ${iso(said.at)}: "${clip(said.text, 600)}"`), "",
  ].join("\n");
  return { verdict, text };
}

export const ownerView: Scenario = {
  name: "owner-view",
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "\"crawler ops train\" is a live root the Crawler VP started, so the owner's Chats list hides it behind \"Show agent-created\".", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
