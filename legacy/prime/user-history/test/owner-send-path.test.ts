// d2 on 10-27 read a follow-up to a Mac chat 1.6 to 1.8 round trips past the Mac's own turn, against 1.0 for the same prompt sent straight
// through a relay tunnel. The extra sat on the box before the prompt left: the owner's POST took the job cancel record's lock (about ten file
// steps) and the outbox wrote the entry three times before the daemon request, and each file step waited for a turn on the chat service's main
// thread, 83% busy then. These pin the send path: no lock without a cancel that holds, and an owner send's request that waits for no write.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobCancelRecord } from "../src/job-cancels.ts";
import { type Copy, Outbox, type OutboxDeps, type Stored } from "../src/outbox.ts";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owner-send-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const JOB = "01a15903-cd56-7138-b1c6-b06022221d92";
const OTHER = "01a17afc-4c01-72df-a06c-de22b0447dd0";

test("an owner send to a session no cancel holds reads the record and takes no lock", async t => {
  const dir = await tempDir(t);
  const path = join(dir, "job-cancels.json");
  await writeFile(path, JSON.stringify({ [JOB]: { by: "owner", at: 1, how: "stop" } }));
  // Another live process holds the lock, as one did here for each owner send before: the old reopen waited 3 s for it and then threw.
  await mkdir(path + ".lock");
  await writeFile(join(path + ".lock", "pid"), String(process.pid));
  const record = jobCancelRecord(path);
  const started = Date.now();
  assert.equal(await record.reopen(OTHER, 2), false);
  assert.ok(Date.now() - started < 1000, `reopen took ${Date.now() - started} ms`);
  await rm(path + ".lock", { recursive: true });
  assert.equal(await record.reopen(JOB, 3), true);
  assert.equal((await record.all())[JOB]?.reopenedAt, 3);
});

function deps(dir: string, requests: { text: string; onDisk: Stored | null }[], copies: number[] = [], copy: () => Copy = () => "absent"): OutboxDeps {
  return { dir, sendBeforeWrite: true, log: () => {}, changed: () => {}, final: () => null, sleep: () => new Promise(resolve => setImmediate(resolve)),
    copy: async (_entry, since) => { copies.push(since); return copy(); },
    deliver: async (entry, sending) => {
      await sending();
      const onDisk = await readFile(join(dir, `${entry.id}.json`), "utf8").then(text => JSON.parse(text) as Stored, () => null);
      requests.push({ text: entry.text, onDisk });
    } };
}

const send = (id: string, text: string) => ({ id, threadId: "chat-1", text, images: [], mode: "followUp" as const, fingerprint: `fp-${text}` });

test("an owner send's daemon request waits for no outbox write, and the POST still answers once the entry is on disk", async t => {
  const dir = await tempDir(t);
  const requests: { text: string; onDisk: Stored | null }[] = [];
  const outbox = new Outbox(deps(dir, requests));
  t.after(() => outbox.close());
  const accepted = await outbox.submit(send("owner-send-path-0001", "ok?"));
  assert.equal(accepted.accepted, true);
  assert.equal(JSON.parse(await readFile(join(dir, "owner-send-path-0001.json"), "utf8")).id, "owner-send-path-0001");
  await outbox.idle();
  assert.equal(requests.length, 1);
  // The request went before the write that carries its sentAt landed.
  assert.equal(requests[0]!.onDisk?.sentAt, undefined);
  await outbox.close();
  const done = JSON.parse(await readFile(join(dir, "owner-send-path-0001.json"), "utf8")) as Stored;
  assert.equal(done.state, "delivered");
});

test("an owner send read back at a start is looked for before it goes, so one that left before a crash is not sent twice", async t => {
  const dir = await tempDir(t);
  const at = Date.now() - 5000;
  const left = { ...send("owner-send-path-0002", "landed before the crash"), images: [], imageCount: 0, state: "sending", at, attempts: 1 };
  const unsent = { ...send("owner-send-path-0003", "never left"), images: [], imageCount: 0, state: "queued", at: at + 1, attempts: 0 };
  await writeFile(join(dir, `${left.id}.json`), JSON.stringify(left));
  await writeFile(join(dir, `${unsent.id}.json`), JSON.stringify(unsent));
  const requests: { text: string; onDisk: Stored | null }[] = [];
  const copies: number[] = [];
  let looked = 0;
  const outbox = new Outbox(deps(dir, requests, copies, () => looked++ === 0 ? "landed" : "absent"));
  t.after(() => outbox.close());
  await outbox.idle();
  assert.deepEqual(copies, [at, at + 1]);
  assert.deepEqual(requests.map(request => request.text), ["never left"]);
});
