/**
 * The 2 s thread list read sends each box's cursor and merges the rows changed since it (multi-host.ts `boxThreads`, p276). Parsing all
 * 2,300 rows of pi-host's answer every 2 s took about 28 ms of the chat's loop on 11-24. A full answer (a first read, a cursor from before a
 * pi-host restart, or a pi-host from before 11-24 that ignores the cursor) replaces the box's rows.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/thread-page.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixtureHost } from "../../server/host/fixture.ts";
import { MultiHost } from "../../server/host/multi-host.ts";
import { threadPageOf, type DurableThread, type ThreadPage } from "../../server/host/types.ts";

const row = (id: string, updatedAt: number, name = id): DurableThread => ({
  id, name, provider: "anthropic", modelId: "m", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt, failed: false, archived: false, preview: "",
  children: 0, status: "idle",
});

/** A box whose `durable_threads` answers what the test scripts, and which notes each cursor it was sent. */
class PagedHost extends FixtureHost {
  readonly sent: (string | null)[] = [];
  script: (cursor: string | null) => ThreadPage = () => { throw new Error("no answer scripted"); };
  async threadPage(cursor: string | null): Promise<ThreadPage> {
    this.sent.push(cursor);
    return this.script(cursor);
  }
}

function setup() {
  const paged = new PagedHost();
  const host = new MultiHost("metal", [{ box: "metal", label: "metal", host: paged }], mkdtempSync(join(tmpdir(), "thread-page-")),
    { box: "metal", platform: "linux", home: "/", projects: [], agentsDir: "/" });
  return { paged, host };
}
const ids = (rows: DurableThread[]) => rows.map(r => r.id);

test("a read after the first sends the last cursor, keeps every unchanged row as the same object and merges the changed and removed ones", async () => {
  const { paged, host } = setup();
  paged.script = () => ({ threads: [row("b", 20), row("a", 10)], removed: [], cursor: "c1", full: true });
  const first = await host.threads();
  assert.deepEqual(ids(first), ["b", "a"]);
  assert.equal(first[0]!.box, "metal", "each row carries its box");

  paged.script = () => ({ threads: [row("a", 30, "a renamed")], removed: [], cursor: "c2", full: false });
  const second = await host.threads();
  assert.deepEqual(paged.sent, [null, "c1"]);
  assert.deepEqual(ids(second), ["a", "b"], "the merged rows stay newest first");
  assert.equal(second[0]!.name, "a renamed");
  assert.equal(second[0]!.box, "metal");
  assert.equal(second[1], first[0], "a row no answer changed is the same object");

  paged.script = () => ({ threads: [], removed: [], cursor: "c3", full: false });
  const third = await host.threads();
  assert.equal(third[0], second[0]);
  assert.equal(third[1], second[1]);

  paged.script = () => ({ threads: [], removed: ["b"], cursor: "c4", full: false });
  assert.deepEqual(ids(await host.threads()), ["a"], "a removed id leaves the list");
  assert.deepEqual(paged.sent, [null, "c1", "c2", "c3"]);
});

test("a full answer, as after a pi-host restart, replaces the box's rows", async () => {
  const { paged, host } = setup();
  paged.script = () => ({ threads: [row("a", 10), row("b", 5)], removed: [], cursor: "old-boot:1", full: true });
  await host.threads();
  paged.script = () => ({ threads: [row("c", 40)], removed: [], cursor: "new-boot:1", full: true });
  assert.deepEqual(ids(await host.threads()), ["c"]);
  paged.script = () => ({ threads: [row("d", 50)], removed: [], cursor: "new-boot:2", full: false });
  assert.deepEqual(ids(await host.threads()), ["d", "c"]);
  assert.deepEqual(paged.sent, [null, "old-boot:1", "new-boot:1"]);
});

test("a pi-host that ignores the cursor sends every row each time, which reads as full, and the next read sends no cursor", async () => {
  assert.deepEqual(threadPageOf({ threads: [] }), { threads: [], removed: [], cursor: null, full: true });
  assert.equal(threadPageOf({ threads: [], removed: [], cursor: "x", full: false }).full, false);
  const { paged, host } = setup();
  let rows = [row("a", 10), row("b", 5)];
  paged.script = () => threadPageOf({ threads: rows });
  assert.deepEqual(ids(await host.threads()), ["a", "b"]);
  rows = [row("b", 20)];
  assert.deepEqual(ids(await host.threads()), ["b"], "the old host's whole list wins");
  assert.deepEqual(paged.sent, [null, null]);
});

test("a read that fails keeps the box's rows and its cursor", async () => {
  const { paged, host } = setup();
  paged.script = () => ({ threads: [row("a", 10)], removed: [], cursor: "c1", full: true });
  await host.threads();
  paged.script = () => { throw new Error("pi-host did not answer durable_threads in 10 s"); };
  await assert.rejects(host.threads(), /did not answer/, "with one box, no answer is an error, as before");
  paged.script = () => ({ threads: [row("b", 20)], removed: [], cursor: "c2", full: false });
  assert.deepEqual(ids(await host.threads()), ["b", "a"]);
  assert.deepEqual(paged.sent, [null, "c1", "c1"]);
});
