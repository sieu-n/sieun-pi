/**
 * What a search hit shows: who said it (the owner, an agent, a tool's output or the system), the human text of the message, and a snippet
 * of it with every match in <mark>. pi-host indexes an answer as its text plus one `name {json}` line per tool call, a tool result as its raw
 * output, and Prime's notes with a `[tag]` header, so a hit on raw JSON read like `...original\":\"python-httpx\\/0.28.1\",\"vent.attempts\"`
 * on 2026-10-28. Here the text is split and cleaned before the snippet is cut.
 */
import { snippetOf, snippetTerms } from "../../../packages/pi-host/src/durable/index-db.ts";
import { SPEAKING_TOOLS } from "./timeline.ts";

export type HitRole = "owner" | "agent" | "tool" | "system";

export interface Described {
  role: HitRole;
  /** The tool whose call or output holds the match. */
  tool?: string;
  /** For a tool hit: the match sits in the call's arguments, not in its output. */
  inCall?: boolean;
  /** The name an envelope gives the sender, such as `vent release driver` in `[agent-message from vent release driver]`. */
  from?: string;
  /** A system note's label, such as Check-in or Job ended. */
  label?: string;
  /** The text to show, with headers and JSON punctuation gone. */
  text: string;
}

export { snippetTerms as searchTerms };

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether the text holds a word that starts with one of the terms, the way FTS5 reads a bare word. */
export function matches(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = fold(m[0]);
    if (terms.some(t => word.startsWith(t))) return true;
  }
  return false;
}

/** Tool output and call arguments as words: escapes undone, `"key": value` as `key: value`, and braces, brackets and quotes dropped. */
export function cleanTool(raw: string): string {
  let text = raw;
  for (let pass = 0; pass < 3 && /\\["\\/nrt]/.test(text); pass++) text = text.replace(/\\(["\\/]|[nrt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" || c === "r" ? " " : c));
  text = text.replace(/"([^"\n]{1,80})"\s*:\s*/g, "$1: ").replace(/[{}[\]"]+/g, " ").replace(/,(?=\S)/g, ", ");
  return text.split("\n").map(line => line.replace(/[ \t]+/g, " ").replace(/ ,/g, ",").replace(/(?:, ?){2,}/g, ", ").replace(/^[\s,]+|[\s,]+$/g, "")).filter(Boolean).join("\n");
}

const TOOL_CALL = /^([A-Za-z_][\w.-]*) (\{.*\})$/;

/** A speaking call's message text (tell_owner, send_message: timeline.ts SPEAKING_TOOLS) from its JSON arguments; "" when it has none. */
function sentText(json: string): string {
  try {
    const args = JSON.parse(json) as { text?: unknown };
    return typeof args.text === "string" ? args.text : "";
  } catch {
    return "";
  }
}

/** The string values of a tool call's arguments, longest last, so `bash {"command": "..."}` reads as its command. */
function callText(json: string): string {
  try {
    const values: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") values.push(value);
      else if (typeof value === "number" || typeof value === "boolean") values.push(String(value));
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(JSON.parse(json));
    return values.join("\n");
  } catch {
    return cleanTool(json);
  }
}

/** Inputs the chat or Prime writes into a thread as the owner's turn, by their `[tag]` header. */
const SYSTEM_INPUTS: readonly [RegExp, string][] = [
  [/^\[job\]\s*/, "Job report"],
  [/^\[check-in\]\s*/, "Check-in"],
  [/^\[board\]\s*/, "Board"],
  [/^\[duty [^\]]*\]\s*/, "Duty"],
  [/^\[d\d+ push[^\]]*\]\s*/, "Duty"],
  [/^\[(?:correction|brief) check\]\s*/, "Check"],
  [/^\[wake[^\]]*\]\s*/, "Wake"],
  [/^\[chat server\]\s*/, "Chat server"],
];

const titleCase = (tag: string): string => tag.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());

const WINDOW = 12_000;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A long text cut to about 12,000 characters around its first match, so a 1 MB tool output costs no more than a short one. */
export function around(text: string, terms: readonly string[]): string {
  if (text.length <= WINDOW || !terms.length) return text;
  const first = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "iu").exec(text);
  const start = Math.max(0, (first?.index ?? 0) - 2_000);
  return text.slice(start, start + WINDOW);
}

/** Who wrote an indexed entry and its human text. `author` is pi-host's author column: owner, an agent id, `tool:<name>` or a model. */
export function describe(kind: string, author: string, whole: string, terms: readonly string[]): Described {
  const text = around(whole, terms);
  if (kind === "pi.tool-result") return { role: "tool", tool: author.replace(/^tool:/, ""), text: cleanTool(text) };
  if (kind === "pi.assistant") {
    const human: string[] = [];
    const calls: { name: string; text: string }[] = [];
    const sent: string[] = [];
    for (const line of text.split("\n")) {
      const call = TOOL_CALL.exec(line);
      if (call && SPEAKING_TOOLS.has(call[1]!)) sent.push(sentText(call[2]!));
      else if (call) calls.push({ name: call[1]!, text: callText(call[2]!) });
      else human.push(line);
    }
    // What the agent sent is its message to people and reads first; its other text is its working notes.
    const said = [...sent, ...human].join("\n").trim();
    if (!calls.length || matches(said, terms)) return { role: "agent", text: said || calls.map(c => c.text).join("\n") };
    const call = calls.find(c => matches(c.text, terms)) ?? calls[0]!;
    return { role: "tool", tool: call.name, inCall: true, text: call.text };
  }
  if (kind === "pi.compaction") return { role: "system", label: "Summary", text };
  if (kind === "prime.custom") {
    const message = /^\[agent-message from ([^\]]+)\]\s*/.exec(text);
    if (message) return { role: "agent", from: message[1]!.replace(/^child:/, ""), text: text.slice(message[0].length) };
    const ended = /^\[child-(exited|failed)[^\]]*\]\s*/.exec(text);
    if (ended) return { role: "system", label: ended[1] === "failed" ? "Job failed" : "Job ended", text: text.slice(ended[0].length) || text };
    const tag = /^\[([a-z][a-z-]*)\]\s*/.exec(text);
    return { role: "system", label: tag ? titleCase(tag[1]!) : "Note", text: tag ? text.slice(tag[0].length) : text };
  }
  if (kind === "agent.message" && author === "board") return { role: "system", label: "Board", text: text.replace(/^\[board\]\s*/, "") };
  // An agent message's routing header, such as `[#pi-cutover · post 3 from Crawler VP]` or `[duty d1]`, says nothing the row does not.
  const body = kind === "agent.message" ? text.replace(/^\[(?:#|duty )[^\]\n]*\]\s*/, "") : text;
  if (author === "owner") {
    for (const [re, label] of SYSTEM_INPUTS) {
      const m = re.exec(body);
      if (m) return { role: "system", label, text: body.slice(m[0].length) };
    }
    return { role: "owner", text: body };
  }
  return { role: "agent", text: body };
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Raw text with <mark> tags, escaped except for the tags. */
export function safeSnippet(raw: string): string {
  return raw.split(/(<mark>|<\/mark>)/).map(part => (part === "<mark>" || part === "</mark>" ? part : escapeHtml(part))).join("");
}

/** About 36 words around the first match, escaped, with every match in <mark>; empty when the text holds no match. */
export function snippet(text: string, terms: readonly string[], size = 36): string {
  return matches(text, terms) ? safeSnippet(snippetOf(text, terms, size)) : "";
}

/** The longer text "Show more" opens: up to `max` characters from a little before the first match, escaped and marked. */
export function fullText(text: string, terms: readonly string[], max = 2000): string {
  let start = 0;
  if (text.length > max && terms.length) {
    const first = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "iu").exec(text);
    start = first ? Math.max(0, Math.min(first.index - 300, text.length - max)) : 0;
  }
  const slice = text.slice(start, start + max);
  return (start > 0 ? "…" : "") + safeSnippet(snippetOf(slice, terms, 1e9)) + (start + max < text.length ? "…" : "");
}
