import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "prime-agent";
import { fileFirstMessage } from "../src/chat-catalog.ts";
import { compactedEntries, historyMessages } from "../src/chat-threads.ts";

const at = "2026-09-27T05:58:07.136Z";
const user = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });

test("the title of a compacted thread is the first user message in its file", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-history-"));
  try {
    const file = join(dir, "session.jsonl");
    const lines = [{ type: "session", id: "s" }, { type: "model_change", id: "m", modelId: "gpt-6-astra" }, user("u1", "is our blog system done?"),
      { type: "compaction", id: "c", summary: "sum" }, user("u2", "<provider_quota_resumed>\nresume\n</provider_quota_resumed>")];
    writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    assert.equal(fileFirstMessage(file), "is our blog system done?");
    writeFileSync(file, JSON.stringify(lines[0]) + "\n");
    assert.equal(fileFirstMessage(file), undefined, "no user message yet");
    assert.equal(fileFirstMessage(join(dir, "missing.jsonl")), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
