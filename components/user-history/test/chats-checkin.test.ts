import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { clockTime, localTime, OWNER_UI } from "../src/checkin-settings.ts";
import type { Ledger } from "../src/chat-corrections.ts";
import { BRIEF_CHECK_MAX_AGE_MS, briefCheckRecord, REPLY_CHECK_MAX_AGE_MS, replyCheckRecord } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { type CheckInRun, Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { source, fakeThreads, dutySink } from "./chats-helpers.ts";

// Notice times are the owner's local HH:MM; the expected strings are written for Seoul.
process.env.TZ = "Asia/Seoul";

test("chats: every scheduled check-in hands one run with the precheck to the duty runner, all targets met included; it sends the chat nothing; a chat with nothing open starts none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Reach chats from Slack", status: "doing", children: [
    { id: "p2", text: "Plan", status: "doing", job: "api-audit", children: [] },
    { id: "p3", text: "Build", status: "blocked", waitUntil: new Date(1_000_000 + 86_400_000).toISOString(), children: [] }] }] };
  let now = 1_000_000;
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), duty: sink.duty });
  await chats.adopt();
  const job = (working: boolean): ChildAgent => ({ id: "k1", label: "audit", sessionName: "api-audit", status: working ? "running" : "done", lastActivityAt: now, repliedSinceTask: true });
  threads.fire().live("c1", [job(true)]);
  await chats.settled();
  calls.length = 0;
  now += 15 * 60_000;
  assert.deepEqual(await chats.tick(), ["c1"]);
  await chats.settled();
  assert.equal(sink.runs.length, 1, "exactly one run");
  const [{ id, run }] = sink.runs as [{ id: string; run: CheckInRun }];
  assert.equal(id, "c1");
  assert.deepEqual(Object.entries(run.output.metrics).filter(([, value]) => Number(value) > 0), [["stuck_steps", 1]],
    "every target met but the end state (p3 waits a day with no owner), and the run goes to a job");
  assert.deepEqual([run.at, run.trigger, run.classes.live, run.classes.waiting], [now, "schedule", 1, 1]);
  assert.equal(run.findings, `End state: 1 of 2 open steps (50%) are moving, in For you or parked; 1 stuck (time 1).\n\n` +
    `### Stuck steps (the owner's end state: every open step is moved by a live owner now, held by an open For you todo that links it, or parked by his ` +
    `correction. Each step below ends this run with a live owner, a For you todo or a close; a chase, a new wait text or a later waitUntil leaves it stuck)\n` +
    `- p3 "Build" is stuck (time): waits on a time and no live job of this chat watches it, last change 0 min ago: do it now if it can run now, or give ` +
    `it a live owner that wakes at that time\n\n### Jobs\n- job api-audit: working, last activity 15 min ago, on p2 "Plan" (doing)\n\n### Every open step, oldest change first\n` +
    `- p2 (live) "Plan" doing, owner job api-audit (working), last change 0 min ago\n- p3 (waiting) "Build" blocked, no owner, waits until ${localTime(1_000_000 + 86_400_000)}, last change 0 min ago`);
  assert.deepEqual(calls, [], "no steer, no nudge, no note: the duty job decides");
  assert.deepEqual(await chats.tick(), [], "a second wake in the same slot does not run it again");
  threads.fire().children("c1", [job(false)]);
  await chats.settled();
  now += 15 * 60_000;
  await chats.tick();
  await chats.settled();
  assert.match(sink.runs[1]!.run.findings, /### Steps whose class needs action\n- p2 "Plan" has no live owner \(job api-audit idle\): start a job, take it yourself, or ask the owner in For you/);
  assert.equal(sink.runs[1]!.run.output.metrics.orphan_steps, 1);
  board.plan = [{ ...board.plan[0]!, status: "done", children: board.plan[0]!.children.map(step => ({ ...step, status: "done" as const })) }];
  now += 15 * 60_000;
  await chats.tick();
  await chats.settled();
  assert.equal(sink.runs.length, 2, "no job at work and no open step: nothing to check");
  assert.deepEqual(calls, []);
  chats.close();
});


test("chats: the check-in reads the ledger's handoffs: a step on another thread's work is in the duty job's findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const now = 100_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [],
    plan: [{ id: "p1", text: "Find what eats swap on this Mac", status: "doing", job: "c1", note: "at 12 GB", children: [] }] };
  const ledger: Ledger = { corrections: [{ id: "c7", at: "", chat: { id: "vp", name: "dev VP" }, words: "w", rule: "Machine work goes to ops guy.", enforcedBy: "code",
    ref: "pending commit", status: "reopened", theme: ["mac"], repeats: [], handoff: { to: "ops guy (+observability)", topics: ["swap", "M1 Air"] } }] };
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), corrections: async () => ledger, duty: sink.duty });
  await chats.adopt();
  threads.fire().live("c1", []);
  await chats.settled();
  await chats.checkIn("c1");
  assert.match(sink.runs[0]!.run.findings, /### Owned by another thread by an owner ruling\n- p1 "Find what eats swap on this Mac" belongs to ops guy \(\+observability\) \(correction c7\): hand it off/);
  assert.equal(sink.runs[0]!.run.output.metrics.scope_misses, 1);
  chats.close();
});



test("chats: the scheduler runs each chat at its own interval, skips a paused one, resumes it when the pause ends, and keeps the setting across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["slow", "fast"]) await index.add(id);
  let now = new Date(2026, 9, 8, 14, 0).getTime();
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now));
  assert.equal(await chats.checkInView("plain"), null, "not a chat");
  assert.equal(await chats.setCheckIn("plain", { everyMs: 60_000 }, OWNER_UI), null);
  assert.deepEqual(await chats.checkInView("fast"), { everyMs: 900_000, paused: false, nextAt: now, pausedUntil: null, lastAt: null },
    "a chat with no check-in on record is due at once, not one interval after the service started");
  await chats.setCheckIn("fast", { everyMs: 60_000 }, OWNER_UI);
  await chats.setCheckIn("slow", { everyMs: 15 * 60_000 }, OWNER_UI);
  const ran: Record<string, number> = { fast: 0, slow: 0 };
  for (let second = 30; second <= 30 * 60; second += 30) {
    now += 30_000;
    for (const id of await chats.tick()) ran[id]!++;
  }
  assert.deepEqual(ran, { fast: 30, slow: 2 }, "30 min: every 1 min and every 15 min");
  await chats.settled();
  assert.equal((await chats.checkInView("fast"))?.lastAt, now - 30_000, "due at the first wake, then every minute");

  await chats.setCheckIn("fast", { everyMs: 5 * 60_000 }, OWNER_UI);
  const before = now;
  let fast = 0;
  for (let second = 30; second <= 10 * 60; second += 30) { now += 30_000; if ((await chats.tick()).includes("fast")) fast++; }
  assert.equal(fast, 2, "the new interval applies at the next wake");
  assert.equal((await chats.checkInView("fast"))?.lastAt, before + 9.5 * 60_000);

  const long = await chats.setCheckIn("slow", { pause: "1h" }, OWNER_UI);
  assert.deepEqual([long?.pausedUntil, long?.nextAt], [now + 3_600_000, now + 3_600_000], "the pause end, then the run it allows");
  await chats.setCheckIn("slow", { pause: null }, OWNER_UI);
  const paused = await chats.setCheckIn("fast", { pause: "1h" }, OWNER_UI);
  assert.equal(paused?.paused, true);
  assert.equal(paused?.pausedUntil, now + 3_600_000);
  assert.equal(paused?.nextAt, now + 3_600_000);
  const pausedAt = now;
  fast = 0;
  for (let second = 30; second < 60 * 60; second += 30) { now += 30_000; if ((await chats.tick()).includes("fast")) fast++; }
  assert.equal(fast, 0, "no check-in while paused");
  now = pausedAt + 3_600_000;
  assert.deepEqual((await chats.tick()).includes("fast"), true, "the pause ended: it runs at once");
  assert.equal((await chats.checkInView("fast"))?.paused, false);

  await chats.setCheckIn("fast", { pause: "forever" }, OWNER_UI);
  now += 24 * 3_600_000;
  assert.equal((await chats.tick()).includes("fast"), false, "paused until resumed");
  assert.deepEqual(await chats.checkIns(), new Map([["slow", { everyMs: 900_000, paused: false, pausedUntil: null, nextAt: (await chats.checkInView("slow"))!.nextAt }],
    ["fast", { everyMs: 300_000, paused: true, pausedUntil: "forever", nextAt: null }]]));
  await chats.settled();
  chats.close();

  const again = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now));
  assert.deepEqual(await again.checkInView("fast"), { everyMs: 300_000, paused: true, nextAt: null, pausedUntil: "forever", lastAt: null }, "the setting survives a restart");
  const resumed = await again.setCheckIn("fast", { pause: null }, OWNER_UI);
  assert.deepEqual(resumed, { everyMs: 300_000, paused: false, nextAt: now, pausedUntil: null, lastAt: null }, "resume keeps the interval; with no check-in on record it is due at once");
  now += 300_000;
  assert.deepEqual(await again.tick(), ["fast", "slow"], "neither has a check-in on record in this service (their boards had nothing to check), so both are due at the first wake");
  await again.settled();
  again.close();
});

test("chats: a check-in whose job could not start runs again 5 min later, not a whole interval later (slack green guy 10-12)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("sg");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p2", text: "Build", status: "doing", children: [] }] }] };
  let now = 10 * 60 * 60_000;
  const starts: string[] = [];
  const duty = { async checkIn(id: string, run: CheckInRun) { starts.push(`${id} ${(run.at - 10 * 60 * 60_000) / 60_000}`); return starts.length === 1 ? "failed" as const : "done" as const; }, async lastCheckIn() { return undefined; } };
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir, { sg: board }, () => now), duty });
  await chats.setCheckIn("sg", { everyMs: 60 * 60_000 }, OWNER_UI);
  await chats.tick(); await chats.settled();
  now += 5 * 60_000;
  await chats.tick(); await chats.settled();
  now += 5 * 60_000;
  await chats.tick(); await chats.settled();
  assert.deepEqual(starts, ["sg 0", "sg 5"], "retried after 5 min, then back on its hourly schedule");
  chats.close();
});

test("chats: a service restart keeps each chat's check-in schedule from its memory; an owner turn holds no check-in; adopting a chat creates no duty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["vp", "fresh"]) await index.add(id);
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p7", text: "Check the load", status: "doing", job: "vp", waitUntil: new Date(1_000_000).toISOString(), children: [] }] }] };
  let now = 10 * 60 * 60_000;
  await checkInRecord(join(dir, "check-ins.json")).set("vp", { at: now - 20 * 60_000, steps: { p7: { sig: JSON.stringify(["doing", "Check the load", "vp", new Date(1_000_000).toISOString(), ""]), at: 0 } } });
  const store = new DutyStore(dir);
  const started: string[] = [];
  const duties = new Duties(store, { isChat: async () => true, tickMs: 0, now: () => now,
    jobs: { chat: async id => ({ id, name: id, cwd: "/repo", board: "/b.json" }), working: async () => false, retire: async () => {},
      start: async (chat, name, brief) => { started.push(`${chat.id} ${name}`); assert.match(brief, /p7 "Check the load" is due since/); return { id: `job-${chat.id}`, name }; } } });
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { vp: board, fresh: board }, () => now), duty: duties });
  await chats.adopt();
  assert.deepEqual([await store.chats(), await store.list("vp")], [[], []], "no Board convergence duty: the check-in is the chat's one built-in duty");
  assert.deepEqual(await chats.tick(), ["fresh", "vp"], "the chat checked in 20 min before the restart is due at the first wake, and so is one with " +
    "no check-in on record (ops guy 10-12: each release restart pushed its 2 h check-in back again)");
  await chats.settled();
  assert.deepEqual(started.sort(), [`fresh check-in fresh ${clockTime(now)}`, `vp check-in vp ${clockTime(now)}`]);
  assert.deepEqual([(await store.read("vp")).duties, (await store.read("vp")).checkIn?.runCount], [[], 1], "the run is a run of the built-in duty, and no standing duty appears");
  const threads = fakeThreads(calls);
  const busy = new Chats(index, { ...threads, running: () => true, state: () => ({ messages: [{ role: "user", content: "hi", timestamp: now }] }) }, async () => ({ lifecycle: "live" }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, { vp: board, fresh: board }, () => now));
  now += 15 * 60_000;
  assert.deepEqual((await busy.tick()).sort(), ["fresh", "vp"], "the duty job runs beside the owner's turn: no hold");
  await busy.settled();
  chats.close();
  busy.close();
});

test("chats: a board the server cannot read is a fact in the duty job's findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lines: string[] = [];
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), board: async () => { throw new Error("Chat board file is malformed."); }, duty: sink.duty }, line => lines.push(line));
  await chats.adopt();
  await chats.checkIn("c1");
  assert.equal(sink.runs[0]!.run.findings, "### Other facts\n- the board cannot be read: Chat board file is malformed.", "with no job and no step it still runs");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), []);
  assert.match(lines.join("\n"), /check-in board: Chat board file is malformed\./);
  chats.close();
});

test("reply check: kept on disk, so a restart right after a long reply still sends one [reply check], and no later server sends it again (W59, 19:34Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  const replyAt = 1_000_000;
  let clock = replyAt + 30_000;
  const long = Array.from({ length: 80 }, (_, at) => `word${at}`).join(" ");
  const messages: ThreadMessage[] = [
    { role: "user", content: "youre so far back, push hard", timestamp: replyAt - 60_000 },
    { role: "assistant", content: [{ type: "text", text: long }], stopReason: "stop", timestamp: replyAt } as unknown as ThreadMessage,
  ];
  const start = () => {
    const calls: string[] = [];
    const threads = fakeThreads(calls);
    threads.transcripts.set("vp", messages);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => clock));
    return { calls, threads, chats, checks: () => calls.filter(call => call.startsWith("steer vp [reply check]")) };
  };
  await loadRecord(join(dir, "extension-loads.json")).set("vp", "b1");
  const first = start();
  await first.chats.adopt();
  first.threads.fire().live("vp", []);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "a server started 30 s after the reply sends its check when the chat attaches");
  assert.match(first.checks()[0]!, /- 80 words: /);
  first.threads.fire().idle("vp");
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "the turn end after it sends none");
  first.chats.close();
  const second = start();
  await second.chats.adopt();
  second.threads.fire().live("vp", []);
  second.threads.fire().idle("vp");
  await second.chats.settled();
  assert.deepEqual(second.checks(), [], "a second restart on the same data dir sends none");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "reply-checks.json"), "utf8")), { vp: replyAt });
  second.chats.close();

  await index.add("busy");
  const third = start();
  third.threads.transcripts.set("busy", messages);
  third.threads.busyIds.add("busy");
  await third.chats.adopt();
  third.threads.fire().live("busy", []);
  await third.chats.settled();
  assert.deepEqual(third.calls.filter(call => call.startsWith("steer busy")), [], "a chat attached mid-turn waits for its turn end");
  third.threads.busyIds.delete("busy");
  third.threads.fire().idle("busy");
  await third.chats.settled();
  assert.equal(third.calls.filter(call => call.startsWith("steer busy [reply check]")).length, 1);
  third.chats.close();

  await index.add("old");
  clock = replyAt + REPLY_CHECK_MAX_AGE_MS + 1;
  const fourth = start();
  fourth.threads.transcripts.set("old", messages);
  await fourth.chats.adopt();
  fourth.threads.fire().idle("old");
  await fourth.chats.settled();
  assert.deepEqual(fourth.calls.filter(call => call.startsWith("steer old")), [], "a reply over an hour old gets no check");
  assert.equal(await replyCheckRecord(join(dir, "reply-checks.json")).claim("old", replyAt), true, "and is not recorded as checked");
  fourth.chats.close();
});

test("brief check: a new job of a chat whose brief breaks the Jobs rule gets one [brief check] steer, once across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-check-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  await loadRecord(join(dir, "extension-loads.json")).set("vp", "b1");
  const sessionFile = join(dir, "sessions", "vp.jsonl");
  const spawn = async (childId: string, prompt: string, createdAt: number) => {
    await mkdir(join(dir, "session-artifacts", "vp", childId), { recursive: true });
    await writeFile(join(dir, "session-artifacts", "vp", childId, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId, sessionName: childId, prompt, createdAt }));
  };
  const askAt = 1_791_000_000_000;
  const clock = askAt + 120_000;
  const messages = [
    { role: "user", content: "can you simulate what you send to the agent?", timestamp: askAt },
    { role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "toolUse", timestamp: askAt + 1_000 },
  ] as unknown as ThreadMessage[];
  await spawn("bad", "Owner's words (verbatim):\n1. \"show me what you send to agents\"\nMy read: audit the briefs.\nDo it.", askAt + 2_000);
  await spawn("good", `Owner's words (verbatim):\n1. 10:00 "can you simulate what you send to the agent?"\nMy read: audit the briefs.\nSplit: inline, two reads.`, askAt + 3_000);
  await spawn("old", "no block", askAt - BRIEF_CHECK_MAX_AGE_MS - 1);
  const job = (id: string): ChildAgent => ({ id, label: id, sessionName: id, status: "running" });
  const start = () => {
    const calls: string[] = [];
    const threads = fakeThreads(calls);
    threads.transcripts.set("vp", messages);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, {}, () => clock), briefChecks: briefCheckRecord(join(dir, "brief-checks.json"), () => clock) });
    return { threads, chats, checks: () => calls.filter(call => call.startsWith("steer vp [brief check]")) };
  };
  const first = start();
  await first.chats.adopt();
  first.threads.fire().live("vp", [job("old")]);
  first.threads.fire().children("vp", [job("old"), job("bad"), job("good")]);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "one steer: the good brief passes and the old job is skipped");
  assert.match(first.checks()[0]!, /^steer vp \[brief check\] Your brief for \[bad\]\(job:bad\) breaks the Jobs rule:\n- "show me what you send to agents" is not in any owner message/);
  assert.match(first.checks()[0]!, /- No `Split:` line\./);
  assert.match(first.checks()[0]!, /receiver_name="bad"/);
  first.threads.fire().children("vp", [job("old"), { ...job("bad"), status: "done" }, job("good")]);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "a second snapshot sends none");
  first.chats.close();
  const second = start();
  await second.chats.adopt();
  second.threads.fire().live("vp", [job("bad"), job("good")]);
  await second.chats.settled();
  assert.deepEqual(second.checks(), [], "a restart does not send it again");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "brief-checks.json"), "utf8"))), ["bad"]);
  second.chats.close();
});
