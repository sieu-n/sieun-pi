import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { landedAt, SendOnce, sendKey, sessionFileOf } from "../src/send-once.ts";
import { Wakes } from "../src/wakes.ts";

// 10-16 06:38, 06:47 and 06:57Z one board.wake reached the "spawn brief lost fix" job 3 times: each send_message timed out after 30 s, the
// wake file stayed, and the next tick sent it again, though the daemon had delivered each one. These tests run the wakes against a fake slow
// daemon that queues or delivers a message and then times out.

const SESSION = "01a142f0-1111-7222-8333-944445555666";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message". Socket: /tmp/daemon.sock.';
const NOW = Date.parse("2026-10-16T06:38:00Z");

const entry = (text: string, at: number) => JSON.stringify({ type: "custom_message", customType: "agent_message", content: `[agent-message from d3b565eed6cc]\n\n${text}`,
  display: true, details: { id: `agentmsg_${at}`, message: text, from: { clientId: "d3b565eed6cc" } }, id: "e2e2d2af", parentId: "8e7ed973", timestamp: new Date(at).toISOString() }) + "\n";
const other = (at: number) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400) }], timestamp: at }, timestamp: new Date(at).toISOString() }) + "\n";

/** A daemon whose worker is `mode`: "lands" writes the message to the session file then times out, "queues" holds it then times out, "loses" times out with nothing, "ok" answers. */
async function slowDaemon() {
  const agentDir = await mkdtemp(join(tmpdir(), "send-once-"));
  const file = join(agentDir, "sessions", `${SESSION}.jsonl`);
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(file, other(NOW - 3_600_000));
  let now = NOW;
  const state = { mode: "lands" as "lands" | "closes" | "queues" | "loses" | "ok", queue: [] as string[], queueReadable: true, busy: false, sends: 0, logs: [] as string[] };
  const copies = async (): Promise<number> => (await readFile(file, "utf8")).split("\n").filter(line => line.includes('"agent_message"')).length;
  const once = new SendOnce({ file: join(agentDir, "unconfirmed-sends.json"), now: () => now, log: line => state.logs.push(line),
    send: async (_session, text) => {
      state.sends++;
      if (state.mode === "ok") { await appendFile(file, entry(text, now)); return "sent"; }
      if (state.mode === "lands") await appendFile(file, entry(text, now + 5_000));
      if (state.mode === "closes") {
        await appendFile(file, entry(text, now + 5_000));
        throw new Error("Prime Agent daemon client closed before the operation completed. Socket: /tmp/daemon.sock.");
      }
      if (state.mode === "queues") state.queue.push("Agent message received: " + text);
      throw new Error(TIMEOUT);
    },
    target: async () => state.queueReadable ? { queued: state.queue, busy: state.busy } : null,
    fileOf: session => sessionFileOf(session, agentDir) });
  const drain = async () => { for (const item of state.queue.splice(0)) await appendFile(file, entry(item.replace("Agent message received: ", ""), now)); };
  return { agentDir, file, once, state, copies, drain, at: (ms: number) => { now = ms; }, now: () => now };
}

async function wakeFixture(daemon: Awaited<ReturnType<typeof slowDaemon>>) {
  const dir = await mkdtemp(join(tmpdir(), "wakes-"));
  await writeFile(join(dir, `${SESSION}-time-1.json`), JSON.stringify({ session: SESSION, on: { kind: "time", at: NOW - 60_000 }, note: "check the spawn brief fix", since: NOW - 600_000 }));
  const wakes = new Wakes({ dir, now: daemon.now, log: () => {}, runState: async () => ({ done: false }), deliver: (session, text) => daemon.once.deliver(session, text) });
  return { wakes, files: () => readdir(dir) };
}

test("send once: a wake the slow daemon delivers and then times out on reaches the job once, and its file goes", async () => {
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "lands";
  for (let tick = 0; tick < 4; tick++) { daemon.at(NOW + tick * 30_000); await wakes.tick(); }
  assert.equal(await daemon.copies(), 1);
  assert.equal(daemon.state.sends, 1);
  assert.deepEqual(await files(), []);
});

test("send once: a wake held in a busy worker's queue is not sent again; it counts as sent once the worker writes it", async () => {
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "queues";
  for (let tick = 0; tick < 5; tick++) { daemon.at(NOW + tick * 30_000); await wakes.tick(); }
  assert.equal(daemon.state.sends, 1);
  assert.equal((await files()).length, 1);
  daemon.at(NOW + 20 * 60_000);
  await daemon.drain();
  daemon.at(NOW + 20 * 60_000 + 30_000);
  await wakes.tick();
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
  assert.deepEqual(await files(), []);
});

test("send once: an earlier copy that cannot be looked for is not sent again", async () => {
  const daemon = await slowDaemon();
  daemon.state.mode = "loses";
  await assert.rejects(daemon.once.deliver(SESSION, "[wake] hello"), /Timed out/);
  daemon.state.queueReadable = false;
  await assert.rejects(daemon.once.deliver(SESSION, "[wake] hello"), /not readable now; not sent again/);
  assert.equal(daemon.state.sends, 1);
});

test("send once: a send that is in neither the file nor the queue goes again, and only once", async () => {
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "loses";
  await wakes.tick();
  assert.equal(daemon.state.sends, 1);
  daemon.state.mode = "ok";
  daemon.at(NOW + 30_000);
  await wakes.tick();
  daemon.at(NOW + 60_000);
  await wakes.tick();
  assert.equal(daemon.state.sends, 2);
  assert.equal(await daemon.copies(), 1);
  assert.deepEqual(await files(), []);
});

test("send once: a copy in neither the file nor the queue is held while the target is busy, and sent again once it is idle and still missing", async () => {
  // 10-16 10:16Z (01a1430e) and 22:53Z (01a14312): after a run of timeouts the copy was still with the supervisor, the send that read it as
  // gone went out, and both copies landed.
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "loses";
  daemon.state.busy = true;
  for (let tick = 0; tick < 6; tick++) { daemon.at(NOW + tick * 30_000); await wakes.tick(); }
  assert.equal(daemon.state.sends, 1);
  assert.equal((await files()).length, 1);
  assert.equal(await daemon.copies(), 0);
  daemon.state.busy = false;
  daemon.state.mode = "ok";
  daemon.at(NOW + 10 * 60_000);
  await wakes.tick();
  daemon.at(NOW + 10 * 60_000 + 30_000);
  await wakes.tick();
  assert.equal(daemon.state.sends, 2);
  assert.equal(await daemon.copies(), 1);
  assert.deepEqual(await files(), []);
});

test("send once: a busy target whose held copy then lands gets no second send", async () => {
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "loses";
  daemon.state.busy = true;
  await wakes.tick();
  daemon.at(NOW + 30_000);
  await wakes.tick();
  await appendFile(daemon.file, entry("[wake] It is 2026-10-16T06:38:00.000Z, the time you set with board.wake (2026-10-16T06:37:00.000Z). Your note: check the spawn brief fix", NOW + 60_000));
  daemon.state.busy = false;
  daemon.at(NOW + 90_000);
  await wakes.tick();
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
  assert.deepEqual(await files(), []);
});

test("send once: a send whose daemon client closed mid-send counts like a timeout, so the copy that landed is not sent again", async () => {
  // 10-17 22:11Z: a wake to 01a14be9 failed with "client closed", landed at 22:11:57Z, and its resend landed again at 22:14:32Z.
  const daemon = await slowDaemon();
  const { wakes, files } = await wakeFixture(daemon);
  daemon.state.mode = "closes";
  for (let tick = 0; tick < 3; tick++) { daemon.at(NOW + tick * 30_000); await wakes.tick(); }
  assert.equal(daemon.state.sends, 1);
  assert.equal(await daemon.copies(), 1);
  assert.deepEqual(await files(), []);
});

test("send once: a send cut off by a service restart is looked for by the next service, so the copy that landed is not sent again", async () => {
  // 10-17 21:02, 21:22 and 22:45Z: a release kickstart killed the service while a wake send was out; it landed, and the new service sent it again.
  const daemon = await slowDaemon();
  const killed = new SendOnce({ file: join(daemon.agentDir, "unconfirmed-sends.json"), log: () => {}, now: daemon.now,
    send: async (_session, text) => { await appendFile(daemon.file, entry(text, daemon.now() + 2_000)); return new Promise<"sent">(() => {}); },
    target: async () => ({ queued: [], busy: false }), fileOf: session => sessionFileOf(session, daemon.agentDir) });
  void killed.deliver(SESSION, "[wake] Run 39071862302 finished: failure");
  await new Promise(resolve => setTimeout(resolve, 50));
  daemon.state.mode = "ok";
  daemon.at(NOW + 40_000);
  assert.equal(await daemon.once.deliver(SESSION, "[wake] Run 39071862302 finished: failure"), "sent");
  assert.equal(daemon.state.sends, 0);
  assert.equal(await daemon.copies(), 1);
});

test("send once: a send the daemon refuses outright leaves no record, so the next try goes at once", async () => {
  const daemon = await slowDaemon();
  const refusing = new SendOnce({ file: join(daemon.agentDir, "unconfirmed-sends.json"), log: () => {}, now: daemon.now,
    send: async () => { throw new Error("Target session has too many pending messages: 20 unfinished, limit is 20"); },
    target: async () => null, fileOf: session => sessionFileOf(session, daemon.agentDir) });
  await assert.rejects(refusing.deliver(SESSION, "[wake] hi"), /too many pending/);
  daemon.state.mode = "ok";
  assert.equal(await daemon.once.deliver(SESSION, "[wake] hi"), "sent");
  assert.equal(daemon.state.sends, 1);
});

test("send once: the record of a timed-out send outlives a service restart", async () => {
  const daemon = await slowDaemon();
  daemon.state.mode = "queues";
  await assert.rejects(daemon.once.deliver(SESSION, "[alert] backup older than 26h"), /Timed out/);
  await daemon.drain();
  const restarted = new SendOnce({ file: join(daemon.agentDir, "unconfirmed-sends.json"), log: () => {}, now: daemon.now,
    send: async () => { throw new Error("sent again"); }, target: async () => ({ queued: [], busy: false }), fileOf: session => sessionFileOf(session, daemon.agentDir) });
  assert.equal(await restarted.deliver(SESSION, "[alert] backup older than 26h"), "sent");
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
