/**
 * Imports a Prime or Pi session file (JSONL) as a new durable thread, so an old thread continues on pi-host with its
 * history visible, searchable and in the model's context.
 *
 * The importer follows the session's active branch from its last entry back to the header, and writes each message as
 * the entry pi-durable would have written: user, assistant and tool-result messages as `pi.user`, `pi.assistant` and
 * `pi.tool-result`, a compaction as `pi.compaction` whose head is the first kept entry, and Prime's custom messages
 * (agent messages, heartbeats, task briefs) as `prime.custom` entries the model reads as user text.
 */
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EntryDraft, EntryId, ModelRef } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";

const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

interface Line {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface ParsedSession {
  id?: string;
  cwd?: string;
  name?: string;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  /** One draft per active-branch line that carries content, in order, with the session line id it came from. */
  drafts: { from: string; draft: EntryDraft; headFrom?: string }[];
  skipped: Record<string, number>;
}

const at = (line: Line): number => (line.timestamp ? Date.parse(line.timestamp) : Date.now());

function userText(content: unknown, when: number): Message {
  return { role: "user", content: typeof content === "string" ? content : (content as Message["content"]) as never, timestamp: when } as Message;
}

/** The active branch of a session file, as entry drafts. */
export function parseSession(path: string): ParsedSession {
  const lines: Line[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw) as Line); } catch { /* a torn last line from a crash */ }
  }
  const header = lines.find(line => line.type === "session");
  const byId = new Map(lines.filter(line => line.id && line.type !== "session").map(line => [line.id!, line]));
  const branch: Line[] = [];
  const leaf = [...lines].reverse().find(line => line.id && line.type !== "session");
  for (let line = leaf; line; line = line.parentId ? byId.get(line.parentId) : undefined) branch.push(line);
  branch.reverse();

  const parsed: ParsedSession = { drafts: [], skipped: {}, ...(typeof header?.id === "string" ? { id: header.id } : {}), ...(typeof header?.cwd === "string" ? { cwd: header.cwd } : {}) };
  for (const line of branch) {
    const id = line.id!;
    switch (line.type) {
      case "message": {
        const message = line.message as Message & { role: string };
        if (message.role === "user") parsed.drafts.push({ from: id, draft: { kind: "pi.user", model: [message] } });
        else if (message.role === "assistant") parsed.drafts.push({ from: id, draft: { kind: "pi.assistant", model: [message] } });
        else if (message.role === "toolResult") parsed.drafts.push({ from: id, draft: { kind: "pi.tool-result", model: [message], data: { diagnostics: [] } } });
        else {
          const text = typeof (message as { content?: unknown }).content === "string" || Array.isArray((message as { content?: unknown }).content)
            ? (message as { content: unknown }).content
            : JSON.stringify(message);
          parsed.drafts.push({ from: id, draft: { kind: "prime.custom", model: [userText(text, at(line))], data: { role: message.role } } });
        }
        break;
      }
      case "custom_message":
        parsed.drafts.push({ from: id, draft: { kind: "prime.custom", model: [userText(line.content, at(line))], data: { customType: String(line.customType), display: line.display !== false } } });
        break;
      case "compaction":
        parsed.drafts.push({
          from: id,
          draft: { kind: "pi.compaction", model: [userText(`${SUMMARY_PREFIX}${String(line.summary)}${SUMMARY_SUFFIX}`, at(line))], data: { reason: "threshold" } },
          ...(typeof line.firstKeptEntryId === "string" ? { headFrom: line.firstKeptEntryId } : {}),
        });
        break;
      case "model_change":
        parsed.model = { provider: String(line.provider), modelId: String(line.modelId) };
        break;
      case "thinking_level_change":
        parsed.thinkingLevel = line.thinkingLevel as ModelThinkingLevel;
        break;
      case "session_info":
        if (typeof line.name === "string") parsed.name = line.name;
        break;
      default:
        parsed.skipped[line.type] = (parsed.skipped[line.type] ?? 0) + 1;
    }
  }
  return parsed;
}

/** Resolves a compaction's head to the entry its first kept line became, or the compaction itself when that line was not imported. */
export function headFor(headFrom: string | undefined, written: Map<string, EntryId>): EntryId | "self" {
  return (headFrom && written.get(headFrom)) || "self";
}
