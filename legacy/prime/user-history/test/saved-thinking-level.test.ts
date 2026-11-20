// Guards 11-20, when the owner saw "Claude Opus 5.5 · off" on long saved threads such as slack green guy (msg mwou408y) while every one of them
// would wake on high: the saved snapshot read effort only from its first page of 100 messages, and a thread whose last thinking_level_change sat
// further back (Prime writes one at the create, and the 11-13 model sweep wrote one more) fell back to a made-up "off".
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { ThreadHub } from "../src/chat-threads.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { CURRENT_SESSION_VERSION } from "../src/prime-values.ts";
import { lastThinkingLevel } from "../src/session-file-end.ts";
import type { ThinkingLevel, ThreadSnapshot } from "../src/shared/types.ts";

const ID = "01a1f8aa-0000-7000-8000-000000000001";

/** A session file: the header, then `levels` as thinking_level_change entries at the given message counts, then `messages` user messages. */
function sessionFile(dir: string, messages: number, levels: Array<{ at: number; level: ThinkingLevel }>): string {
  const file = join(dir, `${ID}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: "2026-11-13T00:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  let n = 0;
  const add = (entry: Record<string, unknown>) => {
    const id = `e${++n}`;
    lines.push(JSON.stringify({ type: entry.type, id, parentId: parent, timestamp: new Date(Date.UTC(2026, 10, 13) + n * 1000).toISOString(), ...entry }));
    parent = id;
  };
  add({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" });
  for (let i = 0; i <= messages; i++) {
    for (const change of levels) if (change.at === i) add({ type: "thinking_level_change", thinkingLevel: change.level });
    if (i < messages) add({ type: "message", message: { role: "user", content: `message ${i}`, timestamp: Date.UTC(2026, 10, 13) + i * 1000 } });
  }
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function savedLevel(file: string, defaultLevel: ThinkingLevel | null): Promise<ThinkingLevel> {
  const catalog = { hostOf: () => undefined, refresh: async () => {} } as unknown as Catalog;
  const threads = new ThreadHub(join(tmpdir(), "no-daemon.sock"), catalog, () => ({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: defaultLevel }),
    async () => undefined, {}, undefined, true);
  const summary = { sessionId: ID, sessionFile: file, cwd: tmpdir(), messageCount: 0 } as unknown as SessionSummary;
  const snapshot = await (threads as unknown as { savedSnapshot(summary: SessionSummary): Promise<ThreadSnapshot> }).savedSnapshot(summary);
  return snapshot.info.thinkingLevel;
}

test("a long saved thread shows the effort its file last set, also when that change is older than the first page", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await savedLevel(sessionFile(dir, 300, [{ at: 0, level: "medium" }, { at: 40, level: "high" }]), "low"), "high");
});

test("a saved thread whose file never set an effort shows the settings default it would wake with, never a made-up off", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await savedLevel(sessionFile(dir, 300, []), "high"), "high");
});

test("a change inside the first page still wins over an older one", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await savedLevel(sessionFile(dir, 300, [{ at: 0, level: "high" }, { at: 290, level: "medium" }]), "high"), "medium");
});

test("the backward scan crosses chunk ends, skips the text inside a message and reads only what was added after `after`", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "big.jsonl");
  const quoted = JSON.stringify({ type: "message", message: { role: "user", content: '{"type":"thinking_level_change","thinkingLevel":"off"} ' + "x".repeat(300_000) } });
  writeFileSync(file, [JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }), quoted, quoted, quoted].join("\n") + "\n");
  const first = await lastThinkingLevel(file);
  assert.deepEqual({ whole: first.whole, level: first.level }, { whole: true, level: "high" });
  assert.equal((await lastThinkingLevel(file, first.size)).level, undefined);
  appendFileSync(file, JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }) + "\n" + quoted + "\n");
  assert.deepEqual(await lastThinkingLevel(file, first.size).then(read => ({ whole: read.whole, level: read.level })), { whole: false, level: "medium" });
});
