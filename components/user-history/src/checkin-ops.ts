import type { SessionEntry } from "prime-agent";
import { readBranchTail } from "./session-tail.ts";

/** A chat's transcript messages from its session file, read whole for the check-in and its hand-off reads. */

/** A transcript message, as the session file holds it or the hub projects it: only the fields read here. */
export interface Said { role: string; customType?: string; content?: unknown; stopReason?: string; toolCallId?: string; isError?: boolean; timestamp?: number;
  /** A tool result's details as the session file holds them, such as `sentAgentMessages`; the hub drops them. */
  details?: unknown }

export const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";

/** The transcript messages of a session file's branch tail (`readBranchTail`), whole, as the hub's projection clips custom text and tool arguments. */
export async function tailMessages(sessionFile: string): Promise<Said[] | undefined> {
  const tail = await readBranchTail(sessionFile);
  return tail?.entries.flatMap((entry: SessionEntry): Said[] => entry.type === "message" ? [entry.message as Said]
    : entry.type === "custom_message" ? [{ role: "custom", customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp) }] : []);
}
