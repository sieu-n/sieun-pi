// Guards the starts of 11-03 on us-metal02: the agent outbox read back 22,677 entry files (42 MB), 22,642 of them done, with 1.3 s of the main
// thread in 7.7 to 10.4 s, and the reopened tabs' older pages waited 2.3 to 3.8 s behind the start (src/outbox.ts doneFile).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doneFile, Outbox, type OutboxDeps } from "../src/outbox.ts";

const send = (id: string, text: string) => ({ id, threadId: "t-1", text, images: [], mode: "steer" as const, fingerprint: `fp-${id}` });
const deps = (dir: string, log: string[] = []): OutboxDeps => ({ dir, log: line => { log.push(line); }, changed: () => {}, final: () => null,
  sleep: () => new Promise(resolve => setImmediate(resolve)), copy: async () => "absent", deliver: async (_entry, sending) => { await sending(); } });

test("a start takes the done entries a stop saved, reads none of their files, and a resend of one still answers its full entry", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "outbox-done-")), "agent-outbox");
  const first = new Outbox(deps(dir));
  await first.submit(send("m-1", "the first report"));
  await first.idle();
  await first.close();
  assert.ok(existsSync(doneFile(dir)), "the stop saved its done entries");
  // A file the start would read and could not parse logs a skip; the stub stands in for it, so nothing is skipped.
  const file = join(dir, "m-1.json");
  const kept = await readFile(file, "utf8");
  await writeFile(file, "{not json");
  const log: string[] = [];
  const next = new Outbox(deps(dir, log));
  await next.idle();
  assert.deepEqual(log.filter(line => line.includes("skip")), []);
  assert.equal(existsSync(doneFile(dir)), false, "the start deletes the saved file, so a crash before the next stop reads every file");
  await writeFile(file, kept);
  const again = await next.submit(send("m-1", "the first report"));
  assert.equal(again.outbox.state, "delivered");
  assert.equal(again.outbox.text, "the first report", "a resend of a done id reads its file for the text");
  await next.close();
});

test("a start with no saved file reads every entry file, as before", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "outbox-done-")), "agent-outbox");
  const first = new Outbox(deps(dir));
  await first.submit(send("m-1", "a report"));
  await first.idle();
  await first.close();
  await writeFile(doneFile(dir), "{broken");
  const log: string[] = [];
  const next = new Outbox(deps(dir, log));
  const again = await next.submit(send("m-1", "a report"));
  assert.equal(again.outbox.state, "delivered");
  assert.equal(again.outbox.text, "a report");
  assert.ok(log.some(line => line.includes("skip") && line.includes(".done.json")));
  await next.close();
});
