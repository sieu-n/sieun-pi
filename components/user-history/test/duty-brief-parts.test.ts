// At 09:27Z on 10-25 a Wiki dream push run read wiki_problems 0 with wiki_problems_following 6, so it started a job for the six pages. The
// brief named only the met headline, the job ended in one turn with "the next run will see them counted", and its after-job measure read
// wiki_problems 2 two minutes later and 5 by 10:25Z, with no job at work until the next push an hour after the first.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

test("a met run whose part of a counted metric is off target briefs its job to fix those items now", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-brief-parts-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-25T09:27:00Z");
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki should always be up to date", goal: "the wiki matches the repo",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }, { key: "open_mistakes", label: "Open mistakes", op: "<=", target: 0 }],
      schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Fix every flagged page.", status: "active", createdAt: now - 24 * 60 * MIN, updatedAt: now - 24 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const briefs: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name, brief) => { briefs.push(brief); return { id: `job-${briefs.length}`, name }; },
        ended: async (last, older = []) => [...last, ...older],
        stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const run = async (following: number) => {
      await writeFile(out, JSON.stringify({ metrics: { wiki_problems: 0, open_mistakes: 0, wiki_problems_following: following },
        flagged: [{ kind: "stale_vs_code", item: "apps/infra/grafana-boards.html", excerpt: "behind since 09:25Z, counted from 10:35Z", handOff: true }] }));
      await duties.runNow(CHAT, "d4");
      await duties.settled();
      now += 31 * MIN;
      return briefs.at(-1)!;
    };
    const due = await run(6);
    assert.equal((await store.runs(CHAT))[0]!.verdict, "met");
    assert.match(due, /## Work due before it counts\n- wiki_problems_following is 6, target <= 0: these items count in wiki_problems soon\./);
    assert.match(due, /Fix each one now as you would a miss/);
    const clear = await run(0);
    assert.doesNotMatch(clear, /Work due before it counts/, "a part on target is no work due");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
