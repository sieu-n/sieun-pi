import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "prime-agent";

test("native in-memory saved reader migrates only memory and leaves damaged JSONL unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-native-reader-"));
  try {
    const path = join(root, "saved.jsonl");
    const bytes = [
      JSON.stringify({ type: "session", version: 1, id: "saved-reader-test", timestamp: "2026-01-01T00:00:00Z", cwd: root }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: {
        role: "user", content: "A saved question before migration", timestamp: 1,
      } }),
      '{"type":"message",',
    ].join("\n");
    await writeFile(path, bytes);
    const before = await stat(path);
    const manager = SessionManager.inMemory(root);
    manager.setSessionFile(path);
    assert.equal(manager.isPersisted(), false);
    assert.equal(manager.getSessionId(), "saved-reader-test");
    assert.equal(manager.getHeader()?.version, 3);
    assert(manager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" &&
      entry.message.content === "A saved question before migration"));
    assert.equal(await readFile(path, "utf8"), bytes);
    const after = await stat(path);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native in-memory reader does not truncate an empty saved file or create a missing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-empty-reader-"));
  try {
    const empty = join(root, "empty.jsonl");
    const missing = join(root, "missing.jsonl");
    await writeFile(empty, "");
    const before = await stat(empty);
    const manager = SessionManager.inMemory(root);
    manager.setSessionFile(empty);
    assert.deepEqual(manager.getBranch(), []);
    assert.equal((await stat(empty)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(empty, "utf8"), "");
    manager.setSessionFile(missing);
    assert.equal(manager.isPersisted(), false);
    await assert.rejects(stat(missing), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
