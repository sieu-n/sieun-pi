// Guards the retry doubles of the 10-22 scratch load test (~/work/prime-under-load/LOAD.md): a send_message that timed out on the client still
// ran in the daemon, and the retry, sent with a new command id, ran again, so the target's model read it twice. The outbox looked for a copy
// first, but a copy the supervisor still held was in neither the target's file nor its queue: of 209 sends that timed out at 30 s from 10-19 to
// 10-22 it sent 69 again with no copy found. Each retry now goes with the command id of the try whose answer never came, on disk with the entry.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { WriteUncertain, type WriteSlot } from "../src/daemon-write.ts";
import { noticeOutbox } from "../src/notice-outbox.ts";

const TARGET = "01a17acc-82fa-7095-9a6b-1bf196c98562";
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message".';
const tick = () => new Promise<void>(done => setImmediate(done));
/** Waits until `done` reads true, at most 5 s. */
async function until(done: () => Promise<boolean> | boolean): Promise<void> {
  for (const end = Date.now() + 5_000; Date.now() < end && !await done();) await new Promise(next => setTimeout(next, 5));
}

/** A daemon journal as Prime keeps it: a command id it took answers its stored result and runs nothing; a new one runs. */
function journal() {
  const ran: string[] = [];
  const seen = new Map<string, "sent">();
  let first = true;
  return {
    ran,
    /** The first send runs and its answer never comes back; later sends answer at once. */
    write: (text: string, write?: WriteSlot): "sent" => {
      const id = write?.id;
      if (id && seen.has(id)) { delete write!.id; return seen.get(id)!; }
      ran.push(text);
      if (id) seen.set(id, "sent");
      if (first) { first = false; throw new Error(TIMEOUT); }
      if (write) delete write.id;
      return "sent";
    },
  };
}

test("an agent message whose send timed out goes again under its command id, so the daemon runs it once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keyed-retry-"));
  const daemon = journal();
  const outbox = new AgentOutbox(dir, {
    log: () => {},
    send: async (_session, text, _host, write) => daemon.write(text, write),
    // The copy is still with the supervisor: not in the target's file, not in its idle worker's queue.
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => null,
    sleep: tick,
  });
  await outbox.deliver(TARGET, "check the d7 minutes again");
  await until(async () => !(await outbox.outbox.waiting(TARGET)).length);
  await outbox.close();
  assert.deepEqual(daemon.ran, ["check the d7 minutes again"]);
});

test("a notice whose prompt timed out keeps its command id on disk, and the next service start sends it under that id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keyed-notice-"));
  const daemon = journal();
  const threads = {
    prompt: async (_id: string, input: { message: string; sending?: () => Promise<void>; write?: WriteSlot }) => { await input.sending?.(); daemon.write(input.message, input.write); },
    copyOf: async () => "absent" as const,
  };
  let wake = () => {};
  const before = noticeOutbox(dir, threads as never, () => {}, { sleep: () => new Promise<void>(done => { wake = done; }) });
  await before.send(TARGET, "[check-in] the board has 2 open steps");
  await until(() => daemon.ran.length > 0);
  const closing = before.close();
  wake();
  await closing;
  const after = noticeOutbox(dir, threads as never, () => {}, { sleep: tick });
  await until(async () => !(await after.outbox.waiting(TARGET)).length);
  await after.close();
  assert.deepEqual(daemon.ran, ["[check-in] the board has 2 open steps"]);
});

test("a resend the daemon answers uncertain, while the first send still runs, keeps its command id for the try after it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keyed-uncertain-"));
  const ran: string[] = [];
  const ids: (string | undefined)[] = [];
  let tries = 0;
  const outbox = new AgentOutbox(dir, {
    log: () => {},
    send: async (_session, text, _host, write) => {
      ids.push(write?.id);
      tries++;
      if (tries === 1) { ran.push(text); throw new Error(TIMEOUT); }
      if (tries === 2) throw new WriteUncertain("The previous command result is uncertain and was not replayed");
      delete write!.id;
      return "sent";
    },
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => null,
    sleep: tick,
  });
  await outbox.deliver(TARGET, "the release is out");
  await until(async () => !(await outbox.outbox.waiting(TARGET)).length);
  await outbox.close();
  assert.equal(ids.length, 3);
  assert.ok(ids[0] && ids.every(id => id === ids[0]), ids.join(", "));
  assert.deepEqual(ran, ["the release is out"]);
});
