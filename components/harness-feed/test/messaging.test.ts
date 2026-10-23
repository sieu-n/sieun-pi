import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context, Sample } from "../otlp.ts";
import { addTurnLines, daemonRefusal, dropReason, kindOf, newLines, newTurns, outboxRefusal, read, readAt, refusalReason } from "../readers/messaging.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/messaging/home", import.meta.url));
const NOW = 1792430000000;
const SECOND = 1_000;
const MINUTE = 60_000;
const ROOT = "01a10000-1111-7000-8000-000000000001";
const S1 = "01a10000-2222-7000-8000-000000000002";
const S2 = "01a10000-3333-7000-8000-000000000003";
const S4 = "01a10000-4444-7000-8000-000000000004";
const S5 = "01a10000-5555-7000-8000-000000000005";
const S7 = "01a10000-7777-7000-8000-000000000007";
const S8 = "01a1aaaa-8888-7000-8000-000000000008";
const OUTBOX = ".prime/agent/browser-chat/agent-outbox";

delete process.env.PI_POOL_DIR;
const context = (home: string, state: Map<string, unknown>, now: number, chatHost = true): Context => ({ home, host: "us-metal02", platform: "linux", now, chatHost, state });
const pick = (samples: Sample[], name: string, labels: Record<string, string> = {}) =>
  samples.filter(s => s.name === name && Object.entries(labels).every(([key, value]) => s.labels?.[key] === value));
const value = (samples: Sample[], name: string, labels: Record<string, string> = {}) => {
  const found = pick(samples, name, labels);
  assert.equal(found.length, 1, `${name} ${JSON.stringify(labels)} matched ${found.length} samples`);
  return found[0]!.value;
};
/** pi-pool's own stamp: local time, whole seconds, no offset (pool/base.py `log`). */
const localTs = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const poolLine = (at: number, event: string, session: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: localTs(at), event, session, ...event === "turn_admitted" ? { tree: ROOT, kind: "slot", waited_s: 0.0 } : {}, ...extra }) + "\n";
const entry = (id: string, thread: string, text: string, state: string, at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, threadId: thread, text, images: [], mode: "steer", fingerprint: `${thread}\n${id}`, kind: "message", root: ROOT, state, at, attempts: 1, imageCount: 0, ...extra });
const daemonLine = (component: string, msg: string) =>
  JSON.stringify({ socketPath: "/tmp/prime-agent-1001/daemon.sock", ts: "2026-10-19T17:14:00.000Z", level: "warn", component, msg, pid: 1, mode: "daemon" }) + "\n";

/** Lets the outbox watchers take the writes the test just made, as 30 s between the feed's rounds do. */
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

/** An outbox write as outbox.ts `save` makes it: a temp file renamed over the entry, which moves the folder's mtime. */
const put = (file: string, text: string): void => { writeFileSync(`${file}.1.tmp`, text); renameSync(`${file}.1.tmp`, file); };

/** A copy of the fixture home with a pi-pool.log written in this machine's local time. */
function scratch(): string {
  const home = mkdtempSync(join(tmpdir(), "messaging-"));
  cpSync(FIXTURE, home, { recursive: true });
  mkdirSync(join(home, ".config/pi-pool"), { recursive: true });
  writeFileSync(join(home, ".config/pi-pool/pi-pool.log"), [
    poolLine(NOW - 60 * MINUTE, "turn_admitted", ROOT), poolLine(NOW - 55 * MINUTE, "turn_released", ROOT, { kind: "slot", held_s: 300 }),
    poolLine(NOW - 30 * MINUTE, "turn_admitted", S1), poolLine(NOW - 25 * MINUTE, "turn_released", S1, { kind: "slot", held_s: 300 }),
    poolLine(NOW - 20 * MINUTE, "turn_admitted", S5),
    JSON.stringify({ ts: localTs(NOW - 10 * MINUTE), event: "parked", provider: "anthropic", session: S1, account: "a@b" }) + "\n",
    poolLine(NOW - 9 * MINUTE, "turn_admitted", S1),
  ].join(""));
  return home;
}

test("kindOf names a message by its sender's opener, and a held send by who sent it", () => {
  assert.equal(kindOf("[wake] Run 1 finished: success."), "wake");
  assert.equal(kindOf("[message from your job a (b), held in the chat service's outbox while this session's queue was full; answer]\n\nhi"), "report");
  assert.equal(kindOf("[message from your parent a (b), held in the chat service's outbox while this session's queue was full; answer]\n\nhi"), "parent message");
  assert.equal(kindOf("[message from sibling a (b), held in the chat service's outbox while this session's queue was full; answer]\n\nhi"), "sibling message");
  assert.equal(kindOf("[hung call] Your tool call ran 31 min"), "hung call");
  assert.equal(kindOf("[relay] Your subagent \"x\" (y) is stopped"), "relay");
  assert.equal(kindOf("plain"), "other");
});

test("dropReason and refusalReason sort the outbox notes and daemon errors seen on us-metal02 on 10-21 and 10-22", () => {
  assert.equal(dropReason("The daemon has no such session."), "no such session");
  assert.equal(dropReason("the owner archived the target chat, and it is a wake"), "chat archived");
  assert.equal(dropReason("The chat was archived before this message went."), "chat archived");
  assert.equal(dropReason("a wake for the same run 39 landed in the target's file at 2026-10-21T00:00:00.000Z, after it was queued"), "already landed");
  assert.equal(dropReason("the cleanup deleted the target job sub-1 at 2026-10-21T00:00:00.000Z"), "job deleted");
  assert.equal(dropReason("it is 17019 chars, over the daemon's 16384, so it goes as m-1, m-2"), "split in parts");
  assert.equal(refusalReason(" Error: Unknown active session: 01a10000-0000-7000-8000-000000000000"), "unknown session");
  assert.equal(refusalReason(" Error"), "no worker found");
  assert.equal(refusalReason(" Error: Target session has too many pending messages: 21 unfinished, limit is 20"), "pending limit");
  assert.equal(refusalReason(" Error: Session worker is starting"), "worker stopping or starting");
  assert.equal(refusalReason(" Error: Timed out connecting to daemon session worker: Error: connect ENOENT /tmp/w.sock"), "worker not reachable");
  assert.equal(refusalReason(" Error: Agent messaging cannot target the sending session"), "sent to itself");
  assert.equal(refusalReason("Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\""), "timed out after 30 s");
  assert.equal(refusalReason("Daemon is preparing an update restart"), "update restart");
  // 10-22 15:00Z to 18:54Z: 451 tries of one message to chat-057a, which the messaging panel counted as "other".
  assert.equal(outboxRefusal("2026-10-22T18:53:29.111Z outbox 01a14210: m-d12047e9-55fd-4d48-be84-1072f29204a6 try 451: No API key found for openai-codex."), "no api key");
  assert.equal(outboxRefusal("2026-10-23T05:00:00.000Z outbox 01a14210: m-d12047e9-55fd-4d48-be84-1072f29204a6 try 12: No API key found for openai-codex. " +
    "(the same failure 12 tries in a row; next try in 600 s)"), "no api key");
});

test("daemonRefusal counts the supervisor's and the worker's own lines and skips the supervisor's echo of the worker", () => {
  assert.equal(daemonRefusal(daemonLine("coding-agent.daemon-supervisor", "Supervisor command send_message failed: Error\n    at findWorker (/$bunfs/root/prime-agent:2249:80357)")), "no worker found");
  assert.equal(daemonRefusal(daemonLine("coding-agent.daemon", "daemon command \"send_message\" failed: Error: Target session has too many pending messages: 20 unfinished, limit is 20\n    at x")), "pending limit");
  assert.equal(daemonRefusal(daemonLine("coding-agent.daemon-supervisor", "Session worker 6f1c stderr: daemon command \"send_message\" failed: Error: Target session has too many pending messages: 20 unfinished, limit is 20")), null);
  assert.equal(daemonRefusal(daemonLine("coding-agent.daemon-supervisor", "Supervisor command get_state failed: Error: Session worker is stopping")), null);
});

test("outboxRefusal reads the outbox's refused tries and the waits it logs once", () => {
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z outbox 01a115e2: m-0f526ad6-3664-491f-bbe2-ffa17c0b72f1 try 3 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\""), "timed out after 30 s");
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z outbox 01a11ba8 on mac: m-0f526ad6-3664-491f-bbe2-ffa17c0b72f1 try 1: Daemon is preparing an update restart"), "update restart");
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z outbox 01a115e2: the target is full at 21 of 20 pending; m-1 and the sends after it wait until it holds fewer"), "pending limit");
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z outbox 01a11ba8 on mac: the target's worker is closing; m-1 and the sends after it wait until get_state reads it"), "worker stopping or starting");
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z outbox 01a115e2: m-1 carries 12 queued messages in one send, taking in m-2"), null);
  assert.equal(outboxRefusal("2026-10-21T20:00:00.000Z wakes: woke 01a115e2-9544-7204-b8db-8ce4d5319048 for its time"), null);
});

test("newLines starts at the end, keeps a half-written line for later, and starts over after a rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "messaging-lines-"));
  try {
    const file = join(dir, "x.log");
    writeFileSync(file, "old 1\nold 2\n");
    const kept: { offset?: number } = {};
    assert.deepEqual(await newLines(file, kept), []);
    appendFileSync(file, "new 1\nhalf");
    assert.deepEqual(await newLines(file, kept), ["new 1"]);
    appendFileSync(file, " done\n");
    assert.deepEqual(await newLines(file, kept), ["half done"]);
    writeFileSync(file, "rotated\n");
    assert.deepEqual(await newLines(file, kept), ["rotated"]);
    writeFileSync(file, "aaaa\nbbbb\n");
    assert.deepEqual(await newLines(file, {}, 6), ["bbbb"], "a read back from inside a line drops that line");
    assert.deepEqual(await newLines(file, {}, 64), ["aaaa", "bbbb"], "a read back past the start keeps the first line");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addTurnLines moves a line stamped in KST back to the hour of the lines around it, and readAt finds the run that read a message", () => {
  const turns = newTurns();
  addTurnLines(turns, [
    poolLine(NOW - 10 * MINUTE, "turn_admitted", S1).trim(),
    poolLine(NOW - 8 * MINUTE, "turn_released", S1).trim(),
    poolLine(NOW - 3 * MINUTE + 9 * 3_600_000, "turn_admitted", S2).trim(),
  ], NOW);
  assert.deepEqual(turns.starts.get(S2), [NOW - 3 * MINUTE]);
  assert.deepEqual(readAt(turns, S1, NOW - 9 * MINUTE), { via: "running turn", at: NOW - 9 * MINUTE });
  assert.equal(readAt(turns, S1, NOW - 7 * MINUTE), null);
  assert.deepEqual(readAt(turns, S2, NOW - 4 * MINUTE), { via: "next turn", at: NOW - 3 * MINUTE });
  assert.deepEqual(readAt(turns, S7, NOW), { via: "no turn record", at: NOW });
});

test("read gives the backlog, send-to-read times and bundles from the records, and counts only what happens after its first round", async () => {
  const home = scratch();
  try {
    const state = new Map<string, unknown>();
    const first = await read(context(home, state, NOW));
    assert.equal(value(first, "harness.msg.backlog_total", { part: "daemon" }), 7);
    assert.equal(value(first, "harness.msg.backlog_total", { part: "outbox" }), 2);
    assert.equal(value(first, "harness.msg.backlog_sessions"), 2);
    assert.deepEqual(pick(first, "harness.msg.backlog").map(s => [s.labels!.rank, s.labels!.name, s.labels!.session, s.labels!.host, s.value]), [
      ["1", "census seed order", S1, "us-metal02", 4],
      ["2", "convex", S4, "mac", 2],
      ["3", "census VP", ROOT, "us-metal02", 1],
      ["4", "wiki VP", S2, "us-metal02", 1],
      ["5", "frontend bro", "01a10000-6666-7000-8000-000000000006", "mac", 1],
    ]);
    assert.equal(value(first, "harness.msg.send_to_read", { outbox: "agent", via: "next turn", q: "max" }), 60);
    assert.deepEqual(["p50", "p90", "p99", "max"].map(q => value(first, "harness.msg.send_to_read", { outbox: "agent", via: "running turn", q })), [120, 180, 180, 180]);
    assert.equal(value(first, "harness.msg.send_to_read_count", { outbox: "agent", via: "running turn" }), 3);
    assert.equal(value(first, "harness.msg.send_to_read_count", { outbox: "owner", via: "no turn record" }), 1);
    assert.equal(pick(first, "harness.msg.send_to_read", { outbox: "owner" }).length, 0);
    assert.ok(pick(first, "harness.msg.sent").length > 0 && pick(first, "harness.msg.sent").every(s => s.value === 0 && s.kind === "counter"));
    assert.ok(pick(first, "harness.msg.refused").every(s => s.value === 0));
    for (const s of first) assert.doesNotMatch(JSON.stringify(s.labels ?? {}), /Done\.|please check|\/home\/|\/Users\//, "no message text or path in a label");

    // Round 2: the waiting report goes, two messages queue for an idle job, one ends as needless, and the logs gain refusals.
    const dir = join(home, OUTBOX);
    const waiting = JSON.parse(readFileSync(join(dir, "m-a6.json"), "utf8"));
    put(join(dir, "m-a6.json"), JSON.stringify({ ...waiting, state: "delivered", doneAt: NOW + 10 * SECOND }));
    put(join(dir, "m-b1.json"), entry("m-b1", S7, "[wake] It is 17:14Z, the time you set with board.wake (17:14Z)", "queued", NOW + 5 * SECOND, { kind: "wake", attempts: 0 }));
    put(join(dir, "m-b2.json"), entry("m-b2", S7, "[alert hyperdx] 2 new errors", "queued", NOW + 6 * SECOND, { attempts: 0 }));
    put(join(dir, "m-b3.json"), entry("m-b3", S5, "plain note", "obsolete", NOW + 7 * SECOND, { doneAt: NOW + 8 * SECOND, error: "the cleanup deleted the target job sub-1 at 2026-10-19T17:13:00.000Z" }));
    put(join(home, ".prime/agent/browser-chat/outbox/o3.json"), entry("o3", S2, "go", "delivered", NOW + 9 * SECOND, { doneAt: NOW + 9500, kind: undefined, root: undefined }));
    appendFileSync(join(home, ".prime/agent/browser-chat/service.log"), [
      "2026-10-19T17:13:40.000Z outbox 01a10000: m-b1 try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\"",
      "2026-10-19T17:13:41.000Z outbox 01a1aaaa: the target is full at 20 of 20 pending; m-b8 and the sends after it wait until it holds fewer",
      "2026-10-19T17:13:44.000Z outbox 01a10000: m-b1 is landed from the send at 2026-10-19T17:13:40.000Z; not sent again",
      "2026-10-19T17:13:45.000Z outbox 01a10000: queued m-b7 from census seed order (01a10000) while the target held 21 of 20 pending, 0 ahead of it here",
      "2026-10-19T17:13:42.000Z outbox 01a10000 on mac: m-b1 met the daemon's update prepare; it and the sends after it wait for it to end",
      "2026-10-19T17:13:43.000Z outbox 01a10000: m-b1 carries 2 queued messages in one send, taking in m-b2",
      ""].join("\n"));
    appendFileSync(join(home, ".prime/agent/logs/agent.jsonl"),
      daemonLine("coding-agent.daemon-supervisor", "Supervisor command send_message failed: Error: Unknown active session: 01a10000-0000-7000-8000-000000000000\n    at findWorker (x)") +
      daemonLine("coding-agent.daemon-supervisor", "Supervisor command send_message failed: Error\n    at findWorker (x)") +
      daemonLine("coding-agent.daemon", "daemon command \"send_message\" failed: Error: Target session has too many pending messages: 20 unfinished, limit is 20") +
      daemonLine("coding-agent.daemon-supervisor", "Session worker 6f1c stderr: daemon command \"send_message\" failed: Error: Target session has too many pending messages: 20 unfinished, limit is 20"));
    await settle();
    const second = await read(context(home, state, NOW + 30 * SECOND));
    assert.equal(value(second, "harness.msg.sent", { outbox: "agent", kind: "wake" }), 1);
    assert.equal(value(second, "harness.msg.sent", { outbox: "agent", kind: "alert" }), 1);
    assert.equal(value(second, "harness.msg.sent", { outbox: "agent", kind: "other" }), 1);
    assert.equal(value(second, "harness.msg.sent", { outbox: "owner", kind: "owner steer" }), 1);
    assert.equal(value(second, "harness.msg.sent", { outbox: "agent", kind: "report" }), 0);
    assert.equal(value(second, "harness.msg.delivered", { outbox: "agent", kind: "report", how: "alone" }), 1);
    assert.equal(value(second, "harness.msg.delivered", { outbox: "owner", kind: "owner steer", how: "alone" }), 1);
    assert.equal(value(second, "harness.msg.sends", { outbox: "agent", size: "1" }), 1);
    assert.equal(value(second, "harness.msg.dropped", { outbox: "agent", reason: "job deleted" }), 1);
    assert.equal(value(second, "harness.msg.dropped", { outbox: "agent", reason: "no such session" }), 0);
    assert.equal(value(second, "harness.msg.refused", { source: "daemon", reason: "unknown session" }), 1);
    assert.equal(value(second, "harness.msg.refused", { source: "daemon", reason: "no worker found" }), 1);
    assert.equal(value(second, "harness.msg.refused", { source: "daemon", reason: "pending limit" }), 1);
    assert.equal(value(second, "harness.msg.refused", { source: "outbox", reason: "timed out after 30 s" }), 1);
    assert.equal(value(second, "harness.msg.refused", { source: "outbox", reason: "pending limit" }), 1);
    assert.equal(value(second, "harness.msg.refused", { source: "outbox", reason: "update restart" }), 1);
    assert.equal(value(second, "harness.msg.backlog", { name: "census canary run" }), 2);
    assert.equal(value(second, "harness.msg.refused", { source: "kernel", reason: "pending limit" }), 1);
    assert.equal(value(second, "harness.msg.timeout_copies", { found: "landed" }), 1);
    assert.equal(value(second, "harness.msg.full_drains", { turns: "2" }), 0, "a full target counts once it has room");

    // Round 3: the two queued messages go in one send, a run of the job starts, and its backlog reads 0 after that one run.
    put(join(dir, "m-b1.json"), entry("m-b1", S7, "[2 messages the chat service's outbox held for this session go together in this one send, oldest first]", "delivered", NOW + 5 * SECOND, {
      kind: "message", doneAt: NOW + 60 * SECOND, bundle: [
        { id: "m-b1", at: NOW + 5 * SECOND, kind: "wake", fingerprint: `${S7}\nb1`, text: "[wake] It is 17:14Z, the time you set with board.wake (17:14Z)" },
        { id: "m-b2", at: NOW + 6 * SECOND, kind: "message", fingerprint: `${S7}\nb2`, text: "[alert hyperdx] 2 new errors" }] }));
    put(join(dir, "m-b2.json"), entry("m-b2", S7, "[alert hyperdx] 2 new errors", "obsolete", NOW + 6 * SECOND, { attempts: 0, doneAt: NOW + 60 * SECOND, error: "it went inside m-b1 with 1 other" }));
    appendFileSync(join(home, ".config/pi-pool/pi-pool.log"), poolLine(NOW + 50 * SECOND, "turn_admitted", S8) + poolLine(NOW + 55 * SECOND, "turn_released", S8)
      + poolLine(NOW + 61 * SECOND, "turn_admitted", S7) + poolLine(NOW + 70 * SECOND, "turn_admitted", S8));
    appendFileSync(join(home, ".prime/agent/browser-chat/service.log"), "2026-10-19T17:14:40.000Z outbox 01a1aaaa: the target has room, 3 of 20 unfinished; sending m-b8\n");
    // The same wake as m-a1 reaches S1 again from a new entry.
    put(join(dir, "m-b5.json"), entry("m-b5", S1, "[wake] Run 39633529005 finished: success. https://github.com/x/y/actions/runs/39633529005\n", "delivered", NOW + 62 * SECOND, { doneAt: NOW + 63 * SECOND, kind: "wake", fingerprint: `${S1}\nm-a1-fp` }));
    // The Mac's convex session, at 2 since before the first round, drains too; its start is unknown, so it is not counted.
    const macCopy = join(home, ".cache/sieun-pi/hosts/mac.sessions.json");
    put(macCopy, readFileSync(macCopy, "utf8").replace('"unfinishedActionCount":2', '"unfinishedActionCount":0'));
    await settle();
    const third = await read(context(home, state, NOW + 90 * SECOND));
    assert.equal(value(third, "harness.msg.sends", { outbox: "agent", size: "2" }), 1);
    assert.equal(value(third, "harness.msg.delivered", { outbox: "agent", kind: "wake", how: "bundled" }), 1);
    assert.equal(value(third, "harness.msg.delivered", { outbox: "agent", kind: "alert", how: "bundled" }), 1);
    assert.equal(value(third, "harness.msg.delivered", { outbox: "agent", kind: "alert", how: "alone" }), 0);
    assert.equal(value(third, "harness.msg.dropped", { outbox: "agent", reason: "other" }), 0, "a message that went inside a bundle is no drop");
    assert.equal(value(third, "harness.msg.drains", { turns: "1" }), 1);
    assert.equal(value(third, "harness.msg.drains", { turns: "no turn record" }), 0, "the backlogs open at the first round are not counted");
    assert.deepEqual(["p50", "max"].map(q => value(third, "harness.msg.send_to_read", { outbox: "agent", via: "next turn", q })), [56, 60]);
    assert.equal(value(third, "harness.msg.refused", { source: "daemon", reason: "pending limit" }), 1, "counters keep their totals across rounds");
    assert.equal(pick(third, "harness.msg.backlog", { name: "census canary run" }).length, 0);
    assert.equal(pick(third, "harness.msg.backlog", { name: "convex" }).length, 0);
    assert.equal(value(third, "harness.msg.full_drains", { turns: "2" }), 1);
    assert.equal(value(third, "harness.msg.full_read", { turns: "2" }), 17);
    assert.equal(value(third, "harness.msg.duplicates"), 1);
    assert.equal(value(third, "harness.msg.held_notices"), 3);
    assert.equal(value(third, "harness.msg.outbox_late"), 0);

    // Round 4, 12 min on: the owner's send to the live wiki VP still waits, and a message to an archived job waits longer but does not count.
    put(join(dir, "m-c1.json"), entry("m-c1", "01a10000-9999-7000-8000-000000000009", "plain", "queued", NOW - 20 * MINUTE, { attempts: 3 }));
    await settle();
    const fourth = await read(context(home, state, NOW + 12 * MINUTE));
    assert.equal(value(fourth, "harness.msg.outbox_late"), 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("read sends only the daemon's refusals on a box that is not the chat host", async () => {
  const home = scratch();
  try {
    const state = new Map<string, unknown>();
    await read(context(home, state, NOW, false));
    appendFileSync(join(home, ".prime/agent/logs/agent.jsonl"), daemonLine("coding-agent.daemon-supervisor", "Supervisor command send_message failed: Error: Session worker is stopping"));
    const samples = await read(context(home, state, NOW + 30 * SECOND, false));
    assert.ok(samples.every(s => s.name === "harness.msg.refused" && s.labels?.source === "daemon"));
    assert.equal(value(samples, "harness.msg.refused", { source: "daemon", reason: "worker stopping or starting" }), 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
