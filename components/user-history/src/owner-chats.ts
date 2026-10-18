import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLEAN_ROOM_CHATS_FILE } from "./chat-corrections.ts";

/** The ids of a `{ ids }` file under the data dir; none when it is missing or unreadable. */
async function idsOf(dataDir: string, file: string): Promise<string[]> {
  const value = JSON.parse(await readFile(join(dataDir, file), "utf8").catch(() => "{}")) as { ids?: unknown };
  return (Array.isArray(value.ids) ? value.ids : []).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
}

/**
 * The owner's chats: every chat in `chats.json` but the archived ones (`archived-chats.json`) and the clean-room test chats
 * (`clean-room-chats.json`). The duties that measure every chat count only these, and message only these: at 01:43Z on 10-18 the Whole system
 * duty counted a stuck step of the clean-room chat "Duties review" and its job messaged that chat, which spoiled the run.
 */
export async function ownerChats(dataDir: string): Promise<string[]> {
  const others = new Set([...await idsOf(dataDir, "archived-chats.json"), ...await idsOf(dataDir, CLEAN_ROOM_CHATS_FILE)]);
  return (await idsOf(dataDir, "chats.json")).filter(id => !others.has(id));
}
