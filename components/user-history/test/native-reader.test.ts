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


test("native catalog usage keeps whole-file own spend across branches and compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-usage-reader-"));
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    const usage = (scale: number) => ({ input: 100 * scale, output: 25 * scale,
      cacheRead: 40 * scale, cacheWrite: 10 * scale, totalTokens: 175 * scale,
      cost: { input: 0.0625 * scale, output: 0.03125 * scale,
        cacheRead: 0.015625 * scale, cacheWrite: 0.015625 * scale, total: 0.125 * scale } });
    const assistant = (text: string, scale: number) => manager.appendMessage({
      role: "assistant", content: [{ type: "text", text }], api: "chat-test-api", provider: "chat-test",
      model: "synthetic", stopReason: "stop", timestamp: 1001, usage: usage(scale),
    });
    manager.appendMessage({ role: "user", content: "Before compaction", timestamp: 1000 });
    const beforeCompaction = assistant("Before compaction reply", 1);
    manager.appendMessage({ role: "user", content: "Inactive branch", timestamp: 1002 });
    const inactive = assistant("Inactive branch reply", 2);
    manager.branch(beforeCompaction);
    manager.appendMessage({ role: "user", content: "Active branch", timestamp: 1003 });
    const active = assistant("Active branch reply", 1);
    manager.appendChildUsageAttribution(active, usage(3), usage(4));
    manager.appendCompaction("Saved summary", active, 200, undefined, undefined, undefined, usage(1));
    manager.flushNow();
    assert(!manager.getBranch().some(entry => entry.id === inactive));
    assert(!manager.buildSessionContext().messages.some(message => message.role === "assistant" &&
      message.content.some(part => part.type === "text" && part.text === "Before compaction reply")));
    const file = manager.getSessionFile();
    assert(file);
    const bytes = await readFile(file);
    const before = await stat(file);
    const summary = (await SessionManager.list(root, join(root, "sessions")))
      .find(session => session.id === manager.getSessionId());
    assert(summary);
    assert.deepEqual(summary.usage, { inputTokens: 750, outputTokens: 125, cost: 0.625 });
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native catalog leaves unrecorded zero usage absent rather than inventing a quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-usage-empty-"));
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "No billed calls", timestamp: 1000 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recorded fixture" }],
      api: "chat-test-api", provider: "chat-test", model: "synthetic", stopReason: "stop", timestamp: 1001,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.flushNow();
    const summary = (await SessionManager.list(root, join(root, "sessions")))
      .find(session => session.id === manager.getSessionId());
    assert(summary);
    assert.equal(summary.usage, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
