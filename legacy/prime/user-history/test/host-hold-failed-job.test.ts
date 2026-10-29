// 10-30 06:00 KST (10-29 21:00Z): sep launch!!'s check-in flagged orphan_steps on p133 and p137 four check-ins in a row. Their jobs "real app
// cleanup" and "home dashboard" run on the owner's MacBook Pro, off Tailscale since about 18:31Z, and their last turns failed on a pi-pool slot
// wait at 19:30Z. A slot wait read as moving before the host hold was read, so the step was neither held nor stuck, its class stayed orphan, and
// the check-in job asked the owner on t65 to wake the Mac (c178). A job on an offline box now holds its step there, failed or not, and the
// check-in reruns once the box is back, so its job restarts what the box stopped.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { CHECK_IN_DUTY_ID } from "../src/shared/chat-duties.ts";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, CheckInView, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const now = Date.parse("2026-10-29T21:00:00Z");
const mac = { name: "mac", lastSeen: "2026-10-29T18:31:00Z" };
const step = (id: string, job: string, sessionId: string): PlanItem => ({ id, text: `step ${id}`, status: "doing", job, sessionId, note: "Done when it ships", children: [] });
const steps = [step("p133", "real app cleanup", "01a17f00-0000-7000-8000-000000000133"), step("p137", "home dashboard", "01a17f00-0000-7000-8000-000000000137")];
const board = { v: 2, rev: 900, updatedAt: "2026-10-29T19:00:00Z", todos: [],
  plan: [{ id: "p2", text: "The 5180 app works for real", status: "doing", note: "Done when every step is done", children: steps }] } as unknown as ChatBoard;
const rows = [{ id: SEP, name: "sep launch!!", host: "mac" }] as unknown as SessionRow[];
const slotWait = "pi-pool: this session waits for its slot at 2026-10-29T19:45:00Z";
const facts = (error: string | undefined, wake?: string): JobFact[] => steps.map(item => ({ key: `child-${item.id}`, name: item.job!, state: wake ? "working" : "failed",
  sessionId: item.sessionId!, activityAt: now - 90 * MIN, ...error ? { error } : {}, ...wake ? { wake } : {} }));

for (const [why, error, wake] of [["failed on a pi-pool slot wait", slotWait, undefined], ["failed on a provider error", "429 rate limited", undefined],
  ["sleeps on a board.wake", undefined, "a check by 22:40Z"]] as const) {
  test(`a step whose job ${why} on the offline Mac is held there: no orphan_steps, no stuck step, one host_held line each`, () => {
    const precheck = checkInPrecheck(undefined, facts(error, wake), board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held: hostHolds([mac]) } });
    const out = convergenceMisses(SEP, precheck.steps, precheck, {}, 15 * MIN, now);
    assert.equal(out.metrics.orphan_steps, 0);
    assert.equal(out.metrics.stuck_steps, 0);
    assert.equal(out.metrics.job_end_unrecorded, 0);
    const held = out.flagged.filter(slice => slice.kind === "host_held");
    assert.deepEqual(held.map(slice => [slice.item, slice.host]), [["p133", "mac"], ["p137", "mac"]]);
    assert.match(held[0]!.excerpt, /job real app cleanup runs on mac, offline on Tailscale since 18:31Z\. Add no For you todo for it/);
  });
}

test("once the Mac is back the same failed jobs read as orphan steps again, so the check-in restarts them", () => {
  const precheck = checkInPrecheck(undefined, facts(slotWait), board, now, { self: [SEP], rows });
  const out = convergenceMisses(SEP, precheck.steps, precheck, {}, 15 * MIN, now);
  assert.equal(out.flagged.filter(slice => slice.kind === "host_held").length, 0);
  assert.deepEqual(out.flagged.filter(slice => slice.kind === "orphan_steps").map(slice => slice.item), ["p133", "p137"]);
});

test("a check-in that held steps on the offline Mac reruns once Tailscale reads it online, once, so its job restarts the jobs the Mac stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-host-back-"));
  try {
    const store = new DutyStore(dir);
    let at = now;
    await store.update(SEP, () => {});
    const held = { kind: "host_held", item: "p133", host: "mac", excerpt: "p133 waits for its box" };
    await store.appendRun(SEP, { duty: CHECK_IN_DUTY_ID, at, trigger: "schedule", ms: 1, verdict: "met", metrics: {}, summary: "", flagged: [held] });
    const reruns: [string, string | undefined, number | undefined][] = [];
    let macOnline = false;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => at, tickMs: 0, node: process.execPath, hostOnline: async () => macOnline,
      jobs: { chat: async id => ({ id, name: "sep launch!!", cwd: dir, board: id }), working: async () => false, retire: async () => {},
        start: async (_chat, name) => ({ id: "job", name }), ended: async (last, older = []) => [...last, ...older], stop: async () => {} },
      checkIn: { view: async () => ({ everyMs: 15 * MIN, paused: false }) as unknown as CheckInView, set: async () => null,
        run: async (chat, trigger, rerunOf) => { reruns.push([chat, trigger, rerunOf]); } },
    });
    at += 5 * MIN;
    await duties.tick();
    await duties.settled();
    assert.deepEqual(reruns, [], "no rerun while Tailscale reads the Mac offline");
    macOnline = true;
    at += 5 * MIN;
    await duties.tick();
    await duties.settled();
    assert.deepEqual(reruns, [[SEP, "host-back", now]]);
    await duties.tick();
    await duties.settled();
    assert.equal(reruns.length, 1, "one rerun per held run");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
