// Guards 06:58Z on 10-27: the owner's read of Crawler VP's duties waited 1.7 s on a parse of its whole 7.8 MB runs file, which changes with each of its runs.
import assert from "node:assert/strict";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendedRuns, DutyStore } from "../src/chat-duty-store.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const run = (duty: string, at: number) => ({ duty, at, slot: at, trigger: "schedule", ms: 1, verdict: "met", metrics: {}, summary: `run ${at}` }) as unknown as DutyRunRecord;

/** How many JSON.parse calls `read` makes. */
async function parses<T>(read: () => Promise<T>): Promise<{ value: T; count: number }> {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof parse>[1]) => { count++; return parse(text, reviver); }) as typeof JSON.parse;
  try { return { value: await read(), count }; } finally { JSON.parse = parse; }
}

test("a runs file that grew, or that the store rewrote, is read again without parsing its old lines", async t => {
  const dir = await mkdtemp(join(tmpdir(), "duty-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DutyStore(dir);
  const old = Array.from({ length: 200 }, (_, index) => run(index % 2 ? "d1" : "d7", index + 1));
  await store.appendRun(CHAT, old[0]!);
  await writeFile(join(dir, "duties", CHAT + ".runs.jsonl"), old.map(record => JSON.stringify(record) + "\n").join(""));
  assert.equal((await store.runs(CHAT)).length, 200);

  await store.appendRun(CHAT, run("d7", 201));
  const grown = await parses(() => store.runs(CHAT));
  assert.deepEqual(grown.value.slice(0, 2).map(record => record.at), [201, 200]);
  assert.equal(grown.value.length, 201);
  assert.ok(grown.count <= 1, `the read after one append parsed ${grown.count} lines`);

  assert.equal(await store.updateRun(CHAT, "d1", 200, record => { record.summary = "after"; }), true);
  const updated = await parses(() => store.runs(CHAT));
  assert.equal(updated.value.find(record => record.at === 200)?.summary, "after");
  assert.equal(updated.value.length, 201);
  assert.equal(updated.count, 0, `the read after a rewrite parsed ${updated.count} lines`);

  assert.equal(await store.remove(CHAT, "d1"), true);
  const removed = await parses(() => store.runs(CHAT));
  assert.equal(removed.value.length, 101);
  assert.ok(removed.value.every(record => record.duty === "d7"));
  assert.equal(removed.count, 0, `the read after a removal parsed ${removed.count} lines`);

  await store.appendRun(CHAT, run("d7", 202));
  const onDisk = readFileSync(join(dir, "duties", CHAT + ".runs.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as DutyRunRecord).reverse();
  assert.deepEqual(await store.runs(CHAT), onDisk, "the kept parse matches the file");
});

test("a rewrite renamed over the runs file after its stat gives a full parse, never the new file's bytes at the old offsets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "duty-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "runs.jsonl");
  const line = (at: number, summary = "past") => JSON.stringify({ ...run("d7", at), summary }) + "\n";
  writeFileSync(file, line(1) + line(2));
  const parsedSize = BigInt(statSync(file).size);
  writeFileSync(file, line(1) + line(2) + line(3), { flag: "w" });
  const { ino, size } = statSync(file, { bigint: true });
  writeFileSync(file + ".tmp", line(1, "same") + line(2) + line(3));
  renameSync(file + ".tmp", file);
  assert.equal(await appendedRuns(file, ino, parsedSize, size), null);
});
