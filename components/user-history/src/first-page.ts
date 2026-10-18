import { statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { formatCursor, messageKey } from "./shared/message-key.ts";
import type { ChildAgent, ImagePart, OlderPage, TextPart, ThreadEvent, ThreadMessage } from "./shared/types.ts";

/**
 * The JSON bytes of a new feed's first snapshot. The owner's Mac in Korea is 186 ms from this box (10-18), and a fresh connection sends about
 * 14 KB in its first round trip. The newest 100 messages were 61 to 76 KB of JSON and 19 to 25 KB deflated in the 6 chats of the 10-18
 * baseline, more than one round trip; 36 KB of stubbed messages deflated to about 11 KB there.
 */
export const FIRST_PAGE_BYTES = 36 * 1024;
/** A collapsed work row shows 140 characters of a tool call's arguments (WorkRow.svelte `summary`), so the first page keeps that much. */
export const PREVIEW_CHARS = 140;
/** A collapsed work row shows the first line of a job's message; the first page keeps 300 characters of it. */
export const NOTE_PREVIEW_CHARS = 300;

/**
 * A job's `label` is the whole task brief it was given, and the page reads only its first line (client/children.ts `childName`) and searches it
 * (SubagentList.svelte). On 10-18 the labels were 56 KB of the 62 KB children frame of chat 01a14d31, and the page got that frame twice on each
 * load from Korea, inline in the shell and again on the socket. The feed sends the first `LABEL_CHARS` of each with `labelMore`, and
 * `childLabels` answers `GET api/threads/<id>/child-labels` with the whole ones.
 */
export const LABEL_CHARS = 300;
const clipChild = (child: ChildAgent): ChildAgent => child.label.length > LABEL_CHARS ? { ...child, label: child.label.slice(0, LABEL_CHARS), labelMore: true } : child;
/** The whole label of each job whose label the feed cut, by job id. */
export function childLabels(children: readonly ChildAgent[]): Record<string, string> {
  return Object.fromEntries(children.filter(child => child.label.length > LABEL_CHARS).map(child => [child.id, child.label]));
}
const sentEvents = new WeakMap<ThreadEvent, ThreadEvent>();
/** A thread event as the feed and the shell send it: job labels cut to `LABEL_CHARS`, once per event however many pages get it. */
export function wireEvent(event: ThreadEvent): ThreadEvent {
  const children = event.type === "children" ? event.children : event.type === "snapshot" ? event.snapshot.children : undefined;
  if (!children?.some(child => child.label.length > LABEL_CHARS)) return event;
  let sent = sentEvents.get(event);
  if (!sent) {
    sent = event.type === "children" ? { ...event, children: event.children.map(clipChild) }
      : event.type === "snapshot" ? { ...event, snapshot: { ...event.snapshot, children: children.map(clipChild) } } : event;
    sentEvents.set(event, sent);
  }
  return sent;
}

function cut(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

function cutParts(content: string | (TextPart | ImagePart)[], limit: number): string | (TextPart | ImagePart)[] {
  if (typeof content === "string") { const clipped = cut(content, limit); return clipped.truncated ? [{ type: "text", text: clipped.text, truncated: true }] : content; }
  return content.map(part => { if (part.type !== "text") return part; const clipped = cut(part.text, limit); return clipped.truncated ? { type: "text", text: clipped.text, truncated: true } : part; });
}

/**
 * The message as the first page sends it: what a collapsed feed shows stays whole (the owner's and the agent's text, a tell_owner text, images),
 * and what shows only when he opens a work row is cut to its preview with `truncated` set, which the page already fetches in full on open
 * (`api.toolOutput`, `api.part`). The full snapshot right after the first page replaces these. A message with nothing to cut comes back as is.
 */
export function previewMessage(message: ThreadMessage): ThreadMessage {
  const preview = cutMessage(message);
  return JSON.stringify(preview).length === JSON.stringify(message).length ? message : preview;
}

function cutMessage(message: ThreadMessage): ThreadMessage {
  switch (message.role) {
    case "toolResult": return { ...message, content: message.content.map(part => part.type === "text" && part.text ? { type: "text", text: "", truncated: true } : part) };
    case "assistant": return { ...message, content: message.content.map(part => {
      if (part.type === "thinking") { const clipped = cut(part.thinking, PREVIEW_CHARS); return clipped.truncated ? { ...part, thinking: clipped.text, truncated: true } : part; }
      if (part.type !== "toolCall" || part.name === TELL_OWNER_TOOL) return part;
      let truncated = false;
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(part.arguments)) {
        const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
        if (text.length > PREVIEW_CHARS) { args[key] = text.slice(0, PREVIEW_CHARS); truncated = true; } else args[key] = value;
      }
      return truncated ? { ...part, arguments: args, truncated: true } : part;
    }) };
    case "custom": return { ...message, content: cutParts(message.content, NOTE_PREVIEW_CHARS) };
    case "bashExecution": return message.output ? { ...message, output: "", truncated: true } : message;
    case "branchSummary": case "compactionSummary": return { ...message, summary: cut(message.summary, PREVIEW_CHARS).text };
    default: return message;
  }
}

/**
 * A new feed's first page: the newest messages of `messages`, cut to previews (`previewMessage`), that fit `bytes` of JSON, at least the
 * newest one. It never reaches before `floor` (the start of the full page that follows it) and never splits messages that share a timestamp, so
 * message keys hold (src/shared/message-key.ts). `older` is the cursor before the page: a message cursor inside `messages`, else `start`.
 */
export function firstPage(messages: readonly ThreadMessage[], start: string | undefined, floor = 0, bytes = FIRST_PAGE_BYTES): OlderPage {
  const shown: ThreadMessage[] = [];
  let used = 0;
  let first = messages.length;
  while (first > floor) {
    const preview = previewMessage(messages[first - 1]!);
    const size = JSON.stringify(preview).length + 1;
    const run = first < messages.length && messages[first - 1]!.timestamp === messages[first]!.timestamp;
    if (shown.length && !run && used + size > bytes) break;
    shown.push(preview);
    used += size;
    first--;
  }
  const older = first > 0 ? formatCursor({ kind: "message", key: messageKey(messages, first) }) : start;
  return { messages: shown.reverse(), ...(older ? { older } : {}) };
}

/** The frames as the shell's JSON block holds them: `<` as \u003c keeps a message that holds "</script>" inside the block. */
export const inlineJson = (frames: readonly ThreadEvent[]): string => JSON.stringify(frames).replaceAll("<", "\\u003c");

const fileId = /^[\w-]{1,80}$/;
/** A held first page and the size of the session file it was made from; `size` is null when the thread had no file yet. */
type Held = { text: string; file: string | null; size: number | null };
const fileSize = (file: string | null): number | null => { if (!file) return null; try { return statSync(file).size; } catch { return null; } };

/**
 * Each thread's first frame as the page shell inlines it (`inlineJson`), held in memory and written to `dir/<id>.json` a moment after it
 * changes, so a shell answers from what was made when the thread's last turn ended, with no catalog or session file read on the request.
 * After a service start the file still has it: on 10-18 the chat restarted 21 times by 08:40Z, and a shell right after a restart waited up to
 * 6.5 s for the client bundle and the catalog before it sent a byte. A page whose session file grew since is stale and never served.
 */
export class FirstPages {
  private readonly held = new Map<string, Held>();
  private readonly writes = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly dir: string | null, private readonly writeDelayMs = 1000) {}

  /** The held page, else the file's, while its session file still has the size it had; undefined otherwise. */
  async get(id: string): Promise<string | undefined> {
    let held = this.held.get(id);
    if (held === undefined && this.dir && fileId.test(id)) {
      try {
        const raw = await readFile(join(this.dir, `${id}.json`), "utf8");
        const newline = raw.indexOf("\n");
        const head = JSON.parse(raw.slice(0, newline)) as { file: string | null; size: number | null };
        held = this.held.get(id) ?? { text: raw.slice(newline + 1), file: head.file, size: head.size };
        this.held.set(id, held);
      } catch { return undefined; }
    }
    if (!held?.file || held.size === null) return undefined;
    const size = await stat(held.file).then(found => found.size, () => null);
    return size === held.size ? held.text : undefined;
  }

  /** Holds the frames' text made from `file` and returns it; a changed text is written to the file `writeDelayMs` later, once per burst. */
  put(id: string, frames: readonly ThreadEvent[], file: string | null = null): string {
    const text = inlineJson(frames);
    const size = fileSize(file);
    const before = this.held.get(id);
    if (before && before.text === text && before.file === file && before.size === size) return text;
    this.held.set(id, { text, file, size });
    if (this.dir && fileId.test(id) && !this.writes.has(id)) {
      const timer = setTimeout(() => { this.writes.delete(id); void this.write(id); }, this.writeDelayMs);
      timer.unref();
      this.writes.set(id, timer);
    }
    return text;
  }

  /** Writes every change still waiting for its timer. */
  async flush(): Promise<void> {
    const ids = [...this.writes.keys()];
    for (const id of ids) clearTimeout(this.writes.get(id));
    this.writes.clear();
    await Promise.all(ids.map(id => this.write(id)));
  }

  private async write(id: string): Promise<void> {
    const held = this.held.get(id);
    if (held === undefined || !this.dir) return;
    const path = join(this.dir, `${id}.json`), draft = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(draft, JSON.stringify({ file: held.file, size: held.size }) + "\n" + held.text, { mode: 0o600 });
      await rename(draft, path);
    } catch (error) { process.stderr.write(`first page ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
}
