import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "prime-agent";
import { compactedEntries, historyMessages } from "../src/chat-threads.ts";

const at = "2026-09-27T05:58:07.136Z";
const user = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });

test("a live compacted thread gets back the turns before the latest first kept entry", () => {
  const branch = [
    user("u1", "first"),
    { type: "custom_message", id: "n1", parentId: "u1", timestamp: at, customType: "agent_message", content: "child reply", display: true },
    { type: "compaction", id: "c1", parentId: "n1", timestamp: at, summary: "one", firstKeptEntryId: "n1", tokensBefore: 10 },
    user("u2", "second"),
    user("u3", "third"),
    { type: "compaction", id: "c2", parentId: "u3", timestamp: at, summary: "two", firstKeptEntryId: "u3", tokensBefore: 20 },
    user("u4", "fourth"),
  ] as unknown as SessionEntry[];
  assert.deepEqual(compactedEntries(branch).map(entry => entry.id), ["u1", "n1", "c1", "u2"]);
  assert.deepEqual(historyMessages(compactedEntries(branch)).map(message => message.role), ["user", "custom", "compactionSummary", "user"]);
  assert.deepEqual(compactedEntries(branch.slice(0, 2)), [], "no compaction, nothing to add");
});
