// Guards the held push of 10-24 and 10-25. A miss whose fix step waits on the owner's open For you todo owes no fix job, as d9 reads it, yet the
// push gave it a push run with a job every check-in interval: vent's d1 got 14 such jobs from 10-24 19:30Z to 10-25 02:08Z while p79 waited
// on t15, and SEO guy's d2 got one every 2 h while p101 waited on t30. A held miss gets no push run; once the todo closes, the push comes back.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { ChatBoard, CheckInView } from "../src/shared/types.ts";

const CHAT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const MIN = 60_000;

test("a red duty whose only miss waits on an open For you todo gets no push run, and gets one again once the todo closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-push-held-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { provider_keys_outside_vent: 2 } }));`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-24T19:00:00Z");
    const duty: Duty = {
      id: "d1", name: "Vent gateway", ownerWords: "only vent holds provider keys", goal: "no provider key outside Vent",
      metrics: [{ key: "provider_keys_outside_vent", label: "Provider keys outside Vent", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it",
      status: "active", createdAt: now - 25 * 60 * MIN, updatedAt: now - 25 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const todo = { id: "t15", text: "Okay to rotate the key?", from: "agent", done: false, at: "2026-10-24T18:30:00Z" };
    const board = { v: 2, rev: 1, updatedAt: "", todos: [todo], plan: [{ id: "p79", text: "Move the last two keys into Vent", status: "blocked",
      duty: "d1/provider_keys_outside_vent", waitFor: "t15", children: [] }] } as unknown as ChatBoard;
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "vent", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
      checkIn: { view: async () => ({ everyMs: 30 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => board, fixLive: async () => false,
    });
    const tick = async () => { now += 31 * MIN; await duties.tick(); await duties.settled(); };

    await duties.tick();
    await duties.settled();
    assert.equal(started.length, 1, "the scheduled run starts its job");
    const scheduled = (await store.runs(CHAT)).length;
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(started.length, 1, "no push job while p79 waits on t15");
    assert.ok((await store.runs(CHAT)).every((run, index, all) => index >= all.length - scheduled || run.trigger !== "push"), "and no push run");

    todo.done = true;
    await tick();
    assert.equal(started.length, 2, "the push comes back once t15 closes");
    assert.equal((await store.runs(CHAT))[0]!.trigger, "push");
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
