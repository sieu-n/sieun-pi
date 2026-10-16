import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileOwnerMessages, fileOwnerTexts } from "../src/owner-history.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp } as ThreadMessage);
const line = (message: ThreadMessage) => JSON.stringify({ type: "message", id: String(message.timestamp), timestamp: new Date(message.timestamp).toISOString(), message });
const MAC = "have it your duty to have usable mac.";

test("owner history: every owner message and board answer in a session file, past the thread's tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-history-"));
  try {
    const file = join(dir, "ops.jsonl");
    const early = user(MAC, 1_000);
    const tail = [user("[brief check] Your brief for [mac load at five](job:mac load at five) breaks the Jobs rule", 5_000), user("how is the wiki?", 6_000)];
    await writeFile(file, [JSON.stringify({ type: "session", id: "ops" }), line(early), "not json",
      JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[agent-message from w] user", timestamp: "1970-01-01T00:00:03.000Z" }),
      ...tail.map(line)].join("\n") + "\n");
    assert.deepEqual(await fileOwnerMessages(file), [{ text: MAC, at: 1_000 }, { text: "how is the wiki?", at: 6_000 }], "server notes, agent messages and bad lines are no owner messages");
    assert.deepEqual(await fileOwnerMessages(join(dir, "gone.jsonl")), [], "a missing file has no owner messages");
    const board = join(dir, "ci.jsonl");
    await writeFile(board, [user("[board] Owner checked \"OK to send iWebFusion a short follow-up?\" and answered: i said NEVER EVER SEND WITHOUT MY PERMISSION", 1_000),
      user("[board] Owner checked \"Deploy done?\"", 2_000), user("is ci blocked?", 3_000)].map(line).join("\n") + "\n");
    assert.deepEqual(await fileOwnerTexts(board), ["i said NEVER EVER SEND WITHOUT MY PERMISSION", "is ci blocked?"],
      "a board answer the owner typed is his words (c37's repeat, 10-12); a bare check and the todo text are not");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
