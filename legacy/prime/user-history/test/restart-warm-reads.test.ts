// Guards the 18:05Z and 18:20Z dirty minutes of 10-28 on us-metal02: each chat service start read again what the last run had read, the tail
// of every stopped job's session file (6.6 s of readTail on the main thread from 6 to 25 s after the 18:19:36Z start) and all 137 MB of
// pi-pool.log for the Agent queue chart (1.5 to 1.7 s after the 18:02Z and 18:14Z starts), and api/threads/<id>/older reads beside them took
// 1.02 and 1.22 s. A stop now saves those readings with the key each was read at, and the next start takes them and reads only what changed.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AGENTS_FILE, Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { turnHistory } from "../src/turn-history.ts";

/** chat-catalog.ts `TAILS_FILE`, named here so the test reads the same file a release writes. */
const TAILS_FILE = "chat-tails.json";

function catalogIn(t: TestContext, dir: string): Catalog {
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", new ChatReadState("unused"), new ChatLabels("unused"), chats, new ThreadOrigins({ ids: async () => [] }), null, null, join(dir, AGENTS_FILE));
  t.after(() => catalog.close());
  return catalog;
}

const line = (entry: object): string => JSON.stringify(entry) + "\n";

test("a stop saves each job's cut, and the next start takes it without reading the file again", async t => {
  const dir = mkdtempSync(join(tmpdir(), "tails-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "job.jsonl");
  writeFileSync(file, line({ type: "session", id: "job" }) +
    line({ type: "message", timestamp: "2026-10-28T18:00:00.000Z", message: { role: "user", content: "Fix the restart" } }) +
    line({ type: "message", timestamp: "2026-10-28T18:00:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse" } }) +
    line({ type: "message", timestamp: "2026-10-28T18:00:09.000Z", message: { role: "toolResult", toolCallId: "c1", content: "Request was aborted" } }));
  const first = catalogIn(t, dir);
  await first.cuts.update([{ file, key: "k1|4" }]);
  const cut = first.cuts.of(file);
  assert.ok(cut, "the file ends cut mid-tool");
  await first.close();
  assert.ok(existsSync(join(dir, TAILS_FILE)), "the stop saves the tails it read");

  // The next start must not need the file: only the saved reading can say it was cut.
  rmSync(file);
  const next = catalogIn(t, dir);
  assert.equal(existsSync(join(dir, TAILS_FILE)), false, "the start deletes the file it took");
  assert.deepEqual(next.cuts.of(file), cut);
  assert.equal(await next.cuts.update([{ file, key: "k1|4" }]), false, "an unchanged key reads nothing");
  assert.deepEqual(next.cuts.of(file), cut);
  assert.equal(await next.cuts.update([{ file, key: "k2|5" }]), true, "a changed key reads the file again");
  assert.equal(next.cuts.of(file), null);
});

test("the Agent queue chart's next start reads only the pi-pool.log lines added since the stop", async t => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-saved-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "pi-pool.log");
  const saved = join(dir, "turn-history.json");
  const now = Date.parse("2026-10-28T18:30:00Z");
  writeFileSync(log, line({ ts: "2026-10-28T18:01:00", event: "turn_released" }) + line({ ts: "2026-10-28T18:02:00", event: "turn_released" }));
  const before = turnHistory(log, saved);
  assert.equal((await before(now)).at(-1)?.finished, 2);
  await before.save();
  // The lines the last run read are overwritten in place: a start that scanned the file again would count 0 of them, the saved hours 2.
  writeFileSync(log, readFileSync(log, "utf8").replaceAll("turn_released", "turn_xxxxxxxx"));
  appendFileSync(log, line({ ts: "2026-10-28T18:20:00", event: "turn_released" }));
  const after = turnHistory(log, saved);
  assert.equal((await after(now)).at(-1)?.finished, 3);
  assert.equal(existsSync(saved), false, "the start deletes the file it took");
});

test("a scan of a long pi-pool.log keeps every line whatever slice it falls in", async t => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-long-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "pi-pool.log");
  const one = line({ ts: "2026-10-28T18:05:00", event: "turn_released", note: "é".repeat(97) });
  writeFileSync(log, one.repeat(30_000));
  const hours = await turnHistory(log)(Date.parse("2026-10-28T18:30:00Z"));
  assert.equal(hours.at(-1)?.finished, 30_000);
});
