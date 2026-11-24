/**
 * `durable_threads` with a cursor answers only the rows that changed since that cursor's read, and every row when the cursor is unknown.
 * apps/chat reads the list every 2 s, and parsing all 2,300 rows of each answer cost 28 ms of its loop on 11-24 (p276). With no cursor the
 * answer stays every row, as the relay and the Mac's apps/chat read it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings } from "@sieun-pi/pi-pool/durable";
import type { Outbound } from "../../src/protocol.ts";
import { DurableCommands } from "../../src/durable/commands.ts";
import { ThreadIndex } from "../../src/durable/index-db.ts";
import { RETRY_FLAG_MS } from "../../src/durable/retrying.ts";
import { DurableThreads, type ThreadInfo, type ThreadListPage } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-thread-delta-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sink = { clientId: "chat", write: (_line: Outbound) => {} };
const row = (id: string, at: number) => ({ id, name: id, provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: at, updatedAt: at });

function models() {
  const out = createModels();
  out.setProvider(fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 }).provider);
  return out;
}

test("every writer of a shown column moves the row's change number, and a write of nothing shown does not", () => {
  const path = join(dir, "writers.sqlite");
  const index = new ThreadIndex(path);
  for (let i = 0; i < 5; i++) index.insertThread(row(`t${i}`, i));
  let seq = index.changeSeq();
  const changed = (write: () => void): string[] => {
    write();
    const out = index.changedSince(seq);
    seq = out.seq;
    return [...out.rows.map(r => r.id), ...out.gone.map(id => `-${id}`)];
  };
  assert.deepEqual(changed(() => index.insertThread(row("t5", 9))), ["t5"], "insertThread");
  assert.deepEqual(changed(() => index.insertThread(row("t5", 9))), [], "insertThread of a known id writes nothing");
  assert.deepEqual(changed(() => index.markActive("t1", 20)), ["t1"], "markActive");
  assert.deepEqual(changed(() => index.setWake("t1", { active: false, at: 99 }, 21)), ["t1"], "setWake");
  assert.deepEqual(changed(() => index.setWake("t1", { active: false, at: 99 }, 22)), [], "setWake to the same wake");
  const fields: [string, Parameters<ThreadIndex["update"]>[1]][] = [
    ["name", { name: "renamed" }], ["cwd", { cwd: "/tmp" }], ["provider", { provider: "openai" }], ["modelId", { modelId: "gpt" }],
    ["thinkingLevel", { thinkingLevel: "low" }], ["archived", { archived: true }], ["failed", { failed: true }], ["preview", { preview: "hi" }],
    ["children", { children: 3 }], ["updatedAt", { updatedAt: 30 }],
  ];
  for (const [name, change] of fields) {
    assert.deepEqual(changed(() => index.update("t2", change)), ["t2"], `update ${name}`);
    assert.deepEqual(changed(() => index.update("t2", change)), [], `update ${name} to the same value`);
  }
  index.addEntries("t3", [{ thread: "t3", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 1, text: "hello" }], []);
  assert.deepEqual(changed(() => index.resetEntries("t3")), [], "the search rows and their mark are no shown column");
  // No pi-host code removes a row today; a removal still reads as one.
  const raw = new DatabaseSync(path);
  raw.prepare("DELETE FROM threads WHERE id = ?").run("t4");
  raw.close();
  assert.deepEqual(changed(() => {}), ["-t4"], "a removed row");
  assert.deepEqual(changed(() => index.insertThread(row("t4", 40))), ["t4"], "a row made again is a row, not a removal");
  index.close();
});

test("an index from before change numbers gains them, and its rows count as read by the first full answer", () => {
  const path = join(dir, "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, wake_active INTEGER NOT NULL DEFAULT 0, wake_at INTEGER, failed INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', children INTEGER NOT NULL DEFAULT 0, indexed_entry INTEGER NOT NULL DEFAULT 0);
    INSERT INTO threads (id, name, provider, model_id, thinking, cwd, created_at, updated_at) VALUES ('a', 'a', 'anthropic', 'm', 'high', '/', 1, 1);`);
  old.close();
  const index = new ThreadIndex(path);
  const seq = index.changeSeq();
  assert.deepEqual(index.changedSince(seq).rows, []);
  index.update("a", { name: "b" });
  assert.deepEqual(index.changedSince(seq).rows.map(r => r.name), ["b"]);
  const id = index.listId;
  index.close();
  const again = new ThreadIndex(path);
  assert.equal(again.listId, id, "the index keeps its id across opens");
  again.close();
});

test("a cursor answers the changed rows only, an archived or unknown one as asked, and no cursor answers every row as before", async () => {
  const threads = new DurableThreads({ dir: join(dir, "durable"), models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null });
  const commands = new DurableCommands(threads);
  const call = async (command: Record<string, unknown>) => {
    const answer = (await commands.handle({ id: "1", type: "durable_threads", ...command }, sink)) as { success: boolean; data: unknown; error?: string };
    assert.equal(answer.success, true, answer.error);
    return answer.data;
  };
  const page = async (cursor: string | null, archived?: boolean) => (await call({ cursor, ...(archived === undefined ? {} : { archived }) })) as ThreadListPage;
  let before = "";
  try {
    await threads.start();
    const made: ThreadInfo[] = [];
    for (const name of ["one", "two", "three"]) made.push(await threads.create({ name }));
    const [one, two, three] = made.map(t => t.id) as [string, string, string];

    assert.deepEqual(await call({}), { threads: threads.list() }, "no cursor: every row and nothing else");
    assert.deepEqual(await call({ archived: false }), { threads: threads.list({ archived: false }) });

    const first = await page(null);
    assert.equal(first.full, true);
    assert.deepEqual(first.threads, threads.list());
    assert.deepEqual(first.removed, []);

    const quiet = await page(first.cursor);
    assert.deepEqual({ ...quiet, cursor: "" }, { threads: [], removed: [], cursor: "", full: false }, "nothing changed");

    await threads.set(two, { name: "two renamed" });
    const renamed = await page(quiet.cursor);
    assert.equal(renamed.full, false);
    assert.deepEqual(renamed.threads, [threads.info(two)], "the renamed row and no other");

    await threads.set(three, { archived: true });
    const archived = await page(renamed.cursor);
    assert.deepEqual(archived.threads.map(t => [t.id, t.archived]), [[three, true]]);
    const unarchivedOnly = await page(renamed.cursor, false);
    assert.deepEqual([unarchivedOnly.threads, unarchivedOnly.removed], [[], [three]], "a row archived out of an unarchived list leaves it");

    threads.index.markActive(one, Date.now());
    const running = await page(archived.cursor);
    assert.deepEqual(running.threads.map(t => [t.id, t.status]), [[one, "running"]], "a status change");

    for (const unknown of ["", "nonsense", `${threads.index.listId}:other-process:0:0`, `other-index:${archived.cursor.split(":").slice(1).join(":")}`,
      archived.cursor.replace(/:(\d+):(\d+)$/, (_, seq: string, retry: string) => `:${Number(seq) + 100}:${retry}`)]) {
      const full = await page(unknown);
      assert.equal(full.full, true, `cursor ${JSON.stringify(unknown)}`);
      assert.deepEqual(full.threads, threads.list());
    }
    before = (await page(null)).cursor;
  } finally {
    await threads.shutdown();
  }
  const restarted = new DurableThreads({ dir: join(dir, "durable"), models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null });
  try {
    const after = restarted.listSince(before);
    assert.equal(after.full, true, "a cursor from before a restart reads every row");
  } finally {
    await restarted.shutdown();
  }
});

test("a thread whose retrying flag shows or changes comes back in the next page", async () => {
  let shift = 0;
  let sent = 0;
  const threads = new DurableThreads({
    dir: join(dir, "retrying"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null,
    now: () => Date.now() + shift,
    models: () => {
      const out = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 200 }, () => () => {
        sent++;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
      }));
      out.setProvider(faux.provider);
      return out;
    },
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
  });
  try {
    const quiet = await threads.create({ name: "quiet" });
    const thread = await threads.create({ name: "relay page job" });
    await threads.submit(thread.id, { text: "Build the relay page." });
    for (let i = 0; i < 200 && sent < 3; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(sent >= 3);
    const before = threads.listSince(undefined).cursor;
    // The run's own writes settle before the flag shows, so only the flag can bring the row back below.
    const settled = threads.listSince(before).cursor;
    shift = RETRY_FLAG_MS + 1000;
    const shown = threads.listSince(settled);
    assert.deepEqual(shown.threads.map(t => t.id), [thread.id]);
    assert.match(shown.threads[0]!.retrying ?? "", /^retrying since/);
    assert.ok(!shown.threads.some(t => t.id === quiet.id));
    await threads.abort(thread.id);
  } finally {
    await threads.shutdown();
  }
});
