// Replays the release hand-over at 21:21Z on 11-08 on us-metal02. The running chat started its successor at 21:21:08.715Z, and a duty create it
// had under way, "crawler api and mcp Crawler VP 06:20", met the hand-over fence: service.log read "daemon create crawler api and mcp Crawler VP
// 06:20: refused in 2.1 s: This chat process handed over to its successor and only reads.", d7 counted the minute dirty though no call left the
// process, and the successor started the job 45 s later. A worker start the hand-over stops now sends nothing, logs no daemon fault, and leaves
// the duty's pending start to the successor.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import { HANDED_OVER_REASON, handedOverAnswer, timedWorkerStart } from "../src/daemon-worker-start.ts";
import type { Duty } from "../src/shared/chat-duties.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NAME = "crawler api and mcp Crawler VP 06:20";
const NOW = Date.parse("2026-11-08T21:20:27.813Z");

test("a worker start the hand-over stopped logs a line d7 does not count, while a daemon refusal still counts", async () => {
  const lines: string[] = [];
  let now = Date.parse("2026-11-08T21:21:09.873Z");
  await timedWorkerStart(`create ${NAME}`, async () => { now += 2_100; return handedOverAnswer(); }, line => { lines.push(line); }, () => now);
  assert.deepEqual(lines, [`2026-11-08T21:21:09.873Z daemon create ${NAME}: not sent, ${HANDED_OVER_REASON}`]);
  const refused = "2026-11-08T21:21:09.873Z daemon create check-in chat-057a 15:32: refused in 0.1 s: Session worker is failed";
  // The line the hand-over of a release before this fix writes, as at 21:21Z on 11-08: the release that ships the fix hands over from one.
  const before = `2026-11-08T21:21:09.873Z daemon create ${NAME}: refused in 2.1 s: ${HANDED_OVER_REASON}`;
  assert.deepEqual(readServiceFaults([...lines, before, refused], "us-metal02").map(fault => fault.title), ["check-in chat-057a 15:32"]);
});

test("a create after the hub quiesced for a hand-over sends no daemon command and fails with the hand-over's reason", async () => {
  const sent: string[] = [];
  const client = { request: async (command: { type: string }) => { sent.push(command.type); return { success: true, data: { sessionId: "s", activeSessionId: "a" } }; } };
  const catalog = { connect: async () => {}, client, hostOf: () => null, isOtherHost: () => false } as unknown as Catalog;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), (async () => undefined) as never);
  threads.quiesce();
  await assert.rejects(threads.create({ cwd: "/repo", name: NAME }), error => error instanceof Error && error.message === HANDED_OVER_REASON);
  assert.deepEqual(sent, []);
});

test("a duty start whose create the hand-over stopped neither retries nor waits for a session", async () => {
  let creates = 0, slept = 0;
  const host = dutyJobHost({
    threads: { create: async () => { creates++; throw new Error(HANDED_OVER_REASON); }, prompt: async () => {} },
    archives: { add: async () => {} }, rows: async () => [],
    registry: { add: async () => {}, chatOf: async () => undefined, chatIdOf: async () => undefined, rootsOf: async () => [], remove: async () => {} },
    board: id => id, sleep: async () => { slept++; } });
  await assert.rejects(host.start({ id: CHAT, name: "Crawler VP", cwd: "/repo", board: CHAT }, NAME, "brief", NOW), new RegExp(HANDED_OVER_REASON.replace(/\./g, "\\.")));
  assert.deepEqual([creates, slept], [1, 0]);
});

test("a duty run whose job start the hand-over stopped keeps its pending start, and the successor starts the job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-duty-start-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { gaps: 2 } }));`);
    const store = new DutyStore(dir);
    const duty: Duty = {
      id: "d6", name: "crawler api and mcp", ownerWords: "the api and mcp stay up", goal: "no gaps",
      metrics: [{ key: "gaps", label: "Gaps", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the gaps",
      status: "active", createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const started: string[] = [];
    const runner = (start: (name: string) => Promise<{ id: string; name: string }>, lines: string[]) => new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, log: line => lines.push(line),
      jobs: {
        chat: async id => ({ id, name: "Crawler VP", cwd: dir, board: id }),
        working: async () => false, retire: async () => {}, ended: async (last, older = []) => [...last, ...older], stop: async () => {},
        start: async (_chat, name) => start(name),
      },
    });
    const oldLines: string[] = [];
    const old = runner(async () => { throw new Error(HANDED_OVER_REASON); }, oldLines);
    await old.tick();
    await old.settled();
    old.close();
    assert.ok(existsSync(join(store.chatDir(CHAT), "d6.pending.json")), "the pending start stays for the successor");
    const [kept] = (await store.runs(CHAT)).filter(entry => entry.duty === "d6");
    assert.equal(kept?.job, undefined);
    assert.doesNotMatch(kept?.summary ?? "", /not started/i);
    assert.ok(oldLines.some(line => line.includes("this chat handed over before the job of the run of") && line.endsWith("its successor starts it")), oldLines.join("\n"));

    const next = runner(async name => { started.push(name); return { id: `job-${name}`, name }; }, []);
    await next.tick();
    await next.settled();
    next.close();
    assert.equal(started.length, 1);
    assert.equal((await store.runs(CHAT)).find(entry => entry.duty === "d6" && entry.at === kept?.at)?.job?.name, started[0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a hand-over waits for a duty job start whose create went out, so its session, brief and record land before the fence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-duty-inflight-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { gaps: 2 } }));`);
    const store = new DutyStore(dir);
    await store.update(CHAT, duties => { duties.push({
      id: "d6", name: "crawler api and mcp", ownerWords: "the api and mcp stay up", goal: "no gaps",
      metrics: [{ key: "gaps", label: "Gaps", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the gaps",
      status: "active", createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, runCount: 0,
    }); });
    let answer: () => void = () => {};
    let sent: () => void = () => {};
    const out = new Promise<void>(resolve => { sent = resolve; });
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, log: () => {},
      jobs: {
        chat: async id => ({ id, name: "Crawler VP", cwd: dir, board: id }),
        working: async () => false, retire: async () => {}, ended: async (last, older = []) => [...last, ...older], stop: async () => {},
        start: async (_chat, name) => { sent(); await new Promise<void>(resolve => { answer = resolve; }); return { id: "01a1bd0a-0b96-7599-adf7-93525f41b9e4", name }; },
      },
    });
    void duties.tick();
    await out;
    let quiet = false;
    const quiesced = duties.quiesce().then(() => { quiet = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(quiet, false, "the hand-over waits while the create is out");
    answer();
    await quiesced;
    assert.equal((await store.runs(CHAT)).find(entry => entry.duty === "d6")?.job?.id, "01a1bd0a-0b96-7599-adf7-93525f41b9e4");
    assert.equal(existsSync(join(store.chatDir(CHAT), "d6.pending.json")), false);
    await duties.settled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// At 21:55:14Z on 11-08 the hand-over from release-2d2bac4 fenced a d6 run of chat 01a1180e as it measured, the run's rm of d6.measuring.json
// failed with EACCES, its rejection went unhandled, and the process exited 40 ms after its fence, so the release restarted the chat instead.
test("a duty run whose measuring file the fence keeps ends with a log line, not a rejection that ends the process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-duty-measuring-"));
  const store = new DutyStore(dir);
  const chatDir = store.chatDir(CHAT);
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { chmodSync, writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { gaps: 0 } })); chmodSync(${JSON.stringify(chatDir)}, 0o500);`);
    await store.update(CHAT, duties => { duties.push({
      id: "d6", name: "crawler api and mcp", ownerWords: "the api and mcp stay up", goal: "no gaps",
      metrics: [{ key: "gaps", label: "Gaps", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the gaps",
      status: "active", createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, runCount: 0,
    }); });
    const lines: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, log: line => lines.push(line),
      jobs: {
        chat: async id => ({ id, name: "Crawler VP", cwd: dir, board: id }),
        working: async () => false, retire: async () => {}, ended: async (last, older = []) => [...last, ...older], stop: async () => {},
        start: async (_chat, name) => ({ id: "job", name }),
      },
    });
    await duties.tick();
    await duties.settled();
    assert.ok(lines.some(line => line.startsWith(`duty ${CHAT.slice(0, 8)}/d6: clear d6.measuring.json: EACCES`)), lines.join("\n"));
  } finally { await chmod(chatDir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
