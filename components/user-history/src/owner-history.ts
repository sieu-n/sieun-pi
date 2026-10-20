import type { ChatHistory } from "./chat-corrections.ts";
import { missing } from "./locked-json.ts";
import { ownerTexts } from "./shared/brief-check.ts";
import type { ThreadMessage } from "./shared/types.ts";
import { fileLines } from "./file-lines.ts";

/**
 * What a session file says for the repeat count (`repeatsBetween`), read line by line; empty for a missing file. `owner` is every word the
 * owner wrote (`ownerTexts`), his messages and his board answers, and `refines` is the text of each `/refine` session command the service ran.
 * A thread's state holds only the file's tail (session-tail.ts, TAIL_MESSAGES), so an owner message from days back is only in the file.
 */
export async function fileChatHistory(file: string): Promise<ChatHistory> {
  try { return await chatHistory(fileLines(file)); }
  catch (error) { if (missing(error)) return { owner: [], refines: [] }; throw error; }
}

/** The same read over a session file's lines from anywhere, such as the lines `ssh mac` sends back for a chat that lives only on the Mac. */
export async function chatHistory(lines: AsyncIterable<string> | Iterable<string>): Promise<ChatHistory> {
  const messages: ThreadMessage[] = [];
  const refines: string[] = [];
  for await (const line of lines) {
    if (!line.includes('"user"') && !line.includes('"session_slash_command"')) continue;
    let entry: { type?: unknown; customType?: unknown; content?: unknown; message?: { role?: unknown; timestamp?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type === "message" && entry.message?.role === "user" && typeof entry.message.timestamp === "number") messages.push(entry.message as ThreadMessage);
    if (entry.type === "custom_message" && entry.customType === "session_slash_command" && typeof entry.content === "string" && entry.content.startsWith("/refine")) refines.push(entry.content);
  }
  return { owner: ownerTexts(messages), refines };
}
