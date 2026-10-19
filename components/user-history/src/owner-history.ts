import { missing } from "./locked-json.ts";
import { ownerTexts } from "./shared/brief-check.ts";
import type { ThreadMessage } from "./shared/types.ts";
import { fileLines } from "./file-lines.ts";

/**
 * Every word the owner wrote in a session file (`ownerTexts`): his messages and his board answers, read line by line; empty for a missing
 * file. A thread's state holds only the file's tail (session-tail.ts, TAIL_MESSAGES), so an owner message from days back is only in the file.
 */
export async function fileOwnerTexts(file: string): Promise<string[]> {
  return ownerTexts(await userMessages(file));
}

async function userMessages(file: string): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  try {
    for await (const line of fileLines(file)) {
      if (!line.includes('"user"')) continue;
      let entry: { type?: unknown; message?: { role?: unknown; timestamp?: unknown } };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry.type === "message" && entry.message?.role === "user" && typeof entry.message.timestamp === "number") messages.push(entry.message as ThreadMessage);
    }
  } catch (error) { if (missing(error)) return []; throw error; }
  return messages;
}
