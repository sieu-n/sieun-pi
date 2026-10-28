// Replays sep launch!!'s check-ins of 10-23 (01a15427, duties/<chat>.runs.jsonl). The check-in job of 03:39Z worked to 05:05Z, was cut on a 429
// and pi-pool held it for its 08:09Z slot. All 17 check-ins from 03:55Z to 08:12Z read "skipped: previous run still working" and handed the
// stuck steps they counted (2 at 03:55Z, 23 at 04:27Z, 15 at 06:27Z) to nobody, so d9 read stuck_steps_all 2 at 04:07Z. A check-in now hands
// new stuck steps to its working job in one steer, and to the chat as a notice while its job is held. Its 03:55Z line on p62 also read "live
// fixes stopped on a provider error (the model returned an error with no message) 1223 min ago with no report" from a 429 at 10-22 07:32Z,
// though the job reported 17 times after it and ended its last turn well at 03:06:55Z on a board.wake.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { serverNote } from "../src/shared/chat-feed.ts";
import type { DutyJobRef, FlaggedSlice } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const MIN = 60_000;
const stuck = (id: string): FlaggedSlice => ({ chat: CHAT, kind: "stuck_steps", item: id, excerpt: `${id} is stuck (job_ended): job live fixes ended and the step is open` });

test("a check-in that finds its job working steers it the new stuck steps, and tells the chat while pi-pool holds the job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-hand-off-"));
  try {
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-23T03:39:29Z");
    const live = new Set<string>();
    let held = false;
    const started: string[] = [];
    const steers: { job: DutyJobRef; text: string }[] = [];
    const tells: { chat: string; text: string }[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      tell: async (chat, text) => { tells.push({ chat, text }); },
      jobs: {
        chat: async id => ({ id, name: "sep launch!!", cwd: dir, board: id }),
        working: async job => live.has(job.id),
        retire: async () => {},
        start: async (_chat, name) => { const id = `job-${started.length + 1}`; started.push(name); live.add(id); return { id, name }; },
        kept: async () => held ? "waits on pi-pool for its slot" : null,
        steer: async (job, text) => { steers.push({ job, text }); },
      },
    });
    const checkIn = async (at: string, ids: string[]) => {
      now = Date.parse(at);
      await duties.checkIn(CHAT, { at: now, trigger: "schedule", everyMs: 15 * MIN, classes: {}, findings: "",
        output: { metrics: { goal_gaps: 0, stuck_steps: ids.length, no_done_line: 0, plan_risks: 0 }, flagged: ids.map(stuck) } });
      return (await store.runs(CHAT))[0]!;
    };

    await checkIn("2026-10-23T03:39:29Z", []);
    assert.equal(started.length, 1, "03:39Z starts check-in job 12:39");

    const first = await checkIn("2026-10-23T03:55:21Z", ["p62", "p63"]);
    assert.equal(started.length, 1);
    assert.equal(steers.length, 1, "the working job gets p62 and p63");
    assert.ok(steers[0]!.text.includes("- stuck_steps p62:") && steers[0]!.text.includes("- stuck_steps p63:"), steers[0]!.text);
    assert.match(first.summary, /^skipped: previous run still working \(job [^)]+\); handed it 2 new flagged items$/);

    await checkIn("2026-10-23T04:11:33Z", ["p62", "p63", "p54"]);
    assert.equal(steers.length, 2);
    assert.ok(steers[1]!.text.includes("p54") && !steers[1]!.text.includes("p62"), "only the step the job was not handed yet");

    held = true;
    const kept = await checkIn("2026-10-23T05:28:18Z", ["p54", "p35", "p36"]);
    assert.equal(steers.length, 2, "a job pi-pool holds takes no message");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]!.chat, CHAT);
    assert.ok(tells[0]!.text.includes("waits on pi-pool for its slot") && tells[0]!.text.includes("- stuck_steps p35:") && tells[0]!.text.includes("p36"), tells[0]!.text);
    assert.ok(!tells[0]!.text.includes("p54"), "a step the job was handed is not told again");
    assert.equal(serverNote(tells[0]!.text), "check-in", "the turn it starts is not the owner's (c117, 10-23 13:02Z)");
    assert.match(kept.summary, /waits on pi-pool for its slot\); handed the chat 2 new flagged items$/);

    await checkIn("2026-10-23T05:43:18Z", ["p35", "p36"]);
    assert.equal(tells.length, 1, "nothing new, nothing told");
    assert.equal(started.length, 1, "no second check-in job starts beside the held one");
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a told end the job worked past reads as the end it has now, and a told end keeps its cause", () => {
  const now = Date.parse("2026-10-23T03:55:21Z");
  const step: PlanItem = { id: "p62", text: "The daily billing check passes again", status: "doing", job: "live fixes", children: [] };
  const board = { v: 2, rev: 1, updatedAt: "2026-10-22T06:07:15Z", todos: [], plan: [{ id: "p60", text: "Live prod is clean", status: "doing", children: [step] }] } as unknown as ChatBoard;
  const told = { "sub-f78540b7": { at: Date.parse("2026-10-22T07:32:01Z"), cause: "error" as const, error: "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit." } };
  const read = (activityAt: number) => {
    const fact: JobFact = { key: "sub-f78540b7", name: "live fixes", state: "ended", activityAt };
    const precheck = checkInPrecheck(undefined, [fact], board, now);
    return convergenceMisses(CHAT, precheck.steps, precheck, told, 15 * MIN, now).flagged.filter(slice => slice.item === "p62" && slice.kind.startsWith("job_end"));
  };
  const after = read(Date.parse("2026-10-23T03:06:55Z"));
  assert.deepEqual(after.map(slice => slice.kind), ["job_end_unrecorded"]);
  assert.match(after[0]!.excerpt, /job live fixes ended 48 min ago/);
  const unloaded = read(Date.parse("2026-10-22T07:34:44Z"));
  assert.deepEqual(unloaded.map(slice => slice.kind), ["job_end_silent"], "the idle unload 2.7 min after the 429 is the same end");
  assert.match(unloaded[0]!.excerpt, /stopped on a provider error \(rate limit/);
});
