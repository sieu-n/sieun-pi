// Replays the clean-room ownership trial 01a15529-d75e on 10-19. evaluate tore it down at 19:53Z: it archived the chat at 19:53:01.929Z,
// archived its job 01a1552e and dropped every wake file of the two. The service log then read "wakes: woke 01a15529 for its time" at 19:59:06Z
// and 20:09:01Z, and those wakes went to the job campaign home layout (01a15529-a2a1) of chat 01a11ba8, whose id has the same first 8 chars.
// A torn-down trial takes no wake even when one of its sessions sets it after the archive, while an owner-archived chat keeps its later wakes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox, stopRecords } from "../src/agent-outbox.ts";
import { CLEAN_ROOM_CHATS_FILE } from "../src/chat-corrections.ts";
import { IdIndex } from "../src/id-index.ts";
import { Wakes } from "../src/wakes.ts";

const TRIAL = "01a15529-d75e-77ac-9f6f-dd02a5d7e66b";
const TRIAL_JOB = "01a1552e-4166-768e-a1c2-3fdaa5730a9a";
const OWNER_CHAT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const OTHER_JOB = "01a15529-a2a1-72ac-8ee4-c6fb49cab20d";
const TORN_DOWN = Date.parse("2026-10-19T19:53:01.929Z");
const NOW = Date.parse("2026-10-19T19:59:06.828Z");
const SET = Date.parse("2026-10-19T19:58:53.968Z");
const wake = (note: string) => `[wake] It is 2026-10-19T19:59:06.828Z, the time you set with board.wake (2026-10-19T19:59:00.000Z). Your note: ${note}`;
const ARTIFACTS = "/home/sieun/.prime/agent/session-artifacts";
const FILES: Record<string, string> = {
  [TRIAL_JOB]: `${ARTIFACTS}/${TRIAL}/sub-6f716a7c/${TRIAL_JOB}.jsonl`,
  [OTHER_JOB]: `${ARTIFACTS}/01a11ba8-9d2c-727c-8ded-38f819ca9f29/sub-campaign/${OTHER_JOB}.jsonl`,
};

async function box(t: TestContext, { archived = [TRIAL, OWNER_CHAT] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "torn-down-trial-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await new IdIndex(join(dir, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index").add(TRIAL, Date.parse("2026-10-19T17:19:59.089Z"));
  for (const id of archived) await new IdIndex(join(dir, "archived-chats.json"), "Archived chat index").add(id, id === OWNER_CHAT ? Date.parse("2026-10-19T05:31:26.246Z") : TORN_DOWN);
  const sent: { session: string; text: string }[] = [];
  const lines: string[] = [];
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { lines.push(line); }, now: () => NOW, sleep: () => new Promise(resolve => setImmediate(resolve)),
    send: async (session, text) => { sent.push({ session, text }); return "sent"; },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async session => FILES[session] ?? null, stopped: stopRecords(dir),
  });
  t.after(() => outbox.close());
  const deliver = async (session: string, note: string) => { await outbox.deliver(session, wake(note), undefined, "wake", SET); await outbox.outbox.idle(); };
  return { sent, lines, deliver };
}

test("a wake the torn-down trial chat set after its teardown is dropped", async t => {
  const { sent, lines, deliver } = await box(t);
  await deliver(TRIAL, "trial chat");
  assert.deepEqual(sent, []);
  assert.ok(lines.some(line => line.includes(`obsolete, not sent: the clean-room teardown archived the test chat ${TRIAL}, and it is a wake`)), lines.join("\n"));
});

test("a wake of a job in the torn-down trial's tree is dropped, though the job is in no archive list", async t => {
  const { sent, deliver } = await box(t);
  await deliver(TRIAL_JOB, "check canary-recount-test");
  assert.deepEqual(sent, []);
});

test("a clean-room chat before its teardown and its jobs still get their wakes", async t => {
  const { sent, deliver } = await box(t, { archived: [] });
  await deliver(TRIAL, "trial chat");
  await deliver(TRIAL_JOB, "check canary-recount-test");
  assert.deepEqual(sent.map(({ session }) => session), [TRIAL, TRIAL_JOB]);
});

test("an owner-archived chat still gets the wake it set after its archive, and the job that shares the trial's id prefix gets its own", async t => {
  const { sent, deliver } = await box(t);
  await deliver(OWNER_CHAT, "pool slot");
  await deliver(OTHER_JOB, "campaign home layout");
  assert.deepEqual(sent.map(({ session }) => session), [OWNER_CHAT, OTHER_JOB]);
});

test("the wake log names the full session id, so two sessions made in the same minute read apart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "torn-down-trial-wake-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  await writeFile(join(dir, `${OTHER_JOB}-time-1792439940.json`), JSON.stringify({ session: OTHER_JOB, on: { kind: "time", at: NOW - 6828 }, note: "campaign home layout", since: SET }));
  assert.equal(await new Wakes({ dir, now: () => NOW, log: line => { lines.push(line); }, runState: async () => ({ done: false }), deliver: async () => {} }).tick(), 1);
  assert.ok(lines.some(line => line.startsWith(`wakes: woke ${OTHER_JOB} for its time`)), lines.join("\n"));
});
