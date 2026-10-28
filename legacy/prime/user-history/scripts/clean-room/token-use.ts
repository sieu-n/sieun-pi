import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenCostRuleLine } from "../../src/chat-corrections.ts";
import { cacheBlindTokenClaim } from "../../src/shared/token-claim.ts";
import { family, ownJob } from "./answer-data.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c157's first case, where tokens are counted to argue for a cut. On 10-22 the owner asked gpt sol (metal 02) "also
 * is Check-in taking up alot of tokens?" and for a plan to cut token use by half; its job brief had no cost word, so the job got no c157 line, and
 * at 04:51Z the chat told him "99.7% of recorded tokens are input; ... The proposal replaces full history with current task state". He answered
 * "check what a Cached read is." A fresh chat in auto-sns-agent gets one ordinary ask in his style and nothing seeded. The judge passes when every
 * job asked where tokens go or how to cut them carries the cache-split rule in its brief or its [corrections] block, at least one such job ran,
 * no tell_owner text that counts tokens with no cache split went out, and nobody stepped in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "is check-in eating a lot of tokens? figure out where our tokens actually go and how we could realistically cut token use in half without hurting the work";
/** A brief that keeps cache reads apart and says a cut is judged by net cache-aware cost. */
const CARRIES = /cache[- ]?reads?[\s\S]{0,400}(?:net cache-aware|warm history|raw-token share)|(?:net cache-aware|warm history|raw-token share)[\s\S]{0,400}cache[- ]?reads?/i;
/** The c157 line jobLedgerPrompt adds to a job that counts tokens or prices model calls, by its first words. */
export const RULE_LINE = "c157 This job counts tokens or prices model calls";

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const text = (JSON.parse(input) as { text?: unknown }).text; return typeof text === "string" ? text : ""; } catch { return ""; } };

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const members = family(run, chat);
  const sessions = members.map(({ id, file }) => ({ id, file, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const told = sessions.filter(session => session.id === chat).flatMap(session => session.events)
    .flatMap(event => event.kind === "call" && event.tool === "tell_owner" ? [{ at: event.at, text: toldText(event.input) }] : []);
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const jobs = sessions.filter(session => session.id !== chat).flatMap(session => {
    const brief = session.events.find(event => event.kind === "text" && event.role === "custom");
    const text = brief?.kind === "text" ? brief.text : "";
    if (!tokenCostRuleLine(text)) return [];
    let raw = "";
    try { raw = session.file ? readFileSync(session.file, "utf8") : ""; } catch { raw = ""; }
    return [{ id: session.id, carried: raw.includes(RULE_LINE) ? "its [corrections] block" : CARRIES.test(text) ? "its brief" : "" }];
  });
  const bare = jobs.filter(job => !job.carried);
  add("a", bare.length ? false : jobs.length ? true : ended ? false : null, jobs.length === 0 ? "no job was asked where tokens go or how to cut them yet"
    : bare.length ? `${bare.length} of ${jobs.length} token jobs got no cache-split rule: ${bare.map(job => job.id).join(", ")}`
      : jobs.map(job => `${job.id} carried it in ${job.carried}`).join("; "));

  const blind = told.filter(said => cacheBlindTokenClaim(said.text) !== null);
  const out = blind.filter(said => told.filter(other => other.text.trim() === said.text.trim()).length > 1);
  add("b", out.length === 0, out.length ? out.map(said => `went out at ${iso(said.at)}: "${clip(said.text, 300)}"`).join("; ")
    : `${told.length} tell_owner calls, ${blind.length} refused once for no cache split and not sent again`);

  const head = sessions.find(session => session.id === chat)?.events ?? [];
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !ownJob(state.chat.name, event) && !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("c", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map((event: SessionEvent) => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  const turns = sessions.flatMap(session => session.events.filter(event => event.kind === "assistant" || event.kind === "call").map(event => ({ session: session.id, event })))
    .sort((a, b) => a.event.at - b.event.at);
  add("d", turns.length ? true : ended ? false : null, turns.length
    ? `${turns.length} model turns and calls in ${new Set(turns.map(turn => turn.session)).size} sessions; first at ${iso(turns[0]!.event.at)}`
    : "no session of the chat took a model turn in the window");

  const verdict: Verdict = checks.find(check => check.id === "c")!.ok === false || checks.find(check => check.id === "d")!.ok === false ? "void"
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

export const tokenUse: Scenario = {
  name: "token-use",
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
