// Guards the 10-19 heap sample of a scratch serve: fileFirstMessage made 193 MB of the 3.4 GB allocated in 30 s, because a working session
// with no user message yet changes its row on every roster update and each change read its file from the start again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, openSync, writeSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstTask } from "../src/chat-catalog.ts";

const line = (entry: unknown) => JSON.stringify(entry) + "\n";

test("a session file that grows without a user message is read on from the byte the last read reached, not from its start", t => {
  const dir = mkdtempSync(join(tmpdir(), "first-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const filler = line({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] } });
  writeFileSync(file, line({ type: "session", version: 3, id: "s" }) + filler.repeat(50));
  const row = (count: number) => ({ sessionFile: file, messageCount: count, modified: String(count), lastActivityAt: String(count), firstMessage: "(no messages)" });
  assert.equal(firstTask(row(1)), "");

  // Bytes the first read already covered are rewritten in place to a user message: a read from the start would find it.
  const fd = openSync(file, "r+");
  const user = line({ type: "message", id: "u0", message: { role: "user", content: "seen only from the start" } });
  writeSync(fd, user.padEnd(filler.length - 1, " ").slice(0, filler.length - 1) + "\n", 0 + line({ type: "session", version: 3, id: "s" }).length);
  closeSync(fd);
  appendFileSync(file, filler.repeat(20));
  assert.equal(firstTask(row(2)), "", "the read started again at the file's first byte");

  appendFileSync(file, line({ type: "message", id: "u1", message: { role: "user", content: "the task" } }));
  assert.equal(firstTask(row(3)), "the task");
});
