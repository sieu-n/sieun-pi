import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TELL_OWNER_HELD, TELL_OWNER_TOOL } from "../../src/shared/chat-feed.ts";
import { SHOP_TALK_MARK, shopTalk } from "../../src/shared/reply-lint.ts";
import { shape } from "./dm-replies.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c18 and its 10-19 kin c135 and c138 (owner 10-19 to frontend bro: "이런 slop식으로 말할ㄹ래???", then
 * "slop slop \"Home says 0 matched\" \"Killed the zero-result filter check\" slop yuck disgusting again"). A fresh chat gets one ordinary
 * question whose answer comes from git and release logs, so its jobs report commit ids, UTC times and "landed", and the judge reads every
 * tell_owner call: the ones that reached the owner carry no shop talk (`shopTalk`) and read like texts.
 */
export const TASK = "which sieun-pi changes went live on the chat app here today and around what time, and is anything on main still not " +
  "live? put a job on it and tell me when you know";
const SESSIONS = join(homedir(), ".prime/agent/sessions");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n") : "";

/** One tell_owner call and what its result says: sent to the owner, held as a note, or refused (`refusal` is the tool's text). */
interface Call { at: number; text: string; outcome: "sent" | "held" | "refused" | "pending"; refusal: string }

function read(file: string, since: number): { calls: Call[]; reports: number[]; typed: string[]; outside: string[]; firstOwner: string } {
  const calls = new Map<string, Call>();
  const reports: number[] = [];
  const typed: string[] = [];
  const outside: string[] = [];
  let firstOwner = "";
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (at < since) continue;
    if (entry.type === "custom_message" && entry.customType === "agent_message") {
      const relation = String((entry.details as { fromRelationship?: unknown } | undefined)?.fromRelationship ?? "");
      const text = blockText(entry.content);
      if (relation === "child" || /^\[agent-message from child:/.test(text)) reports.push(at);
      else if (relation === "parent" || relation === "sibling") outside.push(text);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
    if (message.role === "user") {
      const text = blockText(message.content);
      if (text.trimStart().startsWith("[") || text.includes("<skill")) continue;
      if (!firstOwner && text.includes(TASK.slice(0, 60))) firstOwner = text;
      else typed.push(text);
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: { text?: unknown } }[]) {
        if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && part.id) {
          calls.set(part.id, { at, text: typeof part.arguments?.text === "string" ? part.arguments.text : "", outcome: "pending", refusal: "" });
        }
      }
    }
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      const text = blockText(message.content);
      call.outcome = message.isError ? "refused" : text.startsWith(TELL_OWNER_HELD) ? "held" : "sent";
      if (message.isError) call.refusal = text;
    }
  }
  return { calls: [...calls.values()], reports, typed, outside, firstOwner };
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function judgeFile(file: string, since: number): { checks: { id: string; ok: boolean | null; detail: string }[]; calls: Call[] } {
  const { calls, reports, typed, outside, firstOwner } = read(file, since);
  const sent = calls.filter(call => call.outcome === "sent");
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  add("a", reports.length ? true : null, `${reports.length} job reports reached the chat`);
  const talk = sent.map(call => ({ call, words: shopTalk(call.text, firstOwner) })).filter(item => item.words.length);
  add("b", talk.length ? false : sent.length ? true : null, talk.length
    ? talk.map(item => `${iso(item.call.at)} "${clip(item.call.text)}" has ${item.words.join(", ")}`).join("; ")
    : `${sent.length} messages reached the owner, none with shop talk`);
  const after = reports.length ? sent.filter(call => call.at > reports[0]!) : [];
  add("c", after.length ? true : null, after.length ? `${after.length} messages reached him after the first job report at ${iso(reports[0]!)}, first "${clip(after[0]!.text)}"`
    : "no message has reached him after a job report yet");
  const shapes = sent.map(call => ({ call, shape: shape(call.text) }));
  const formatted = shapes.filter(item => item.shape.bullets > 0 || item.shape.bold || item.shape.label);
  const mid = median(shapes.map(item => item.shape.sentences));
  add("d", formatted.length || mid > 2 ? false : after.length ? true : null, formatted.length
    ? formatted.map(item => `${iso(item.call.at)} "${clip(item.call.text)}"`).join("; ") : `median ${mid} sentences over ${sent.length} messages, no bullets, bold or labels`);
  add("e", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed.map(text => `typed "${clip(text, 120)}"`), ...outside.map(text => `message "${clip(text, 120)}"`)].join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");
  return { checks, calls };
}

function table(calls: readonly Call[]): string[] {
  return ["| at | outcome | text | refusal |", "|---|---|---|---|",
    ...calls.map(call => `| ${iso(call.at)} | ${call.outcome} | ${clip(call.text, 240).replace(/\|/g, "\\|")} | ${clip(call.refusal.replace(SHOP_TALK_MARK, "shop talk"), 160).replace(/\|/g, "\\|")} |`)];
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const { checks, calls } = judgeFile(join(SESSIONS, `${state.chat.id}.jsonl`), state.windowStart);
  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const refused = calls.filter(call => call.refusal.startsWith(SHOP_TALK_MARK)).length;
  return { verdict, text: [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    `The shop talk check refused ${refused} of ${calls.length} tell_owner calls.`, "", "## Every tell_owner call", "", ...table(calls), "",
  ].join("\n") };
}

/** `<session id>[@<ISO time>]`: the same checks on any chat's calls from that time on. */
function baseline(before: string): { verdict: Verdict; text: string } {
  const [id, since] = before.split("@");
  const { checks, calls } = judgeFile(join(SESSIONS, `${id}.jsonl`), since ? Date.parse(since) : 0);
  const ok = checks.filter(check => check.id === "b" || check.id === "d").every(check => check.ok !== false);
  return { verdict: ok ? "pass" : "fail", text: [`# Plain words, ${id} from ${since ?? "the start"}: ${ok ? "pass" : "fail"}`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "", ...table(calls), ""].join("\n") };
}

export const plainWords: Scenario = {
  name: "plain-words",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline,
};
