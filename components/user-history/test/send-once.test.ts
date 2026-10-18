// Guards the 10-15/16 incident: resends after daemon timeouts made 137 extra wake copies, and one Grafana alert reached its owner 11 times.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { landedAt, sendKey, sessionFileOf } from "../src/send-once.ts";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { Wakes } from "../src/wakes.ts";

// 10-16 06:38, 06:47 and 06:57Z one board.wake reached the "spawn brief lost fix" job 3 times: each send_message timed out after 30 s, the
// wake file stayed, and the next tick sent it again, though the daemon had delivered each one. These tests run the agent outbox
// (src/agent-outbox.ts) against a fake slow daemon that queues or delivers a message and then times out.

const SESSION = "01a142f0-1111-7222-8333-944445555666";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message". Socket: /tmp/daemon.sock.';
const NOW = Date.parse("2026-10-16T06:38:00Z");

const entry = (text: string, at: number) => JSON.stringify({ type: "custom_message", customType: "agent_message", content: `[agent-message from d3b565eed6cc]\n\n${text}`,
  display: true, details: { id: `agentmsg_${at}`, message: text, from: { clientId: "d3b565eed6cc" } }, id: "e2e2d2af", parentId: "8e7ed973", timestamp: new Date(at).toISOString() }) + "\n";
const other = (at: number) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400) }], timestamp: at }, timestamp: new Date(at).toISOString() }) + "\n";

/** A daemon whose worker is `mode`: "lands" writes the message to the session file then times out, "queues" holds it then times out, "loses" times out with nothing, "ok" answers. */
async function slowDaemon(agentDir?: string) {
  agentDir ??= await mkdtemp(join(tmpdir(), "send-once-"));
  const file = join(agentDir, "sessions", `${SESSION}.jsonl`);
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(file, other(NOW - 3_600_000));
  let now = NOW;
  const state = { mode: "lands" as "lands" | "closes" | "queues" | "loses" | "refuses" | "hangs" | "ok", queue: [] as string[], queueReadable: true, busy: false, sends: 0, looks: 0, waits: 0 };
  const copies = async (): Promise<number> => (await readFile(file, "utf8")).split("\n").filter(line => line.includes('"agent_message"')).length;
  let release: (error: Error) => void = () => {};
  const open = () => new AgentOutbox(join(agentDir, "agent-outbox"), { now: () => now, log: () => {},
    sleep: () => { state.waits++; now += 1_000; return new Promise(done => setImmediate(done)); },
    send: async (_session, text) => {
      state.sends++;
      if (state.mode === "ok") { await appendFile(file, entry(text, now)); return "sent"; }
      if (state.mode === "hangs") return new Promise((_resolve, reject) => { release = reject; });
      if (state.mode === "refuses") throw new Error("Target session has too many pending messages: 20 unfinished, limit is 20");
      if (state.mode === "lands") await appendFile(file, entry(text, now + 5_000));
      if (state.mode === "closes") {
        await appendFile(file, entry(text, now + 5_000));
        throw new Error("Prime Agent daemon client closed before the operation completed. Socket: /tmp/daemon.sock.");
      }
      if (state.mode === "queues") state.queue.push("Agent message received: " + text);
      throw new Error(TIMEOUT);
    },
    target: async () => { state.looks++; return state.queueReadable ? { queued: state.queue, busy: state.busy } : null; },
    fileOf: session => sessionFileOf(session, agentDir) });
  const drain = async () => { for (const item of state.queue.splice(0)) await appendFile(file, entry(item.replace("Agent message received: ", ""), now)); };
  return { agentDir, file, open, state, copies, drain, release: (error: Error) => release(error), now: () => now };
}

async function until(check: () => boolean | Promise<boolean>) { while (!await check()) await new Promise(done => setImmediate(done)); }

async function wakeFixture(t: TestContext, daemon: Awaited<ReturnType<typeof slowDaemon>>) {
  const dir = await mkdtemp(join(tmpdir(), "wakes-"));
  await writeFile(join(dir, `${SESSION}-time-1.json`), JSON.stringify({ session: SESSION, on: { kind: "time", at: NOW - 60_000 }, note: "check the spawn brief fix", since: NOW - 600_000 }));
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  const wakes = new Wakes({ dir, now: daemon.now, log: () => {}, runState: async () => ({ done: false }), deliver: (session, text) => messages.deliver(session, text) });
  return { wakes, messages, files: () => readdir(dir) };
}

test("send once: a wake goes to the outbox in one tick and its file goes; the slow daemon that delivers and then times out gets it once", async t => {
  const daemon = await slowDaemon();
  const { wakes, messages, files } = await wakeFixture(t, daemon);
  daemon.state.mode = "lands";
  assert.equal(await wakes.tick(), 1);
  assert.deepEqual(await files(), []);
  await messages.outbox.idle();
  assert.equal(await daemon.copies(), 1);
  assert.equal(daemon.state.sends, 1);
});

test("send once: a message held in a busy worker's queue is not sent again", async t => {
  const daemon = await slowDaemon();
  const { wakes, messages } = await wakeFixture(t, daemon);
  daemon.state.mode = "queues";
  await wakes.tick();
  await messages.outbox.idle();
  assert.equal(daemon.state.sends, 1);
  await daemon.drain();
  assert.equal(await daemon.copies(), 1);
});

test("send once: a copy that cannot be looked for is not sent again until the daemon answers", async t => {
  const daemon = await slowDaemon();
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  daemon.state.mode = "loses";
  daemon.state.queueReadable = false;
  await messages.deliver(SESSION, "[wake] hello");
  await until(() => daemon.state.looks >= 5);
  assert.equal(daemon.state.sends, 1);
  daemon.state.mode = "ok";
  daemon.state.queueReadable = true;
  await messages.outbox.idle();
  assert.equal(daemon.state.sends, 2);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a copy in neither the file nor the queue is held while the target is busy, and sent again once it is idle and still missing", async t => {
  // 10-16 10:16Z (01a1430e) and 22:53Z (01a14312): after a run of timeouts the copy was still with the supervisor, the send that read it as
  // gone went out, and both copies landed.
  const daemon = await slowDaemon();
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  daemon.state.mode = "loses";
  daemon.state.busy = true;
  await messages.deliver(SESSION, "[wake] hello");
  await until(() => daemon.state.looks >= 5);
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 0);
  daemon.state.busy = false;
  daemon.state.mode = "ok";
  await messages.outbox.idle();
  assert.equal(daemon.state.sends, 2);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a busy target whose held copy then lands gets no second send", async t => {
  const daemon = await slowDaemon();
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  daemon.state.mode = "loses";
  daemon.state.busy = true;
  await messages.deliver(SESSION, "[wake] hello");
  await until(() => daemon.state.looks >= 3);
  await appendFile(daemon.file, entry("[wake] hello", daemon.now()));
  await messages.outbox.idle();
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a send whose daemon client closed mid-send counts like a timeout, so the copy that landed is not sent again", async t => {
  // 10-17 22:11Z: a wake to 01a14be9 failed with "client closed", landed at 22:11:57Z, and its resend landed again at 22:14:32Z.
  const daemon = await slowDaemon();
  const { wakes, messages } = await wakeFixture(t, daemon);
  daemon.state.mode = "closes";
  await wakes.tick();
  await messages.outbox.idle();
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a send cut off by a service restart is looked for by the next service, so the copy that landed is not sent again", async t => {
  // 10-17 21:02, 21:22 and 22:45Z: a release kickstart killed the service while a wake send was out; it landed, and the new service sent it again.
  const daemon = await slowDaemon();
  daemon.state.mode = "hangs";
  const killed = daemon.open();
  await killed.deliver(SESSION, "[wake] Run 39071862302 finished: failure");
  await until(() => daemon.state.sends === 1);
  await appendFile(daemon.file, entry("[wake] Run 39071862302 finished: failure", daemon.now() + 2_000));
  await killed.outbox.close();
  daemon.state.mode = "ok";
  const next = daemon.open();
  t.after(() => next.outbox.close());
  await next.outbox.idle();
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a send the daemon refuses outright is sent again with no look", async t => {
  const daemon = await slowDaemon();
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  daemon.state.mode = "refuses";
  daemon.state.busy = true;
  await messages.deliver(SESSION, "[wake] hi");
  await until(() => daemon.state.sends >= 3);
  daemon.state.mode = "ok";
  await messages.outbox.idle();
  assert.equal(daemon.state.looks, 0, "a refusal cannot have landed, so the busy target is not asked");
  assert.equal(await daemon.copies(), 1);
});

test("send once: a wake rewritten with a new time while its first copy waits is the same message", async t => {
  const daemon = await slowDaemon();
  const messages = daemon.open();
  t.after(() => messages.outbox.close());
  daemon.state.mode = "loses";
  daemon.state.queueReadable = false;
  await messages.deliver(SESSION, "[wake] It is 2026-10-16T06:38:12.001Z, the time you set.");
  await messages.deliver(SESSION, "[wake] It is 2026-10-16T06:47:40.552Z, the time you set.");
  daemon.state.mode = "ok";
  daemon.state.queueReadable = true;
  await messages.outbox.idle();
  assert.equal(await daemon.copies(), 1);
});

// 10-18 06:33:00Z: a release closed the chat service's daemon link while a relay of 01a142eb's wake was out. The daemon refused that send at
// 06:33:02Z (pending limit), but the record read it as possibly held, and the wake sat behind "the target is busy" until 06:43Z.
test("send once: close waits for a send that is out, so a refusal it gets during a service stop is sent again at once by the next service", async () => {
  const daemon = await slowDaemon();
  daemon.state.mode = "hangs";
  daemon.state.busy = true;
  const old = daemon.open();
  await old.deliver(SESSION, "[wake] It is 06:30Z, the time you set.");
  await until(() => daemon.state.sends === 1);
  let closed = false;
  const closing = old.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false, "the stop waits while the send is out");
  daemon.release(new Error("Target session has too many pending messages: 20 unfinished, limit is 20"));
  await closing;
  daemon.state.mode = "ok";
  const next = daemon.open();
  await next.outbox.idle();
  await next.close();
  assert.equal(daemon.state.looks, 0, "the next service sends though the target is busy");
  assert.equal(daemon.state.sends, 2);
  assert.equal(await daemon.copies(), 1);
});

test("send once: the key drops ISO times and a (possible duplicate) opener, so a wake rewritten on each tick is one send", () => {
  assert.equal(sendKey(SESSION, "[wake] It is 2026-10-16T06:38:12.001Z, the time you set (2026-10-16T06:30:00.000Z)."),
    sendKey(SESSION, "(possible duplicate) [wake] It is 2026-10-16T06:47:40.552Z, the time you set (2026-10-16T06:30:00.000Z)."));
  assert.notEqual(sendKey(SESSION, "[wake] run 1 finished"), sendKey(SESSION, "[wake] run 2 finished"));
});

test("send once: landedAt reads a big file backward across 1 MiB steps and stops before `since`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "landed-"));
  const file = join(dir, "s.jsonl");
  let body = entry("old copy", NOW - 7_200_000);
  for (let i = 0; i < 6_000; i++) body += other(NOW - 3_600_000 + i);
  body += entry("the wake", NOW + 1_000);
  for (let i = 0; i < 4_000; i++) body += other(NOW + 2_000 + i);
  await writeFile(file, body);
  assert.ok(body.length > 3 * (1 << 20));
  assert.equal(await landedAt(file, ["the wake"], NOW), NOW + 1_000);
  assert.equal(await landedAt(file, ["old copy"], NOW), null);
  assert.equal(await landedAt(file, ["old copy"], NOW - 7_300_000), NOW - 7_200_000);
});

test("send once: a child's session file is found under session-artifacts", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const folder = join(agentDir, "session-artifacts", "01a1164b-root", "sub-b7b3801d", "sub-0000aaaa");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${SESSION}.jsonl`), "");
  assert.equal(await sessionFileOf(SESSION, agentDir), join(folder, `${SESSION}.jsonl`));
  assert.equal(await sessionFileOf("01a1ffff-0000-7000-8000-000000000000", agentDir), null);
});

