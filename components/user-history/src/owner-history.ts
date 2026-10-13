import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { missing } from "./locked-json.ts";
import { briefCheck, type BriefFinding, type BriefInput, type OwnerMessage, ownerMessages, ownerTexts } from "./shared/brief-check.ts";
import type { ThreadMessage } from "./shared/types.ts";

/**
 * Every owner message in a session file, oldest first, read line by line; empty for a missing file. A thread's state holds only the file's
 * tail (session-tail.ts, TAIL_MESSAGES), so an owner message from days back is only in the file.
 */
export async function fileOwnerMessages(file: string): Promise<OwnerMessage[]> {
  return ownerMessages(await userMessages(file));
}

/** Every word the owner wrote in a session file (`ownerTexts`): his messages and his board answers. */
export async function fileOwnerTexts(file: string): Promise<string[]> {
  return ownerTexts(await userMessages(file));
}

async function userMessages(file: string): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  try {
    for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
      if (!line.includes('"user"')) continue;
      let entry: { type?: unknown; message?: { role?: unknown; timestamp?: unknown } };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry.type === "message" && entry.message?.role === "user" && typeof entry.message.timestamp === "number") messages.push(entry.message as ThreadMessage);
    }
  } catch (error) { if (missing(error)) return []; throw error; }
  return messages;
}

/**
 * The brief check with the chat's owner messages from the thread's tail, and from its whole session file when a quote is not in the tail. On
 * 10-12 ops guy's job briefs quoted the owner's 10-09 "have it your duty to have usable mac.", which had left the tail. The check refused it twice
 * as not in any owner message, and the chat recorded the refusal as an owner repeat of c59.
 */
export async function briefCheckWithHistory(input: Omit<BriefInput, "owner">, tail: readonly ThreadMessage[], sessionFile: string): Promise<BriefFinding[]> {
  const findings = briefCheck({ ...input, owner: ownerMessages(tail) });
  return findings.some(finding => finding.kind === "not-verbatim") ? briefCheck({ ...input, owner: await fileOwnerMessages(sessionFile) }) : findings;
}
