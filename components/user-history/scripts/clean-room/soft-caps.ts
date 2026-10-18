import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatBoard } from "../../src/shared/types.ts";
import { readSession, sessionFiles, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for soft caps (owner 10-18: "not just chat messages, but EVERYTHING. duties, plan, chat system, subagents, .. if it's
 * an arbitrary limit enforced in sieun-pi ... all these should be modeled as a soft cap"). A fresh chat gets one ordinary task that walks past
 * several old hard caps at once: many plan steps, an ask per broken duty with every option, and the whole list in one reply. Nothing may be
 * refused, cut or dropped for a number. The criteria live in the run folder's criteria.md.
 */
export const TASK = "go through every duty that runs on my chats, all of them, and give each one its own step on the board with what it " +
  "measures, its last number and whether it's doing its job. for each one that looks broken or useless ask me on for you what to do with it, " +
  "one question each, with every option you see. then send me the whole list in chat with the numbers, don't cut it short";

/** The caps that refused or cut before 10-18, with the number each one had. */
export const OLD_CAPS = { openAsks: 3, choices: 4, text: 500, note: 2000, links: 5, ops: 50, replyWords: 60, agents: 15 } as const;
const REFUSAL = /\b(refused|LimitRefused|blocked|at most \d+|up to \d+|too (long|many)|past (its|the) (cap|limit)|holds at most|already has \d+ open)\b/i;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 240): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

interface Result { file: string; at: number; tool: string; error: boolean; text: string }
interface Call { file: string; at: number; tool: string; args: Record<string, unknown> }
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")).join("\n") : "";

function readFile(file: string): { results: Result[]; calls: Call[] } {
  const results: Result[] = [];
  const calls: Call[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type !== "message") continue;
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
    if (message.role === "toolResult") results.push({ file, at, tool: String(message.toolName ?? ""), error: message.isError === true, text: textOf(message.content) });
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "toolCall") calls.push({ file, at, tool: String(block.name ?? ""), args: (block.arguments ?? {}) as Record<string, unknown> });
      }
    }
  }
  return { results, calls };
}

function boards(run: string): ChatBoard[] {
  const dir = join(run, "boards");
  return existsSync(dir) ? readdirSync(dir).sort().map(file => JSON.parse(readFileSync(join(dir, file), "utf8")) as ChatBoard) : [];
}
const steps = (board: ChatBoard): number => {
  let count = 0;
  const walk = (items: readonly { children: readonly unknown[] }[], depth: number): void => { for (const item of items) { if (depth > 0) count++; walk(item.children as never, depth + 1); } };
  walk(board.plan as never, 0);
  return count;
};

export const softCaps: Scenario = {
  name: "soft-caps",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const files = sessionFiles(chat);
  const read = files.map(readFile);
  const results = read.flatMap(file => file.results).filter(result => result.at >= state.windowStart);
  const calls = read.flatMap(file => file.calls).filter(call => call.at >= state.windowStart);
  const snaps = boards(run);
  const checks: Check[] = [];

  const refused = results.filter(result => REFUSAL.test(result.text) && (result.error || /^(refused|blocked)/i.test(result.text.trim())));
  checks.push({ id: "a", ok: results.length ? refused.length === 0 : null, detail: `${results.length} tool results in ${files.length} session files; ${refused.length} refused for a limit` +
    (refused.length ? `:\n${refused.slice(0, 10).map(result => `    - ${result.tool} at ${iso(result.at)} in ${result.file.split("/").at(-1)}: "${clip(result.text)}"`).join("\n")}` : "") });

  const crossed: string[] = [];
  const openAsks = Math.max(0, ...snaps.map(board => board.todos.filter(todo => !todo.done && todo.from === "agent").length));
  if (openAsks > OLD_CAPS.openAsks) crossed.push(`${openAsks} open asks on For you at once, past the old cap of ${OLD_CAPS.openAsks}`);
  const maxSteps = Math.max(0, ...snaps.map(steps));
  const choices = Math.max(0, ...snaps.flatMap(board => board.todos.map(todo => todo.choices?.length ?? 0)));
  if (choices > OLD_CAPS.choices) crossed.push(`a todo with ${choices} choices, past the old cap of ${OLD_CAPS.choices}`);
  const longText = Math.max(0, ...snaps.flatMap(board => { const out: number[] = []; const walk = (items: readonly { text: string; children: readonly unknown[] }[]): void => { for (const item of items) { out.push(item.text.length); walk(item.children as never); } }; walk(board.plan as never); out.push(...board.todos.map(todo => todo.text.length)); return out; }));
  if (longText > OLD_CAPS.text) crossed.push(`an item text of ${longText} characters, past the old cap of ${OLD_CAPS.text}`);
  const longNote = Math.max(0, ...snaps.flatMap(board => { const out: number[] = []; const walk = (items: readonly { note?: string; children: readonly unknown[] }[]): void => { for (const item of items) { out.push(item.note?.length ?? 0); walk(item.children as never); } }; walk(board.plan as never); return out; }));
  if (longNote > OLD_CAPS.note) crossed.push(`a step note of ${longNote} characters, past the old cap of ${OLD_CAPS.note}`);
  const links = Math.max(0, ...snaps.flatMap(board => board.todos.map(todo => todo.links?.length ?? 0)));
  if (links > OLD_CAPS.links) crossed.push(`a todo with ${links} links, past the old cap of ${OLD_CAPS.links}`);
  const ops = Math.max(0, ...calls.filter(call => call.tool === "chat_board").map(call => Array.isArray(call.args.ops) ? call.args.ops.length : 0));
  if (ops > OLD_CAPS.ops) crossed.push(`one chat_board call with ${ops} ops, past the old cap of ${OLD_CAPS.ops}`);
  const told = calls.filter(call => call.tool === "tell_owner" && call.file.endsWith(`${chat}.jsonl`)).map(call => String(call.args.text ?? ""));
  const longest = Math.max(0, ...told.map(words));
  if (longest > OLD_CAPS.replyWords) crossed.push(`a reply of ${longest} words, past the old ${OLD_CAPS.replyWords}-word fold`);
  const notes = results.filter(result => /\[soft cap\]|with a note \(c47\)|budget_overrun/i.test(result.text));
  if (notes.length) crossed.push(`${notes.length} tool results went through with a soft-cap note, such as "${clip(notes[0]!.text.match(/\[soft cap\][^\n]*/)?.[0] ?? notes[0]!.text, 160)}"`);
  checks.push({ id: "b", ok: crossed.length >= 2 ? true : results.length ? false : null, detail: `${crossed.length} old caps crossed: ${crossed.join("; ") || "none"}. The board peaked at ${maxSteps} steps.` });

  const duties = snaps.length ? steps(snaps.at(-1)!) : 0;
  checks.push({ id: "c", ok: told.length && duties >= 10 ? true : told.length ? false : null, detail: `${duties} steps on the last board, ${told.length} replies to the owner` +
    (told.length ? `, the longest ${longest} words: "${clip(told.reduce((a, b) => (words(b) > words(a) ? b : a)), 400)}"` : "") });

  const events = readSession(chat);
  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child" && !/^check-in /.test(event.from ?? ""));
  checks.push({ id: "d", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed.map(event => `typed at ${iso(event.at)}`), ...outside.map(event => `message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the owner-style message, server notes, the chat's check-ins and its own jobs reached the chat" });

  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${files.length} session files, ${snaps.length} board snapshots.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
