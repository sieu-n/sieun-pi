// 10-20 20:05 KST: the d4 run's brief named its own goal p200 as wiki_problems' fix step ("Its fix step p200 has no job ... set that job and its
// sessionId on p200"), so its job put a hold job on the goal, which the push leaves out of the live fixes since 2bbbb844.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { ChatBoard, CheckInView } from "../src/shared/types.ts";

const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const board = { v: 2, rev: 1, updatedAt: "2026-10-20T11:00:00Z", todos: [], plan: [{ id: "p200", text: "The main wiki is up to date", status: "doing",
  duty: "d4/wiki_problems", children: [] }] } as unknown as ChatBoard;

test("a missed run never names the duty's own goal as its fix step, in the run record or the job's brief", async () => {
  const dir = await mkdtemp(join(tmpdir(), "d4-goal-fix-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 3 } }));`);
    const store = new DutyStore(dir);
    const now = Date.parse("2026-10-20T11:05:00Z");
    const duty: Duty = { id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles and whcih articles exist itself should always be up to date",
      goal: "the main wiki is up to date", metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 120 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", boardGoal: "p200",
      status: "active", createdAt: now - 86_400_000, updatedAt: now - 86_400_000, runCount: 1, lastRunAt: now - 30 * MIN };
    await store.update(HARNESS, duties => { duties.push(duty); });
    const briefs: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: { chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }), working: async () => false, retire: async () => {},
        start: async (_chat, name, brief) => { briefs.push(brief); return { id: "d4-job", name }; } },
      checkIn: { view: async () => ({ everyMs: 30 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => board, fixLive: async () => false,
    });
    assert.equal(await duties.runNow(HARNESS, "d4"), true);
    await duties.settled();
    duties.close();
    const run = (await store.runs(HARNESS))[0]!;
    assert.equal(run.verdict, "missed");
    assert.equal(run.fixes, undefined);
    assert.equal(briefs.length, 1);
    assert.doesNotMatch(briefs[0]!, /fix step p200|on p200/);
    assert.match(briefs[0]!, /No plan step fixes it\..*add a plan step with duty "d4\/wiki_problems"/s);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
