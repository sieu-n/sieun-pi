import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for chat tools after an archive and reopen (release-4f57a05, 10-17). On 10-16 chat 01a14210 came back from an archive
 * without chat_board and tell_owner, and could not reach the owner or its board. A fresh chat gets an ordinary task. Once it has answered and sits
 * idle, `clean-room.ts archive` archives that chat alone through the server's archive route, and `say` sends the owner's next message, which
 * reopens it. Nobody tells it anything about tools. The criteria live in the run folder's criteria.md.
 */
export const TASK = "count how many test files components/user-history has and how many of them mention python, and keep both numbers on the board";
export const FOLLOW_UP = "thanks. now do the same count for components/pi-pool and add it to the board next to the first one";
export const EXPECTED_TOOLS = ["ipython", "chat_board", "tell_owner", "correction_add", "poteto_mode"];
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const MISSING_TOOL = /unknown tool|tool not found|no such tool|tool .{0,40} is not available/i;

/** What `clean-room.ts archive` recorded when it archived the chat. */
export interface ArchiveMark { at: number; lines: number; rev: number; idle: string }

interface Entry { line: number; at: number; type?: string; customType?: string; role?: string; stopReason?: string; text: string;
  calls: { id: string; name: string }[]; result?: { id: string; error: boolean }; status?: string }
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.map(block => typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : "").join("\n") : "";

/** The chat's own session file, entry by entry. */
export function chatEntries(chat: string): Entry[] {
  const file = join(HOME, ".prime/agent/sessions", `${chat}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((raw, line) => {
    if (!raw.trim()) return [];
    let entry: { type?: string; customType?: string; timestamp?: string; content?: unknown; state?: { status?: string };
      message?: { role?: string; stopReason?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try { entry = JSON.parse(raw); } catch { return []; }
    const message = entry.message ?? {};
    const calls = Array.isArray(message.content) ? (message.content as { type?: string; id?: string; name?: string }[])
      .filter(block => block.type === "toolCall").map(block => ({ id: String(block.id ?? ""), name: String(block.name ?? "") })) : [];
    return [{ line, at: Date.parse(entry.timestamp ?? "") || 0, ...(entry.type ? { type: entry.type } : {}), ...(entry.customType ? { customType: entry.customType } : {}),
      ...(message.role ? { role: message.role } : {}), ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      text: text(message.content ?? entry.content), calls, ...(entry.state?.status ? { status: entry.state.status } : {}),
      ...(message.role === "toolResult" ? { result: { id: String(message.toolCallId ?? ""), error: message.isError === true } } : {}) }];
  });
}

/** Each named tool's calls in `entries` with whether its result came back without an error. */
function toolOutcomes(entries: readonly Entry[], names: readonly string[]): Record<string, { calls: number; ok: number; errors: string[] }> {
  const out = Object.fromEntries(names.map(name => [name, { calls: 0, ok: 0, errors: [] as string[] }]));
  for (const entry of entries) for (const call of entry.calls) {
    const slot = out[call.name];
    if (!slot) continue;
    slot.calls++;
    const result = entries.find(other => other.result?.id === call.id);
    if (result && !result.result!.error) slot.ok++;
    else slot.errors.push(result ? `${iso(result.at)} "${clip(result.text)}"` : `${iso(entry.at)} no result`);
  }
  return out;
}

/** The Prompt view captures `collect` saved for the chat, oldest first. */
function captures(run: string, chat: string): { at: number; tools: string[]; chat: boolean }[] {
  const dir = join(run, "prompts", chat);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map(name => {
    const capture = JSON.parse(readFileSync(join(dir, name), "utf8")) as { capturedAt: string; payload?: { tools?: { name?: string }[]; instructions?: unknown; system?: unknown } };
    const prompt = JSON.stringify(capture.payload?.instructions ?? capture.payload?.system ?? "");
    return { at: Date.parse(capture.capturedAt), tools: (capture.payload?.tools ?? []).map(tool => String(tool.name ?? "")), chat: prompt.includes("This session is a chat") };
  });
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const entries = chatEntries(chat);
  const markFile = join(run, "archive.json");
  const mark = existsSync(markFile) ? JSON.parse(readFileSync(markFile, "utf8")) as ArchiveMark : undefined;
  const reopen = mark ? entries.find(entry => entry.at > mark.at && entry.role === "user" && entry.text.includes(FOLLOW_UP)) : undefined;
  const before = entries.filter(entry => entry.at >= state.windowStart && (!mark || entry.at < mark.at));
  const after = reopen ? entries.filter(entry => entry.at >= reopen.at) : [];
  const checks: { id: number; ok: boolean | null; detail: string }[] = [];
  const add = (id: number, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const pre = toolOutcomes(before, ["chat_board", "tell_owner"]);
  add(1, Object.values(pre).every(tool => tool.ok > 0) ? true : mark ? false : null,
    Object.entries(pre).map(([name, tool]) => `${name}: ${tool.ok} of ${tool.calls} calls ok${tool.errors.length ? ` (${tool.errors.join("; ")})` : ""}`).join(", "));

  const archived = mark ? entries.find(entry => entry.type === "session_state" && entry.status === "archived" && Math.abs(entry.at - mark.at) < 60_000) : undefined;
  add(2, mark ? Boolean(archived) && mark.idle.startsWith("idle") : null, mark ? `archived through the route at ${iso(mark.at)} (${mark.idle}); ` +
    `session_state archived ${archived ? `at ${iso(archived.at)}` : "not found"}` : "not archived yet");

  const between = mark ? entries.filter(entry => entry.at > mark.at && (!reopen || entry.at < reopen.at) &&
    (entry.role === "assistant" || entry.role === "user" || entry.customType === "agent_message" || entry.customType === "pi-pool-queue")) : [];
  add(3, mark ? (between.length === 0 ? (reopen ? true : null) : false) : null,
    between.length ? between.slice(0, 5).map(entry => `${iso(entry.at)} ${entry.role ?? entry.customType} "${clip(entry.text, 120)}"`).join("; ") : "nothing reached the session after the archive");

  const firstAfter = mark ? entries.find(entry => entry.at > mark.at && (entry.role === "user" || entry.customType === "agent_message")) : undefined;
  add(4, mark ? (firstAfter ? firstAfter === reopen : null) : null, firstAfter ? `first input after the archive at ${iso(firstAfter.at)}: "${clip(firstAfter.text, 160)}"` : "no input after the archive yet");

  const kept = mark ? entries.filter(entry => entry.line < mark.lines).length : 0;
  add(5, reopen ? kept === mark!.lines || kept >= mark!.lines - 1 : null, mark ? `${kept} of the ${mark.lines} lines from before the archive are still first in sessions/${chat}.jsonl` : "not archived yet");

  const caps = captures(run, chat);
  const firstCap = reopen ? caps.find(capture => capture.at >= reopen.at) : undefined;
  const mode = entries.some(entry => entry.customType === "chat_mode");
  add(6, reopen ? (firstCap ? mode && firstCap.chat : null) : null, `chat_mode entry ${mode ? "present" : "missing"}; ` +
    (firstCap ? `the first capture after the reopen (${iso(firstCap.at)}) ${firstCap.chat ? "carries" : "lacks"} the chat brief` : "no capture after the reopen yet"));

  const post = toolOutcomes(after, ["chat_board", "tell_owner"]);
  const same = firstCap ? [...firstCap.tools].sort().join(",") === [...EXPECTED_TOOLS].sort().join(",") : false;
  add(7, reopen ? (firstCap && Object.values(post).every(tool => tool.ok > 0) ? same : firstCap && !same ? false : null) : null,
    `${firstCap ? `tools offered: ${firstCap.tools.join(", ")}` : "no capture yet"}; ` +
    Object.entries(post).map(([name, tool]) => `${name}: ${tool.ok} of ${tool.calls} calls ok${tool.errors.length ? ` (${tool.errors.join("; ")})` : ""}`).join(", "));

  const boardFile = join(DATA, "boards", `${chat}.json`);
  const rev = existsSync(boardFile) ? (JSON.parse(readFileSync(boardFile, "utf8")) as { rev?: number }).rev ?? 0 : 0;
  const boardCalls = after.some(entry => entry.calls.some(call => call.name === "chat_board"));
  add(8, reopen ? (rev > mark!.rev ? true : boardCalls ? false : null) : null, mark ? `board rev ${mark.rev} at the archive, ${rev} now` : "not archived yet");

  const missing = after.filter(entry => MISSING_TOOL.test(entry.text));
  add(9, reopen ? missing.length === 0 : null, missing.length ? missing.slice(0, 3).map(entry => `${iso(entry.at)} "${clip(entry.text)}"`).join("; ") : "no missing-tool error after the reopen");

  const foreign = entries.filter(entry => entry.at >= state.windowStart && entry.role === "user" && !entry.text.trim().startsWith("[") &&
    !state.seeds.some(seed => entry.text.includes(seed.slice(0, 80))) && !entry.text.includes("<skill"));
  add(10, foreign.length === 0, foreign.length ? foreign.map(entry => `${iso(entry.at)} "${clip(entry.text, 120)}"`).join("; ") : "every user message is a seed or a server notice");

  const verdict: Verdict = checks.some(check => check.ok === false) ? "fail" : checks.every(check => check.ok === true) ? "pass" : "open";
  const lines = [`# ${state.chat.name}: ${verdict}`, "", `Chat ${chat} on ${state.release}, set up ${iso(state.setupAt)}.`, "",
    ...checks.map(check => `${check.id}. ${check.ok === null ? "not reached yet" : check.ok ? "met" : "not met"}: ${check.detail}`), ""];
  return { verdict, text: lines.join("\n") };
}

export const chatToolsReopen: Scenario = {
  name: "chat-tools-reopen",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "`clean-room.ts archive` archives that chat alone through POST api/threads/<id>/archive once it is idle, and `clean-room.ts say` sends the owner's next message.", "",
    "## The messages", "", `> ${TASK}`, "", `> ${FOLLOW_UP}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
