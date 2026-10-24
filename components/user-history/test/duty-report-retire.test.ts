// Guards the d4 hold of 10-23. The Wiki dream's 17:21 job sent the chat its report at 23:15Z, then 18 late "child-exited" notices and harness
// digests woke it one turn at a time, each turn waiting 15 to 30 min in pi-pool's turn queue. It read working or kept by that queue until
// 05:39Z, so the d4 runs of 00:26Z and 05:18Z (5 and 12 wiki problems) started no job, and the pages they found were ones its earlier
// rounds had fixed, so the hand-off named none of them. A job whose report is in no longer holds its duty, and a page a writer checked that
// a later commit put behind again is handed again.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { reportedSince, reportMarks, reportReader } from "../src/duty-job-report.ts";
import type { Duty, DutyJobRef, FlaggedSlice } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const user = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
const receipt = (at: string, target: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "toolResult", toolName: "ipython", content: [{ type: "text",
  text: `{'id': 'agentmsg_1', 'source': 'agent_message', 'target': {'activeSessionId': '173bdbfd5006', 'sessionId': '${target}', 'sessionName': 'AI harness developer environment VP', 'runtimeKind': 'top-level'}, 'deliveryStatus': 'delivered'}` }] } });
const notice = (at: string) => JSON.stringify({ type: "custom_message", timestamp: at, customType: "rlm_child_terminal_notice", content: "[child-exited: no-reply child:st6-ci-deploy]" });

test("a job's report is in once it sent the chat a message after its last prompt", async () => {
  const brief = user("2026-10-23T08:22:56Z", "# wiki dream AI harness developer environment 17:21");
  const handOff = user("2026-10-23T22:29:29Z", "The Wiki dream run of 2026-10-23T22:27Z found 2 flagged items");
  assert.equal(reportedSince(reportMarks([brief, handOff], CHAT)), false, "no message to the chat yet");
  assert.equal(reportedSince(reportMarks([brief, handOff, receipt("2026-10-23T23:15:15Z", "01a16af1-1c85-71e9-83f2-afbec200cedd")], CHAT)), false,
    "a message to another session is no report");
  const done = [brief, handOff, receipt("2026-10-23T23:15:15Z", CHAT), notice("2026-10-23T23:40:45Z"), notice("2026-10-24T05:27:33Z")];
  assert.equal(reportedSince(reportMarks(done, CHAT)), true, "late notices after the report leave it in");
  assert.equal(reportedSince(reportMarks([...done, user("2026-10-24T05:30:00Z", "The Wiki dream run found 5 flagged items")], CHAT)), false,
    "a new prompt after the report asks for more work");

  const dir = await mkdtemp(join(tmpdir(), "duty-report-"));
  try {
    const file = join(dir, "job.jsonl");
    const read = reportReader();
    await writeFile(file, `${brief}\n${handOff}\n`);
    assert.equal(reportedSince(await read(file, CHAT)), false);
    const line = receipt("2026-10-23T23:15:15Z", CHAT);
    await appendFile(file, line.slice(0, 40));
    assert.equal(reportedSince(await read(file, CHAT)), false, "a line still being written waits");
    await appendFile(file, `${line.slice(40)}\n${notice("2026-10-23T23:40:45Z")}\n`);
    assert.equal(reportedSince(await read(file, CHAT)), true, "the appended bytes are read on the next ask");
    await writeFile(file, `${brief}\n`);
    assert.equal(reportedSince(await read(file, CHAT)), false, "a file that got shorter is read again from its start");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a job whose report is in no longer holds its duty while late notices wake it in the turn queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-report-retire-"));
  try {
    const output = join(dir, "output.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(output)}, process.env.OUTPUT_FILE);`);
    const page = (path: string): FlaggedSlice => ({ kind: "stale_vs_code", item: path, excerpt: `${path} behind`, handOff: true });
    const measure = (pages: string[]) => writeFile(output, JSON.stringify({ metrics: { wiki_problems: pages.length }, flagged: pages.map(page) }));
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-23T08:21:00Z");
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles ... should always be up to date", goal: "the wiki matches the code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 24 * 60 },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active",
      createdAt: now - 25 * 60 * MIN, updatedAt: now - 25 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const reports = new Set<string>();
    let wake = false;
    const started: string[] = [];
    const retired: string[] = [];
    const asked: { job: string; chat: string }[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        // Every job reads working: each late notice wakes it again.
        working: async () => true,
        retire: async job => { retired.push(job.id); },
        start: async (_chat, name) => { const id = `job-${started.length + 1}`; started.push(name); return { id, name }; },
        kept: async (_job, reported) => reported ? wake ? "waits on a board.wake on run 39080016700" : null : "waits 87 of 99 in pi-pool's turn queue",
        reported: async (job: DutyJobRef, chatId: string) => { asked.push({ job: job.id, chat: chatId }); return reports.has(job.id); },
        steer: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    const tick = async (pages: string[]) => { now += 61 * MIN; await measure(pages); await duties.tick(); await duties.settled(); };

    await measure(["a.html", "b.html"]);
    await duties.tick();
    await duties.settled();
    assert.equal(started.length, 1, "the scheduled run starts the job");

    await tick(["a.html", "b.html", "c.html"]);
    assert.equal(started.length, 1, "a job in the turn queue with no report keeps the duty");
    assert.deepEqual(asked.at(-1), { job: "job-1", chat: CHAT }, "the report is read for the duty's own chat");

    reports.add("job-1");
    wake = true;
    await tick(["c.html", "d.html"]);
    assert.equal(started.length, 1, "a board.wake the job owes keeps it even with its report in");
    const held = (await store.runs(CHAT)).length;
    now += MIN;
    await duties.tick();
    await duties.settled();
    assert.equal((await store.runs(CHAT)).length, held, "and no push run measures beside it on every tick");

    wake = false;
    await tick(["c.html", "d.html"]);
    assert.equal(started.length, 2, "with its report in, the next run starts its own job");
    assert.deepEqual(retired, ["job-1"], "and retires the reported one");
    const [run] = await store.runs(CHAT);
    assert.equal(run!.job?.id, "job-2");
    assert.match(run!.summary, /\(replaced job .+, whose report was in\)$/);
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page a writer checked that a later commit put behind again is handed to the working job again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-report-sig-"));
  try {
    const output = join(dir, "output.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(output)}, process.env.OUTPUT_FILE);`);
    const page = (path: string, checked: string): FlaggedSlice => ({ kind: "stale_vs_code", item: path, excerpt: `checked ${checked}`, handOff: true, sig: checked });
    const measure = (pages: FlaggedSlice[]) => writeFile(output, JSON.stringify({ metrics: { wiki_problems: pages.length }, flagged: pages }));
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-23T20:21:00Z");
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles ... should always be up to date", goal: "the wiki matches the code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 24 * 60 },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active",
      createdAt: now - 25 * 60 * MIN, updatedAt: now - 25 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const steers: string[] = [];
    let started = 0;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        working: async () => true, retire: async () => {},
        start: async (_chat, name) => { started++; return { id: `job-${started}`, name }; },
        kept: async () => null, steer: async (_job, text) => { steers.push(text); },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    const tick = async (pages: FlaggedSlice[]) => { now += 61 * MIN; await measure(pages); await duties.tick(); await duties.settled(); };

    await measure([page("ci-cd-pipeline.html", "2026-10-23T21:12Z")]);
    await duties.tick();
    await duties.settled();
    assert.equal(started, 1);

    await tick([page("ci-cd-pipeline.html", "2026-10-23T21:12Z")]);
    assert.equal(steers.length, 0, "the same page behind the same check is not handed twice");

    await tick([page("ci-cd-pipeline.html", "2026-10-23T23:01Z")]);
    assert.equal(steers.length, 1, "the page checked again at 23:01Z and behind again is new work");
    assert.match(steers[0]!, /ci-cd-pipeline\.html: checked 2026-10-23T23:01Z/);
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
