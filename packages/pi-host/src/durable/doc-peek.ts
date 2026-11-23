/**
 * A `chat.doc` read from a thread file that is not open: pi-durable's own Session over the file reads the doc, with no Harness, so no task
 * graph, prompt, kernel, index backfill or pool label comes up, and the file closes when the read ends.
 *
 * apps/chat's agent.ref check (apps/chat/server/agents.ts `verifyRefs`) reads the ref of each of about 1,800 agent threads, one every
 * 500 ms, pass after pass. Through a full open each read kept its thread open until the 10 min idle close, so on 11-23 pi-host held 1,155
 * of 2,326 thread files open 12 min after a start, and a cold open under that load held the loop up to 2 s (~/work/pi-host-stalls/f-boot/).
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { createSession, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatDoc } from "./registry.ts";

/** The doc's value as `harness.snapshot(ChatDoc, ...)` gives it on the open thread, or null when the conversation has no such doc. */
export async function peekDoc(file: string, conversation: ConversationId, name: string, context: Context): Promise<JsonValue | null> {
  const session = createSession(await openNodeSqliteStorage(file));
  try {
    return (await session.snapshot(ChatDoc, conversation, name, context))?.value ?? null;
  } finally {
    await session.close(context);
  }
}
