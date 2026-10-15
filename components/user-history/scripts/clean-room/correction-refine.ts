import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c86 (owner 10-15: "one of your duty is these kind of requests when agent made mistake, is to write them down,
 * /refine the harness" and "this should also happen automagicallly"). A fresh chat gets an ordinary task; once it has answered, the owner's
 * second message corrects how it replies. Nobody tells it to record or refine anything. The criteria live in the run folder's criteria.md.
 */
export const TASK = "look into how many of our chat turns waited in the pi-pool queue yesterday and how long the longest waits were. give me the 3 " +
  "biggest causes with numbers";
export const CORRECTION = "stop using bold in your replies, i read these on my phone and it's noisy";
const KEY = /\bbold\b/i;
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const HARNESS = join(HOME, ".prime/agent/harness/harness_state.json");

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Ledger { corrections: { id: string; at: string; chat: { id: string }; words: string; rule: string; repeats: { at: string; chat: { id: string }; words: string }[] }[] }
interface Refinement { id: string; created_at: string; trigger: string; changes: string[]; outcome?: string }
type Entries = Record<string, Record<string, { title?: string; content?: string }>>;

export const correctionRefine: Scenario = {
  name: "correction-refine",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "After its first turn ends, `clean-room.ts say` sends the owner's second message through POST api/threads/<id>/prompt, the composer's route.", "",
    "## The messages", "", `> ${TASK}`, "", `> ${CORRECTION}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const events = readSession(state.chat.id);
  const said = events.find(event => event.kind === "text" && event.role === "user" && event.text.includes(CORRECTION));
  const checks: Check[] = [];
  const ledger = JSON.parse(readFileSync(join(DATA, "corrections.json"), "utf8")) as Ledger;
  const recorded = ledger.corrections.flatMap(entry => [
    ...(entry.chat.id === state.chat.id ? [{ id: entry.id, at: Date.parse(entry.at), words: entry.words, rule: entry.rule }] : []),
    ...entry.repeats.filter(repeat => repeat.chat.id === state.chat.id).map(repeat => ({ id: entry.id, at: Date.parse(repeat.at), words: repeat.words, rule: entry.rule })),
  ]).filter(item => said && item.at >= said.at && CORRECTION.toLowerCase().includes(item.words.toLowerCase().replace(/^["']|["']$/g, "").trim()));
  checks.push({ id: "a", ok: said ? recorded.length > 0 : null, detail: !said ? "the correction has not been sent yet"
    : recorded.length ? recorded.map(item => `${item.id} at ${iso(item.at)}: "${clip(item.words, 120)}", rule "${clip(item.rule, 160)}"`).join("; ") : "no ledger entry or repeat from this chat quotes the correction" });

  const since = recorded.length ? Math.min(...recorded.map(item => item.at)) : Infinity;
  const harness = JSON.parse(readFileSync(HARNESS, "utf8")) as { entries: Entries; refinements: Refinement[] };
  const refinements = harness.refinements.filter(entry => Date.parse(entry.created_at) >= since);
  /** The entries a refinement created or updated, as "kind:id" in its changes ("create prompt:owner_replies_no_bold"). */
  const saved = (entry: Refinement) => entry.changes.flatMap(change => {
    const match = /^(?:create|update) (\w+):(\S+)/.exec(change);
    const found = match && harness.entries[match[1]!]?.[match[2]!];
    return found ? [{ key: `${match![1]}:${match![2]}`, text: `${found.title ?? ""} ${found.content ?? ""}` }] : [];
  });
  const aimed = refinements.filter(entry => saved(entry).some(item => KEY.test(item.text)));
  const notices = events.filter(event => event.kind === "text" && event.customType === "refinement_notice" && event.at >= since);
  checks.push({ id: "b", ok: recorded.length ? aimed.length > 0 : null, detail: !recorded.length ? "nothing recorded yet"
    : aimed.length ? aimed.map(entry => `${entry.id} at ${entry.created_at}: "${clip(entry.trigger, 200)}", saved ${saved(entry).filter(item => KEY.test(item.text)).map(item => `${item.key} "${clip(item.text, 200)}"`).join(", ")}`).join("; ") + `; notices in the chat: ${notices.map(event => `${iso(event.at)} ${clip(event.kind === "text" ? event.text : "", 140)}`).join("; ") || "none"}`
    : `${refinements.length} global refinements since ${iso(since)}, none saved an entry about bold; notices in the chat: ${notices.length}` });

  const prompts = join(run, "prompts", state.chat.id);
  const after = aimed.length ? Math.min(...aimed.map(entry => Date.parse(entry.created_at))) : Infinity;
  const shows = (existsSync(prompts) ? readdirSync(prompts).sort() : []).flatMap(file => {
    const capture = JSON.parse(readFileSync(join(prompts, file), "utf8")) as { capturedAt: string; payload: unknown };
    const at = Date.parse(capture.capturedAt);
    if (at <= after) return [];
    const text = JSON.stringify(capture.payload);
    const ids = aimed.filter(entry => text.includes(entry.id) || saved(entry).some(item => text.includes(item.key.split(":")[1]!)));
    return ids.length ? [`${capture.capturedAt}: names ${ids.map(entry => entry.id).join(", ")}`] : [];
  });
  checks.push({ id: "c", ok: aimed.length ? shows.length > 0 : null, detail: !aimed.length ? "no aimed refinement yet" : shows.length ? shows.join("; ") : "no Prompt view capture after the refinement names it" });

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child");
  checks.push({ id: "d", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed.map(event => `typed at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`), ...outside.map(event => `message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the two owner-style messages and server notes reached the chat" });

  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file, ${join(DATA, "corrections.json")}, ${HARNESS} and ${prompts}.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
