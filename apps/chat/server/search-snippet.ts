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

const NOT_ASCII = /[^\x00-\x7f]/;
/** A word without its accents, in lower case. An ASCII word has no accent to take off, which skips the normalize of nearly every word. */
const fold = (text: string): string => (NOT_ASCII.test(text) ? text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() : text.toLowerCase());

const WORD = /[\p{L}\p{N}]+/gu;

function wordHit(word: string, terms: readonly string[]): boolean {
  const folded = fold(word);
  for (const term of terms) if (folded.startsWith(term)) return true;
  return false;
}

/** Whether the text holds a word that starts with one of the terms, the way FTS5 reads a bare word. */
export function matches(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  const word = new RegExp(WORD);
  for (let m = word.exec(text); m; m = word.exec(text)) if (wordHit(m[0], terms)) return true;
  return false;
}

/**
 * pi-host's `snippetOf` for a text that holds a match, or nothing for one that holds none: `size` words around the first match, each
 * matching word in <mark>, with … where the text is cut. It reads the words only as far as the snippet's last one, where `snippetOf`
 * reads every word of the text and takes the accents off each. On 11-19 the 20 hits of `kimchi` on :5184 held 141,785 characters, and
 * their snippets took 23 ms of the search's 55 to 60 ms.
 */
function cutAround(text: string, terms: readonly string[], size: number): string | undefined {
  if (!terms.length) return undefined;
  const words: { at: number; end: number; hit: boolean }[] = [];
  const word = new RegExp(WORD);
  let first = -1;
  // The snippet starts a quarter of its size before the first match; one word past its end says whether the text goes on.
  let last = Infinity;
  let more = false;
  for (let m = word.exec(text); m; m = word.exec(text)) {
    const hit = wordHit(m[0], terms);
    if (hit && first < 0) {
      first = words.length;
      last = Math.max(0, first - Math.floor(size / 4)) + size;
    }
    if (words.length === last) {
      more = true;
      break;
    }
    words.push({ at: m.index, end: m.index + m[0].length, hit });
  }
  if (first < 0) return undefined;
  const from = Math.max(0, more ? first - Math.floor(size / 4) : Math.min(first - Math.floor(size / 4), words.length - size));
  const shown = words.slice(from, from + size);
  const start = from === 0 ? 0 : shown[0]!.at;
  const end = more ? shown.at(-1)!.end : text.length;
  let out = from === 0 ? "" : "…";
  let cursor = start;
  for (const w of shown) {
    if (!w.hit) continue;
    out += `${text.slice(cursor, w.at)}<mark>${text.slice(w.at, w.end)}</mark>`;
    cursor = w.end;
  }
  return `${out}${text.slice(cursor, end)}${end < text.length ? "…" : ""}`;
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
  const body = messageBody(kind, text);
  if (author === "owner" || author === SYSTEM_AUTHOR) {
    const input = systemInput(body);
    if (input) return { role: "system", label: input.label, text: body.slice(input.prefix) };
    return author === SYSTEM_AUTHOR ? { role: "system", label: "Note", text: body } : { role: "owner", text: body };
  }
  return { role: "agent", text: body };
}

/**
 * The author the search index gives an input the chat or Prime wrote as the owner's turn, such as a duty push or a check-in, so `from=owner`
 * finds only his own words. On 11-20 13 of the 21 hits of "does" from him were vent's duty pushes.
 */
export const SYSTEM_AUTHOR = "system";

/** An agent message's routing header, such as `[#pi-cutover · post 3 from Crawler VP]` or `[duty d1]`, says nothing the row does not. */
const messageBody = (kind: string, text: string): string => (kind === "agent.message" ? text.replace(/^\[(?:#|duty )[^\]\n]*\]\s*/, "") : text);

function systemInput(body: string): { label: string; prefix: number } | undefined {
  for (const [re, label] of SYSTEM_INPUTS) {
    const m = re.exec(body);
    if (m) return { label, prefix: m[0].length };
  }
  return undefined;
}

/** The author an entry is indexed under: pi-host's author column, except an owner's turn the chat or Prime wrote, which is `system`. */
export function indexedAuthor(kind: string, author: string, text: string): string {
  return author === "owner" && systemInput(messageBody(kind, text)) ? SYSTEM_AUTHOR : author;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Raw text with <mark> tags, escaped except for the tags. */
export function safeSnippet(raw: string): string {
  return raw.split(/(<mark>|<\/mark>)/).map(part => (part === "<mark>" || part === "</mark>" ? part : escapeHtml(part))).join("");
}

/** About 36 words around the first match, escaped, with every match in <mark>; empty when the text holds no match. */
export function snippet(text: string, terms: readonly string[], size = 36): string {
  const cut = cutAround(text, terms, size);
  return cut === undefined ? "" : safeSnippet(cut);
}

/** The longer text "Show more" opens: up to `max` characters from a little before the first match, escaped and marked. */
export function fullText(text: string, terms: readonly string[], max = 2000): string {
  let start = 0;
  if (text.length > max && terms.length) {
    const first = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})`, "iu").exec(text);
    start = first ? Math.max(0, Math.min(first.index - 300, text.length - max)) : 0;
  }
  const slice = text.slice(start, start + max);
  return (start > 0 ? "…" : "") + safeSnippet(cutAround(slice, terms, 1e9) ?? snippetOf(slice, terms, 1e9)) + (start + max < text.length ? "…" : "");
}
