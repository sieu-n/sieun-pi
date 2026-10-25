// From 17:03Z on 10-22 to 01:00Z on 10-23 no d9 push went out. The 20:09Z, 22:09Z and 00:10Z chat system jobs each failed their first turn
// on "API key for provider anthropic is temporarily unavailable", and the 01:00Z run's 6-chat push list (d9-261023-1000.md) waited on a job
// that never ran. The precheck's pushes now go out as server notices when it ends, with no model turn.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";
import { pushList, pushRecords, pushTells, recordsPushes } from "../scripts/duties/chat-system.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const MIN = 60_000;
const NOW = Date.parse("2026-10-23T01:00:00Z");

test("d9's pushes go out as server notices when its precheck ends, before and whatever its job does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-precheck-tells-"));
  try {
    const tag = "[d9 push 2026-10-23T01:00Z]";
    const pushes = pushList({ idleGoals: [{ chat: CI, goals: [{ id: "p346", text: "Git rule breaks read 0", status: "doing", children: [] }] }],
      stuckDuties: [], upkeep: [], notMoving: [{ chat: SEO, line: "SEO guy: New articles get indexed (d2) missed new_unindexed_3d 16 runs in a row" } as never] });
    const tells = pushTells(pushes, tag);
    assert.equal(tells.length, 2);
    assert.match(tells[0]!.text, /^\[d9 push 2026-10-23T01:00Z\] .*goals with no live job p346 .*Give each goal a live job this turn/);
    assert.deepEqual(pushRecords(pushes, tag, NOW).map(line => line.items), [["p346"], ["d2"]]);
    const noFix = pushList({ idleGoals: [], upkeep: [], stuckDuties: [{ chat: "sg", duty: "d4", line: "01a11b0b: Slack green deploys read off target in its last run, " +
      "and no open step linked to it (duty field d4/commits_not_live) has a live owner now." } as never] });
    assert.deepEqual(pushRecords(noFix, tag, NOW).map(line => line.items), [["d4"]]);

    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "mode.txt"))}, process.env.PRECHECK_MODE ?? "");
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { duties_green_pct: 45.7 }, tells: ${JSON.stringify([...tells, { chat: "gone", text: "x" }])} }));`);
    const store = new DutyStore(dir);
    const duty: Duty = {
      id: "d9", name: "Chat system", ownerWords: "every chat runs on its own", goal: "duties read green",
      metrics: [{ key: "duties_green_pct", label: "Duties green", op: ">=", target: 100, headline: true }],
      schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "push the chats",
      status: "active", createdAt: NOW - 24 * 60 * MIN, updatedAt: NOW - 24 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const events: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath,
      tell: async (chat, text) => { if (chat === "gone") throw new Error("not a chat"); events.push(`tell ${chat.slice(0, 8)} ${text.slice(0, 27)}`); },
      jobs: {
        chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        // The job's first turn never runs: the pool has no key.
        start: async (_chat, name) => { events.push("job start"); return { id: "job-1", name }; },
        ended: async (last, older = []) => [...last, ...older],
        stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    await duties.tick();
    await duties.settled();
    duties.close();
    assert.deepEqual(events, [`tell 01a1180e ${tag}`, `tell 01a11a24 ${tag}`, "job start"]);
    assert.equal(await readFile(join(dir, "mode.txt"), "utf8"), "run");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// On 10-23 the 14:24Z after-job measure of d9 and a 14:31Z precheck the server never logged each appended pushes.jsonl lines for Crawler VP and
// the Railway chat that no notice ever carried, and the 00:35 KST run read all 4 as pushes that never reached their transcripts.
test("only a run the server sends tells for records its pushes; an after-job measure or a hand run records none", () => {
  assert.equal(recordsPushes("run"), true);
  assert.equal(recordsPushes("after"), false);
  assert.equal(recordsPushes(undefined), false);
});
