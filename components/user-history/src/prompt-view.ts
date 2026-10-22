import { access, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildSessionContext, convertToLlm, loadProjectContextFiles, SessionManager, type SessionEntry } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BRIEF_CORRECTIONS, CHAT_BRIEF, JOB_REPLY_TOOL, PERSONA_TOOL, pinnedBrief } from "./chat-brief.ts";
import { CHAT_BOARD_TOOL, withMessageIds, withWakeNotes } from "./chat-guard.ts";
import { CORRECTION_TOOL } from "./chat-corrections.ts";
import { deliverCorrections } from "./correction-delivery.ts";
import { shortNotices } from "./prime-notices.ts";
import { type PromptCapture, readCapture } from "./prompt-capture.ts";
import { type BranchTail, readBranchTail, readContextTail } from "./session-tail.ts";
import { serverNote, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { DUTY_BRIEF, type PromptApi, type PromptOrigin, type PromptPart, type PromptPartKind, type PromptSubagent, type PromptView, type ToolRegistrar } from "./shared/prompt-view.ts";

/**
 * `GET api/threads/<id>/prompt`: the prompt a thread's model gets, split into labelled parts in payload order. With a capture (the user-history
 * extension writes each session's last provider payload, src/prompt-capture.ts) the parts are that payload; without one they are rebuilt from the
 * session file through the same code the context hook runs, and the parts Prime composes inside the worker are named as missing.
 */

const BRIEF: ReadonlySet<string> = new Set(CHAT_BRIEF.map(line => line.trim()));

/**
 * `keys` find the session entry a payload part came from, for its time: tool call ids and the opening of each text (`entryTimes`). `message` is
 * the index of the payload message that holds the part, so a block the context hook added to it takes its time.
 */
type Draft = { kind: PromptPartKind; label: string; source: string; role?: PromptPart["role"]; text: string; tokens?: number; keys?: readonly string[]; message?: number;
  call?: string; hook?: true; registeredBy?: ToolRegistrar; at?: string };
type Json = Record<string, unknown>;

/** No tokenizer ships with this package, so a part counts characters / 4; `measuredInputTokens` is the provider's own count of the last call. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
/** Anthropic bills an image by its pixels (about 1,600 tokens at the 1.15 MP it scales to); the payload holds only base64, so every image counts this. */
const IMAGE_TOKENS = 1600;

const record = (value: unknown): Json | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * The Prompt view of a duty's next run while none of its runs has a job yet: the one brief that run sends (`Duties.nextBrief`), rebuilt now
 * with the precheck's parts named, since the precheck runs only when the run starts.
 */
export function nextBriefView(chatId: string, dutyId: string, brief: { text: string; at: number }, title: string): PromptView {
  return { threadId: chatId, title, sessionFile: `next run of duty ${dutyId}, ${new Date(brief.at).toISOString()}`,
    origin: { kind: "rebuild", reason: "No run of this duty has started a job yet, so this is the brief its next run sends, built now by the same code. " +
      "The parts in <angle brackets> are filled by that run's precheck." },
    totalTokens: estimateTokens(brief.text),
    parts: [{ id: "brief", kind: "message", label: DUTY_BRIEF, source: "next run (rebuilt now)", role: "user", text: brief.text, tokens: estimateTokens(brief.text) }] };
}

/** `readCapture` reads the capture in place of `<dataDir>/prompts/<id>.json`, such as another box's capture of a session that runs there. */
export async function promptView(sessionId: string, options: { sessionFile: string; dataDir: string; chat: boolean; agentDir?: string; title?: string;
  readCapture?: () => Promise<PromptCapture | null> }): Promise<PromptView> {
  const [capture, context, subagents] = await Promise.all([options.readCapture ? options.readCapture() : readCapture(options.dataDir, sessionId),
    contextOf(options.sessionFile), subagentsOf(options.sessionFile, sessionId)]);
  const measured = lastInputTokens(context?.entries ?? []);
  let origin: PromptOrigin;
  let drafts: Draft[];
  let api: PromptApi | undefined;
  if (capture) {
    origin = { kind: "exact", capturedAt: capture.capturedAt, provider: capture.provider, model: capture.model };
    drafts = withTimes(payloadParts(capture.payload), context?.entries ?? []);
    api = payloadApi(capture.payload);
  } else {
    // The rebuild reads the newest 48 MiB, not only the context: the corrections checkpoints and the pinned brief may sit before it.
    const rebuilt = await rebuild(options.sessionFile, options.chat, options.agentDir ?? join(homedir(), ".prime", "agent"), await branchOf(options.sessionFile, REBUILD_BYTES));
    origin = { kind: "rebuild", reason: rebuilt.reason };
    drafts = rebuilt.parts;
    api = rebuilt.api;
  }
  const parts = drafts.map(toPart);
  return { threadId: sessionId, ...(options.title ? { title: options.title } : {}), sessionFile: options.sessionFile, origin, ...(api ? { api } : {}),
    totalTokens: parts.reduce((sum, part) => sum + part.tokens, 0), ...(measured !== undefined ? { measuredInputTokens: measured } : {}), ...(subagents.length ? { subagents } : {}), parts };
}

export const toPart = (draft: Draft, index: number): PromptPart => ({ id: `p${index}`, kind: draft.kind, label: draft.label, source: draft.source,
  ...(draft.role ? { role: draft.role } : {}), text: draft.text, tokens: draft.tokens ?? estimateTokens(draft.text), ...(draft.message !== undefined ? { message: draft.message } : {}),
  ...(draft.call ? { call: draft.call } : {}), ...(draft.hook ? { hook: true } : {}), ...(draft.registeredBy ? { registeredBy: draft.registeredBy } : {}), ...(draft.at ? { at: draft.at } : {}) });

/** The API a payload follows, by its shape. */
export function payloadApi(payload: unknown): PromptApi | undefined {
  const body = record(payload);
  if (!body) return undefined;
  if ("input" in body || "instructions" in body) return "openai-responses";
  if ("system" in body || list(body.tools).some(tool => record(tool)?.input_schema !== undefined)) return "anthropic-messages";
  if (list(body.messages).some(message => ["system", "developer", "tool"].includes(str(record(message)?.role))) || list(body.tools).some(tool => record(tool)?.type === "function")) return "openai-completions";
  return Array.isArray(body.messages) ? "anthropic-messages" : undefined;
}

/** pi-ai's `api` of an assistant reply, as a PromptApi. */
function apiOf(name: string): PromptApi | undefined {
  if (name.startsWith("anthropic")) return "anthropic-messages";
  if (name.includes("responses")) return "openai-responses";
  if (name.includes("completions")) return "openai-completions";
  return undefined;
}

/**
 * The tools the user-history extension registers (extension/index.ts, each `pi.registerTool` by these constants; a test reads that file to keep
 * the list true), and Prime's own (prime-agent core/tools).
 */
export const EXTENSION_TOOLS: ReadonlySet<string> = new Set([CHAT_BOARD_TOOL, TELL_OWNER_TOOL, CORRECTION_TOOL, JOB_REPLY_TOOL, PERSONA_TOOL]);
export const PRIME_TOOLS: ReadonlySet<string> = new Set(["ipython", "bash", "edit"]);
const registrar = (name: string): ToolRegistrar => EXTENSION_TOOLS.has(name) ? "user-history" : PRIME_TOOLS.has(name) ? "prime" : "other";

/**
 * The session file of any session the Prompt view opens: the daemon's listing (`listed`), else the file its capture names, else Prime's
 * `<agentDir>/sessions/<id>.jsonl`, else, for a subagent opened from its parent's view, its file in the parent's subagent folder. `via` is
 * the chain of parents, root first; the daemon stops listing a subagent once it ends, so an ended one is found through it. Null when none exists.
 */
export async function sessionFileFor(sessionId: string, options: { listed: (id: string) => Promise<string | undefined>; via?: readonly string[]; dataDir: string; agentDir: string }): Promise<string | null> {
  const exists = (file: string | undefined | null): Promise<boolean> => file ? access(file).then(() => true, () => false) : Promise.resolve(false);
  // Each place is read only when the one before it gave no file: a capture is the session's whole last request (0.3 to 1.9 MB on 10-19), and
  // the agent outbox asks for every send's file.
  const places = (id: string): (() => Promise<string | null | undefined>)[] => [() => options.listed(id),
    async () => (await readCapture(options.dataDir, id))?.sessionFile, async () => join(options.agentDir, "sessions", `${id}.jsonl`)];
  const find = async (id: string): Promise<string | null> => {
    for (const place of places(id)) { const file = await place(); if (await exists(file)) return file!; }
    return null;
  };
  let parent: { id: string; file: string } | null = null;
  for (const id of [...options.via ?? [], sessionId]) {
    let file = await find(id);
    if (!file && parent) {
      const child: string | undefined = (await spawned(parent.file, parent.id)).find(entry => entry.sessionId === id)?.sessionFile;
      if (child && await exists(child)) file = child;
    }
    parent = file ? { id, file } : null;
  }
  return parent?.file ?? null;
}

/**
 * The subagents a session spawned, oldest first: each `sub-*` folder with an rlm-subagent.json in its folder (a subagent's own folder, a root's
 * `session-artifacts/<id>`), the same folders `SpawnedCounts` counts in src/chat-catalog.ts.
 */
async function spawned(sessionFile: string, sessionId: string): Promise<(PromptSubagent & { sessionFile: string })[]> {
  const folder = basename(dirname(sessionFile)).startsWith("sub-") ? dirname(sessionFile) : join(dirname(dirname(sessionFile)), "session-artifacts", sessionId);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith("sub-")).map(async entry => {
    try {
      const value = record(JSON.parse(await readFile(join(folder, entry.name, "rlm-subagent.json"), "utf8")));
      const file = str(value?.sessionFile);
      return file ? [{ sessionId: basename(file, ".jsonl"), name: str(value?.sessionName) || entry.name, sessionFile: file }] : [];
    } catch { return []; }
  }));
  return found.flat().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export const subagentsOf = async (sessionFile: string, sessionId: string): Promise<PromptSubagent[]> =>
  (await spawned(sessionFile, sessionId)).map(({ sessionId: id, name }) => ({ sessionId: id, name }));

/** The opening of a text as a key: the same text in the payload and the session file shares it after the context hook appends or rewrites its end. */
const head = (text: string): string => "t:" + text.replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Each key of the messages in the session's current context (Prime's buildSessionContext, so nothing from before the last compaction) with the
 * times it occurs, oldest first: tool call ids, and the opening of each text, thinking and custom message.
 */
function entryTimes(entries: readonly SessionEntry[]): Map<string, string[]> {
  const times = new Map<string, string[]>();
  const add = (key: string, at: string) => { const list = times.get(key); if (list) list.push(at); else times.set(key, [at]); };
  const texts = (content: unknown): string[] => typeof content === "string" ? [content]
    : list(content).flatMap(block => { const value = record(block); return value ? [str(value.text) || str(value.thinking)].filter(Boolean) : []; });
  for (const agentMessage of buildSessionContext([...entries]).messages) {
    const message = agentMessage as unknown as Json;
    if (typeof message.timestamp !== "number") continue;
    const at = new Date(message.timestamp).toISOString();
    const ids = (id: string) => { add("id:" + id, at); if (id.includes("|")) add("id:" + id.split("|")[0], at); };
    if (message.role === "toolResult") { ids(str(message.toolCallId)); continue; }
    for (const block of list(message.content)) { const value = record(block); if (value?.type === "toolCall") ids(str(value.id)); }
    for (const text of texts(message.content)) add(head(text), at);
  }
  return times;
}

/**
 * Payload parts with the time of the session message each came from. A key's times are taken oldest first, so a repeated notice gets each of its
 * times in turn; parts of one assistant reply share one lookup. A block the context hook adds to a user message ([message id],
 * [corrections]) or an image has no entry of its own and takes the time of the nearest block of the same message, the one before it first.
 */
function withTimes(drafts: Draft[], entries: readonly SessionEntry[]): Draft[] {
  const times = entryTimes(entries);
  const found = new Map<readonly string[], string | undefined>();
  const timed = drafts.map(draft => {
    const keys = draft.keys;
    if (!keys) return draft;
    if (!found.has(keys)) found.set(keys, keys.map(key => times.get(key)).find(list => list?.length)?.shift());
    const at = found.get(keys);
    return at ? { ...draft, at } : draft;
  });
  const sibling = (index: number, step: number): string | undefined => {
    for (let at = index + step; timed[at] && timed[at]!.message === timed[index]!.message; at += step) if (timed[at]!.at) return timed[at]!.at;
    return undefined;
  };
  return timed.map((draft, index) => {
    if (draft.at || draft.message === undefined) return draft;
    const at = sibling(index, -1) ?? sibling(index, 1);
    return at ? { ...draft, at } : draft;
  });
}

/** The parts of one provider payload: Anthropic Messages (system, tools, messages) or OpenAI Responses (instructions, tools, input). */
export function payloadParts(payload: unknown, brief: ReadonlySet<string> = BRIEF): Draft[] {
  const body = record(payload) ?? {};
  const parts: Draft[] = [];
  if ("input" in body || "instructions" in body) {
    parts.push(...systemParts(str(body.instructions), brief));
    parts.push(...toolParts(body.tools));
    parts.push(...responsesInput(body.input, brief));
    return parts;
  }
  const system = typeof body.system === "string" ? [body.system] : list(body.system).map(block => str(record(block)?.text));
  system.forEach((text, index) => {
    if (system.length > 1 && index === 0 && text.length < 200) parts.push({ kind: "system", label: "Provider identity line", source: "pi-ai Anthropic provider (OAuth requests open with it)", text });
    else parts.push(...systemParts(text, brief));
  });
  const messages = list(body.messages);
  const systemMessages = messages.filter(message => ["system", "developer"].includes(str(record(message)?.role)));
  for (const message of systemMessages) parts.push(...systemParts(contentText(record(message)?.content), brief));
  parts.push(...toolParts(body.tools));
  const names = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    const value = record(message);
    if (!value || systemMessages.includes(message)) continue;
    const role = str(value.role);
    if (role === "assistant") parts.push(...assistantParts(value, names).map(part => ({ ...part, message: index })));
    else if (role === "tool") parts.push({ kind: "message", role: "toolResult", label: `Tool result: ${names.get(str(value.tool_call_id)) ?? "tool"}`, source: "tool output", text: contentText(value.content),
      keys: ["id:" + str(value.tool_call_id)], message: index, call: str(value.tool_call_id) });
    else parts.push(...userParts(value.content, names).map(part => ({ ...part, message: index })));
  }
  return parts;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content).map(block => { const value = record(block); return value ? str(value.text) || (str(value.type).includes("image") ? "[image]" : "") : ""; }).filter(Boolean).join("\n");
}

function toolParts(tools: unknown): Draft[] {
  return list(tools).flatMap(tool => {
    const value = record(tool);
    if (!value) return [];
    const fn = record(value.function) ?? value;
    const name = str(fn.name) || str(value.type);
    const schema = fn.input_schema ?? fn.parameters;
    const text = [str(fn.description), schema === undefined ? "" : JSON.stringify(schema, null, 2)].filter(Boolean).join("\n\n");
    return [{ kind: "tools" as const, label: `Tool: ${name}`, source: "tool definition (the provider sends tools before the system prompt)", text, registeredBy: registrar(name) }];
  });
}

const THINKING_SOURCE = "model reply (signed thinking; the provider counts it only in the current tool loop)";

/** One part per block of an assistant reply, in its order. Its parts share one `keys` array, so they share one time lookup (withTimes). */
function assistantParts(message: Json, names: Map<string, string>): Draft[] {
  const content = message.content;
  if (typeof content === "string") return [{ kind: "message", role: "assistant", label: "Assistant", source: "model reply", text: content, keys: [head(content)] }];
  const keys: string[] = [];
  const parts: Draft[] = [];
  const call = (id: string, name: string, input: unknown) => {
    names.set(id, name);
    keys.push("id:" + id);
    parts.push({ kind: "message", role: "assistant", label: `Assistant tool call: ${name}`, source: "model reply", text: toolCall(name, input), keys, call: id });
  };
  for (const block of list(content)) {
    const value = record(block);
    if (!value) continue;
    const type = str(value.type);
    if (type === "thinking") { parts.push({ kind: "message", role: "assistant", label: "Assistant thinking", source: THINKING_SOURCE, text: str(value.thinking), keys }); if (str(value.thinking)) keys.push(head(str(value.thinking))); }
    else if (type === "redacted_thinking") parts.push({ kind: "message", role: "assistant", label: "Assistant thinking", source: THINKING_SOURCE, text: "[redacted thinking]", keys });
    else if (type === "text") { parts.push({ kind: "message", role: "assistant", label: "Assistant", source: "model reply", text: str(value.text), keys }); if (str(value.text)) keys.push(head(str(value.text))); }
    else if (type === "tool_use") call(str(value.id), str(value.name), value.input);
  }
  for (const item of list(message.tool_calls)) {
    const value = record(item); const fn = record(value?.function);
    if (value && fn) call(str(value.id), str(fn.name), parseArguments(fn.arguments));
  }
  return parts;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function toolCall(name: string, input: unknown): string {
  const args = record(input);
  if (args && typeof args.code === "string" && Object.keys(args).length === 1) return `→ ${name}\n${args.code}`;
  return `→ ${name} ${JSON.stringify(input, null, 2)}`;
}

function userParts(content: unknown, names: Map<string, string>): Draft[] {
  if (typeof content === "string") return [userText(content)];
  const parts: Draft[] = [];
  for (const block of list(content)) {
    const value = record(block);
    if (!value) continue;
    const type = str(value.type);
    if (type === "text") parts.push(...splitDigest(str(value.text)).map(text => userText(text)));
    else if (type === "image") parts.push(IMAGE);
    else if (type === "tool_result") {
      const inner = typeof value.content === "string" ? [{ type: "text", text: value.content }] : list(value.content);
      const images = inner.filter(item => str(record(item)?.type) === "image").length;
      const id = str(value.tool_use_id);
      parts.push({ kind: "message", role: "toolResult", label: `Tool result: ${names.get(id) ?? "tool"}${value.is_error === true ? " (error)" : ""}`,
        source: "tool output", text: contentText(inner), keys: ["id:" + id], call: id, ...(images ? { tokens: estimateTokens(contentText(inner)) + images * IMAGE_TOKENS } : {}) });
    }
  }
  return parts;
}

function responsesInput(input: unknown, brief: ReadonlySet<string>): Draft[] {
  if (typeof input === "string") return [{ ...userText(input), message: 0 }];
  const names = new Map<string, string>();
  const parts: Draft[] = [];
  for (const [index, item] of list(input).entries()) {
    const value = record(item);
    if (!value) continue;
    const type = str(value.type) || "message";
    const role = str(value.role);
    const id = str(value.call_id);
    const add = (...drafts: Draft[]) => parts.push(...drafts.map(draft => ({ ...draft, message: index })));
    if (type === "message" && (role === "system" || role === "developer")) parts.push(...systemParts(contentText(value.content), brief));
    else if (type === "message" && role === "assistant") add({ kind: "message", role: "assistant", label: "Assistant", source: "model reply", text: contentText(value.content), keys: [head(contentText(value.content))] });
    else if (type === "message") add(...messageParts(value.content));
    else if (type === "function_call") { names.set(id, str(value.name)); add({ kind: "message", role: "assistant", label: `Assistant tool call: ${str(value.name)}`, source: "model reply", text: toolCall(str(value.name), parseArguments(value.arguments)), keys: ["id:" + id], call: id }); }
    else if (type === "function_call_output") add({ kind: "message", role: "toolResult", label: `Tool result: ${names.get(id) ?? "tool"}`, source: "tool output", text: contentText(value.output), keys: ["id:" + id], call: id });
    else if (type === "reasoning") add({ kind: "message", role: "assistant", label: "Assistant thinking", source: "model reply (reasoning summary; the encrypted part is not shown)", text: list(value.summary).map(entry => str(record(entry)?.text)).join("\n\n") || "[encrypted reasoning]" });
  }
  return parts;
}

/** The blocks of an OpenAI Responses user message: each text (`input_text`) and image (`input_image`) in order. */
function messageParts(content: unknown): Draft[] {
  if (typeof content === "string") return splitDigest(content).map(text => userText(text));
  return list(content).flatMap(block => {
    const value = record(block);
    if (!value) return [];
    if (str(value.type).includes("image")) return [IMAGE];
    return str(value.text) ? splitDigest(str(value.text)).map(text => userText(text)) : [];
  });
}

const IMAGE: Draft = { kind: "message", role: "user", label: "Image", source: "image in a user message", text: "[image]", tokens: IMAGE_TOKENS };

function splitDigest(text: string): string[] {
  const cut = text.startsWith("[harness-digest]") ? text.indexOf("\n\n[compaction-summary]") : -1;
  return cut < 0 ? [text] : [text.slice(0, cut), text.slice(cut + 2)];
}


type Source = { kind: PromptPartKind; label: string; source: string };
const SERVER = "chat server (sent as a user message)";
const HOOK = "user-history context hook (added on every call, not in the session file)";
const PRIME = "Prime (custom message)";
const PREFIXES: readonly [RegExp, (match: RegExpExecArray) => Source][] = [
  [/^\[harness-digest\]/, () => ({ kind: "harness", label: "Harness digest", source: "Prime harness: memories, prompt notes, skills and subagent specs" })],
  [/^\[harness-digest update\]/, () => ({ kind: "harness", label: "Harness digest update", source: "Prime harness: the entries that changed since the digest" })],
  [/^# [^\n]+: the (?:check-in|[^\n]+ duty) of the chat "/, () => ({ kind: "message", label: DUTY_BRIEF, source: "chat server duty run: dutyJobBrief (chat-duty-job.ts)" })],
  [/^\[compaction-summary\]/, () => ({ kind: "message", label: "Compaction summary", source: "Prime compaction" })],
  [/^\[branch-summary\]/, () => ({ kind: "message", label: "Branch summary", source: "Prime" })],
  [/^\[corrections\]/, () => ({ kind: "instructions", label: "[corrections]", source: `${HOOK}: the owner's corrections ledger` })],
  [/^\[message id: /, () => ({ kind: "instructions", label: "[message id]", source: `${HOOK}: the owner message's id for tell_owner reply_to` })],
  [/^\[not from the owner: /, () => ({ kind: "instructions", label: "[wake note]", source: `${HOOK}: the line after each wake-up in a chat (WAKE_NOTE)` })],
  [/^\[An image (of [0-9]+ x [0-9]+ px )?was left out of this request/, () => ({ kind: "message", label: "Image left out", source: `${HOOK}: an image it could not shrink` })],
  [/^\[reply check\]/, () => ({ kind: "message", label: "[reply check]", source: SERVER })],
  [/^\[brief check\]/, () => ({ kind: "message", label: "[brief check]", source: SERVER })],
  [/^\[check-in\]/, () => ({ kind: "message", label: "[check-in]", source: SERVER })],
  [/^\[job\]/, () => ({ kind: "message", label: "[job] notice", source: SERVER })],
  [/^\[brief\]/, () => ({ kind: "message", label: "[brief] change", source: SERVER })],
  [/^\[board\] (Ops not applied|Decisions not on the scratchpad)/, () => ({ kind: "message", label: "[board] server note", source: SERVER })],
  [/^\[board\]/, () => ({ kind: "message", label: "[board] owner action", source: "the owner, through the board (sent as a user message)" })],
  [/^\[(wake|duty|alert[a-z-]*)\]/, match => ({ kind: "message", label: `[${match[1]}]`, source: SERVER })],
  [/^\[from ([^\]]+)\]/, match => ({ kind: "message", label: `Nudge for ${match[1]}`, source: SERVER })],
  [/^\[agent-message from ([^\]]+)\]/, match => ({ kind: "message", label: `Agent message from ${match[1]}`, source: "agent_message (another session)" })],
  [/^\[(task|message) from (parent|[^\]]+)\]/, match => ({ kind: "message", label: `Agent message: ${match[1]} from ${match[2]}`, source: "agent_message (another session)" })],
  [/^\[child-(exited|failed)[^\]]*\]/, match => ({ kind: "message", label: `Child ${match[1]}`, source: PRIME })],
  [/^\[[a-z]+-refinement\]/, () => ({ kind: "harness", label: "Refinement notice", source: PRIME })],
  [/^\[python-state(-restored)?\]/, () => ({ kind: "message", label: "Kernel state notice", source: PRIME })],
  [/^\[bash-done[^\]]*\]/, () => ({ kind: "message", label: "bash() finished", source: PRIME })],
  [/^<prime_agent_([a-z_]+)>/, match => ({ kind: "message", label: `Prime notice: ${match[1]!.replaceAll("_", " ")}`, source: PRIME })],
  [/^<skill name="([^"]+)"/, match => ({ kind: "message", label: `Skill: ${match[1]}`, source: "the owner, through a /skill command" })],
];

export function userSource(text: string): Source {
  const trimmed = text.trimStart();
  for (const [pattern, make] of PREFIXES) { const match = pattern.exec(trimmed); if (match) return make(match); }
  const note = serverNote(trimmed);
  if (note) return { kind: "message", label: note, source: SERVER };
  return { kind: "message", label: "Owner", source: "the owner (or the parent's task text)" };
}

/** True for a block the user-history context hook adds on every call, by its source (userSource). */
export const hookAdded = (source: string): boolean => source.startsWith(HOOK);

function userText(text: string): Draft {
  const source = userSource(text);
  return { ...source, role: "user", text, keys: [head(text)], ...(hookAdded(source.source) ? { hook: true as const } : {}) };
}


/**
 * The system prompt cut at the headings Prime's buildSystemPrompt writes (prime-agent dist/core/system-prompt.js), in its order: the RLM base
 * prompt, `# Delegating to sub-agents`, `# Generic MCP Connections`, `# Additional Guidance` (each active tool's promptGuidelines: the chat
 * brief, the job report line), `# Project Context` (one `## <path>` per AGENTS.md), the skills list, then any appended text.
 */
export function systemParts(text: string, brief: ReadonlySet<string> = BRIEF): Draft[] {
  if (!text) return [];
  const marks: { at: number; name: string }[] = [];
  let from = 0;
  for (const [name, pattern] of SYSTEM_MARKS) {
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    if (!match) continue;
    const at = match.index + (match[0].startsWith("\n") ? match[0].length - match[0].trimStart().length : 0);
    marks.push({ at, name });
    from = at + 1;
  }
  const end = text.indexOf("</available_skills>");
  if (end >= 0) { const after = end + "</available_skills>".length; if (text.slice(after).trim()) marks.push({ at: after, name: "appended" }); }
  marks.sort((a, b) => a.at - b.at);
  const parts: Draft[] = [];
  const head = text.slice(0, marks[0]?.at ?? text.length);
  if (head.trim()) parts.push({ kind: "system", label: "Base system prompt", source: "Prime buildRlmPrompt (the RLM runtime prompt)", text: head });
  marks.forEach((mark, index) => {
    const body = text.slice(mark.at, marks[index + 1]?.at ?? text.length);
    if (mark.name === "guidance") parts.push(...guidanceParts(body, brief));
    else if (mark.name === "context") parts.push(...contextParts(body));
    else parts.push({ ...SYSTEM_LABELS[mark.name]!, text: body });
  });
  return parts;
}

const SYSTEM_MARKS: readonly [string, RegExp][] = [
  ["delegation", /^# Delegating to sub-agents$/gm],
  ["mcp", /^# Generic MCP Connections$/gm],
  ["guidance", /^# Additional Guidance$/gm],
  ["context", /^# Project Context$/gm],
  ["skills", /\n\nThe following skills provide specialized instructions for specific tasks\./g],
  ["harness", /^# Continual Harness State$/gm],
];
const SYSTEM_LABELS: Record<string, Source> = {
  delegation: { kind: "system", label: "Subagent guidance", source: "Prime buildSubagentGuidance" },
  mcp: { kind: "system", label: "MCP connections", source: "Prime: enabled MCP servers" },
  skills: { kind: "skills", label: "Skills list", source: "Prime formatSkillsForPrompt: installed skills with descriptions" },
  harness: { kind: "harness", label: "Harness state", source: "Prime harness" },
  appended: { kind: "instructions", label: "Appended instructions", source: "appendSystemPrompt or a before_agent_start hook (the user-history job line)" },
};

/**
 * `# Additional Guidance` bullets in runs: the job lines, and the rest. In a chat the rest is the chat brief (the chat_board tool carries it and
 * no other active tool has guidelines), so a brief pinned before an edit of CHAT_BRIEF still reads as the brief.
 */
function guidanceParts(body: string, brief: ReadonlySet<string>): Draft[] {
  const lines = body.split("\n");
  const first = lines.findIndex(line => line.startsWith("- "));
  if (first < 0) return [{ kind: "instructions", label: "Tool guidelines", source: "promptGuidelines of the active tools", text: body }];
  const title = lines.slice(0, first).join("\n");
  const bullets: string[] = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith("- ")) bullets.push(line);
    else bullets[bullets.length - 1] += "\n" + line;
  }
  const text = (bullet: string) => bullet.replace(/^- /, "").trim();
  const chat = bullets.some(bullet => brief.has(text(bullet)));
  const group = (bullet: string): string => {
    const line = text(bullet);
    if (line.startsWith("You are a job of the chat") || line.startsWith("Work in poteto-mode:")) return "job";
    return chat ? "brief" : "tools";
  };
  const runs: { group: string; lines: string[] }[] = [];
  for (const bullet of bullets) {
    const name = text(bullet) ? group(bullet) : runs.at(-1)?.group ?? "tools";
    const last = runs.at(-1);
    if (last?.group === name) last.lines.push(bullet);
    else runs.push({ group: name, lines: [bullet] });
  }
  const labels: Record<string, Source> = {
    brief: { kind: "instructions", label: "Chat brief", source: "chat_board tool promptGuidelines (src/chat-brief.ts CHAT_BRIEF, as pinned at the chat's start or last compaction)" },
    job: { kind: "instructions", label: "Job report line", source: "job_reply tool promptGuidelines (src/chat-brief.ts)" },
    tools: { kind: "instructions", label: "Tool guidelines", source: "promptGuidelines of the active tools" },
  };
  return runs.map((run, index) => ({ ...labels[run.group]!, text: (index === 0 ? title + "\n" : "") + run.lines.join("\n") }));
}

/** `# Project Context`, one part per `## <absolute path>` file. */
function contextParts(body: string): Draft[] {
  const files = [...body.matchAll(/^## ((?:\/|[A-Za-z]:\\|~)[^\n]*)$/gm)];
  if (!files.length) return [{ kind: "instructions", label: "Project context", source: "Prime: AGENTS.md files", text: body }];
  const parts: Draft[] = [];
  const intro = body.slice(0, files[0]!.index);
  files.forEach((file, index) => {
    const text = (index === 0 ? intro : "") + body.slice(file.index, files[index + 1]?.index ?? body.length);
    parts.push({ kind: "instructions", label: file[1]!.replace(homedir(), "~"), source: "Prime: project context file (AGENTS.md)", text });
  });
  return parts;
}


async function branchOf(sessionFile: string, bytes: number): Promise<BranchTail | undefined> {
  try { return await readBranchTail(sessionFile, { messages: 1_000_000, bytes }); } catch { return undefined; }
}

/** The entries of the model's current context, for the times of a capture's parts and the measured input: the context alone, not 48 MiB. */
async function contextOf(sessionFile: string): Promise<BranchTail | undefined> {
  try { return await readContextTail(sessionFile, REBUILD_BYTES); } catch { return undefined; }
}

/** input + cacheRead + cacheWrite of the newest assistant reply that reached the provider. */
export function lastInputTokens(branch: readonly SessionEntry[]): number | undefined {
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    const total = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    if (total > 0) return total;
  }
  return undefined;
}

/** The newest 48 MiB of the branch: the context since the last compaction and the times of its messages. On the AI harness chat's 148 MB file it read 7,308 entries back through 13 compactions in 233 ms (10-15). */
const REBUILD_BYTES = 48 * 1024 * 1024;

async function sessionCwd(sessionFile: string): Promise<string> {
  const handle = await open(sessionFile, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const line = head.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
    return typeof cwd === "string" ? cwd : homedir();
  } catch { return homedir(); } finally { await handle.close(); }
}

/**
 * The prompt rebuilt from the session file: the messages of the current context (Prime's buildSessionContext and convertToLlm) after the same
 * steps the user-history context hook runs (shortNotices, the chat's owner message ids, deliverCorrections from the checkpoints in the file), the
 * AGENTS.md files through Prime's loadProjectContextFiles, and a chat's pinned brief.
 */
export async function rebuild(sessionFile: string, chat: boolean, agentDir: string, read?: BranchTail): Promise<{ reason: string; parts: Draft[]; api?: PromptApi }> {
  const tail = read ?? await readBranchTail(sessionFile, { messages: 1_000_000, bytes: REBUILD_BYTES });
  const entries = tail?.entries ?? SessionManager.open(sessionFile).getBranch();
  const context = buildSessionContext(entries);
  let messages: AgentMessage[] = shortNotices(context.messages) ?? context.messages;
  if (chat) messages = withMessageIds(messages) ?? messages;
  if (chat) messages = withWakeNotes(messages) ?? messages;
  messages = deliverCorrections({ messages, branch: entries, ledger: null, job: false, brief: BRIEF_CORRECTIONS, append: () => {} });
  const parts: Draft[] = [];
  try {
    const files = loadProjectContextFiles({ cwd: await sessionCwd(sessionFile), agentDir });
    if (files.length) parts.push(...contextParts("# Project Context\n\nProject-specific instructions and guidelines:\n\n" + files.map(file => `## ${file.path}\n\n${file.content}\n\n`).join("")));
  } catch { /* no context files */ }
  if (chat) {
    const brief = pinnedBrief(entries) ?? [...CHAT_BRIEF];
    parts.push({ kind: "instructions", label: "Chat brief", source: "chat_board tool promptGuidelines (pinned brief from the session file)", text: brief.map(line => `- ${line}`).join("\n") });
  }
  const names = new Map<string, string>();
  let api: PromptApi | undefined;
  let index = 0;
  for (const message of messages) {
    const at = "timestamp" in message && typeof message.timestamp === "number" ? { at: new Date(message.timestamp).toISOString() } : {};
    const start = parts.length;
    for (const llm of convertToLlm([message])) {
      const from = parts.length;
      if (llm.role === "assistant") {
        api = apiOf(llm.api) ?? api;
        parts.push(...assistantParts({ content: llm.content.map(block => block.type === "toolCall" ? { type: "tool_use", id: block.id, name: block.name, input: block.arguments } : block) }, names));
      } else if (llm.role === "toolResult") {
        parts.push({ kind: "message", role: "toolResult", label: `Tool result: ${llm.toolName}${llm.isError ? " (error)" : ""}`, source: "tool output", call: llm.toolCallId,
          text: llm.content.map(block => block.type === "text" ? block.text : "[image]").join("\n"),
          tokens: llm.content.reduce((sum, block) => sum + (block.type === "text" ? estimateTokens(block.text) : IMAGE_TOKENS), 0) });
      } else {
        const content = typeof llm.content === "string" ? [{ type: "text" as const, text: llm.content }] : llm.content;
        for (const block of content) {
          if (block.type !== "text") { parts.push(IMAGE); continue; }
          for (const text of splitDigest(block.text)) {
            const custom = message.role === "custom" ? message.customType : undefined;
            const part = userText(text);
            parts.push(custom && part.label === "Owner" ? { ...part, label: `Custom message: ${custom}`, source: PRIME } : part);
          }
        }
      }
      for (let at = from; at < parts.length; at++) parts[at] = { ...parts[at]!, message: index };
      index++;
    }
    for (let index = start; index < parts.length; index++) parts[index] = { ...parts[index]!, ...at };
  }
  const missing = "the base system prompt, the MCP and tool guideline sections, the skills list and the tool definitions";
  const reason = `No captured payload for this session yet: it records from its first model call after its worker loads the current user-history extension. ` +
    `Rebuilt from the session file${tail && !tail.whole ? " (its newest 48 MiB)" : ""}; missing: ${missing}, and images the context hook resizes.`;
  return { reason, parts, ...(api ? { api } : {}) };
}
