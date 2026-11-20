// Guards 11-20, when the owner saw "Claude Opus 5.5 · off" on long saved threads such as slack green guy (msg mwou408y) while every one of them
// would wake on high: the saved snapshot read effort only from its first page of 100 messages, and a thread whose last thinking_level_change sat
// further back (Prime writes one at the create, and the 11-13 model sweep wrote one more) fell back to a made-up "off". The open reads no more of
// the file than before (thread-open-page.test.ts): the fill's older entries can name the effort, else the thread shows the default it wakes on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { ThreadHub } from "../src/chat-threads.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { CURRENT_SESSION_VERSION } from "../src/prime-values.ts";
import type { ThinkingLevel, ThreadEvent } from "../src/shared/types.ts";

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

/** The efforts a saved thread's feed shows on open: its first snapshot's, then each later info event's, once the open and its fill ended. */
async function shownLevels(file: string, defaultLevel: ThinkingLevel | null): Promise<ThinkingLevel[]> {
  const catalog = { summary: async (id: string) => ({ sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: 0 }), hostOf: () => null,
    heldCopy: () => undefined } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: defaultLevel }));
  const events: ThreadEvent[] = [];
  try {
    await hub.subscribe(ID, event => events.push(event));
    await hub.open(ID);
  } finally { await hub.close(); }
  const levels = events.flatMap(event => event.type === "snapshot" ? [event.snapshot.info.thinkingLevel] : event.type === "info" ? [event.info.thinkingLevel] : []);
  return levels.filter((level, at) => at === 0 || level !== levels[at - 1]);
}

test("a long saved thread shows the effort its file last set, also when that change is older than the first page", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await shownLevels(sessionFile(dir, 300, [{ at: 0, level: "medium" }, { at: 40, level: "xhigh" }]), "high")).at(-1), "xhigh");
});

test("a saved thread whose file never set an effort shows the settings default it would wake with, never a made-up off", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await shownLevels(sessionFile(dir, 300, []), "high"), ["high"]);
});

test("a change inside the first page wins over an older one, with no later change on the feed", async t => {
  const dir = mkdtempSync(join(tmpdir(), "saved-thinking-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await shownLevels(sessionFile(dir, 300, [{ at: 0, level: "high" }, { at: 290, level: "medium" }]), "high"), ["medium"]);
});
