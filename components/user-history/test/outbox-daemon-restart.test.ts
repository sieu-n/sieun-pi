// Guards the 10-18 08:16Z failure: the owner's send bounced with 'Timed out after 30000ms waiting for the Prime Agent daemon response to
// "attach"' while the chat's worker hung and reset. The outbox keeps the send on disk and delivers it once through daemon restarts,
// service restarts and resends of the same request id.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Copy, Outbox, OutboxConflict, type OutboxDeps, type Stored } from "../src/outbox.ts";
import type { OutboxEntry } from "../src/shared/outbox.ts";

/** A fake daemon session: what landed in its file, and a script of answers for its next prompts. */
function fakeDaemon() {
  const landed: { text: string; at: number }[] = [];
  const script: (() => Promise<void>)[] = [];
  let prompts = 0;
  let copy: (() => Copy) | null = null;
  return {
    landed, script,
    get prompts() { return prompts; },
    holdCopy(answer: (() => Copy) | null) { copy = answer; },
    deps(dir: string, pushes: OutboxEntry[][] = [], log: string[] = []): OutboxDeps {
      return { dir, log: line => { log.push(line); },
        sleep: () => new Promise(resolve => setImmediate(resolve)),
        deliver: async (entry: Stored, sending) => {
          await sending();
          prompts++;
          const next = script.shift();
          if (next) await next();
          landed.push({ text: entry.text, at: Date.now() });
        },
        copy: async (entry, since) => copy?.() ?? (landed.some(item => item.text === entry.text && item.at >= since) ? "landed" : "absent"),
        final: error => error instanceof Error && error.message.startsWith("final:") ? error.message.slice(6) : null,
        changed: (_id, outbox, left) => { pushes.push(left ? [...outbox, left] : outbox); },
      };
    },
  };
}

const send = (id: string, text = "did you miss?") => ({ id, threadId: "chat-1", text, images: [], mode: "steer" as const, fingerprint: `fp-${text}` });

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a send made while the daemon restarts arrives once: refusals, then a timeout that landed, then nothing more", async t => {
  const dir = await tempDir(t);
  const daemon = fakeDaemon();
  const fail = (message: string) => async () => { throw new Error(message); };
  daemon.script.push(fail("Daemon is preparing an update restart"), fail("Cannot send daemon command \"prompt\" because the Prime Agent daemon is not connected."),
    fail("Session worker is stopping"), fail("Unknown active session: 1f513af6c1be"),
    async () => { daemon.landed.push({ text: "did you miss?", at: Date.now() }); throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "prompt".'); });
  const pushes: OutboxEntry[][] = [];
  const outbox = new Outbox(daemon.deps(dir, pushes));
  t.after(() => outbox.close());
  const accepted = await outbox.submit(send("owner-send-0001-restart"));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.outbox.state, "queued");
  await outbox.idle();
  assert.equal(daemon.landed.length, 1, "the timed-out send landed, and the outbox found it instead of sending again");
  assert.equal(daemon.prompts, 5);
  assert.deepEqual(outbox.view("chat-1"), []);
  assert.deepEqual(pushes.at(-1)?.map(entry => entry.state), ["delivered"], "the delivered entry is pushed once as it leaves");
  assert.ok(pushes.some(list => list[0]?.state === "queued" && list[0].attempts > 0), "a retry shows as queued, never as failed");
});

test("a worker that does not answer holds the resend until it does, then the send is not sent again", async t => {
  const dir = await tempDir(t);
  const daemon = fakeDaemon();
  // 10-18 07:49Z to 08:16Z the chat's worker hung on a 38 to 40 GB heap: get_state did not answer for 27 minutes.
  let looks = 0;
  daemon.script.push(async () => { daemon.landed.push({ text: "did you miss?", at: Date.now() }); throw new Error("Prime Agent daemon client closed before the operation completed."); });
  daemon.holdCopy(() => ++looks < 20 ? "unknown" : "queued");
  const outbox = new Outbox(daemon.deps(dir));
  t.after(() => outbox.close());
  await outbox.submit(send("owner-send-0002-hung-worker"));
  await outbox.idle();
  assert.equal(looks, 20);
  assert.equal(daemon.prompts, 1);
  assert.equal(daemon.landed.length, 1);
});

test("a service restart in the middle of a send resumes from disk and delivers once", async t => {
  for (const landedBeforeRestart of [true, false]) {
    const dir = await tempDir(t);
    const daemon = fakeDaemon();
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    // The first service's prompt is out when the service stops; it either reached the daemon or not.
    daemon.script.push(() => { started(); if (landedBeforeRestart) daemon.landed.push({ text: "did you miss?", at: Date.now() }); return new Promise((_resolve, reject) => { release = () => reject(new Error("abandoned")); }); });
    const first = new Outbox(daemon.deps(dir));
    await first.submit(send("owner-send-0003-restart"));
    await first.submit(send("owner-send-0004-restart", "and the next one"));
    await sending;
    await first.close();
    const second = new Outbox(daemon.deps(dir));
    t.after(() => second.close());
    await second.idle();
    assert.deepEqual(daemon.landed.map(item => item.text), ["did you miss?", "and the next one"], `landed before the restart: ${landedBeforeRestart}`);
    assert.equal(daemon.prompts, landedBeforeRestart ? 2 : 3);
    assert.deepEqual(second.view("chat-1"), []);
    release();
  }
});

test("one request id submitted twice at once, again after delivery and after a restart, sends once", async t => {
  const dir = await tempDir(t);
  const daemon = fakeDaemon();
  const outbox = new Outbox(daemon.deps(dir));
  const [a, b] = await Promise.all([outbox.submit(send("owner-send-0005-twice")), outbox.submit(send("owner-send-0005-twice"))]);
  assert.equal(a.outbox.id, b.outbox.id);
  await outbox.idle();
  assert.equal((await outbox.submit(send("owner-send-0005-twice"))).outbox.state, "delivered");
  await assert.rejects(outbox.submit(send("owner-send-0005-twice", "other words")), OutboxConflict);
  await outbox.close();
  const later = new Outbox(daemon.deps(dir));
  t.after(() => later.close());
  assert.equal((await later.submit(send("owner-send-0005-twice"))).outbox.state, "delivered");
  await later.idle();
  assert.equal(daemon.prompts, 1);
  assert.equal(daemon.landed.length, 1);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp")), []);
});

test("a final error fails the entry with plain words and the next send in the thread still goes, in order", async t => {
  const dir = await tempDir(t);
  const daemon = fakeDaemon();
  daemon.script.push(async () => { throw new Error("final:Unknown slash command. The draft was kept."); }, async () => { throw new Error("Session worker is stopping"); });
  const outbox = new Outbox(daemon.deps(dir));
  t.after(() => outbox.close());
  await outbox.submit(send("owner-send-0006-final", "/nope"));
  await outbox.submit(send("owner-send-0007-after", "second"));
  await outbox.submit(send("owner-send-0008-after", "third"));
  await outbox.idle();
  assert.deepEqual(daemon.landed.map(item => item.text), ["second", "third"]);
  assert.deepEqual(outbox.view("chat-1").map(entry => [entry.id, entry.state, entry.error]), [["owner-send-0006-final", "failed", "Unknown slash command. The draft was kept."]]);
});

test("delivered entries go after the keep time", async t => {
  const dir = await tempDir(t);
  const daemon = fakeDaemon();
  let now = Date.now();
  const outbox = new Outbox({ ...daemon.deps(dir), now: () => now, keepMs: 1000 });
  await outbox.submit(send("owner-send-0009-old"));
  await outbox.idle();
  now += 5000;
  await outbox.submit(send("owner-send-0010-new", "new"));
  await outbox.idle();
  await outbox.close();
  assert.deepEqual((await readdir(dir)).sort(), ["owner-send-0010-new.json"]);
});
