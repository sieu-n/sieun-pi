// Guards the d4 block of 10-22. The Wiki dream's 14:23 job held the duty from 05:25Z on 10-22 to 04:16Z on 10-23 on its first brief, and every
// verify and push run in that time measured, read "skipped: previous run still working" and gave its findings to nobody while
// wiki_problems went from 14 to 44. In the 48 h to 10-22 07:51Z, 264 of the 1,221 page-hours the duty counted were pages that fell behind
// after its live job's brief was written (~/work/wiki-problems-follow-fix/NOTES.md). A run that finds the last job working now hands it the
// new items the precheck marks handOff, and a red duty gets that push run beside a working job, but never beside a parked one.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty, DutyJobRef, FlaggedSlice } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const page = (path: string): FlaggedSlice => ({ kind: "stale_vs_code", item: path, excerpt: `${path} behind`, handOff: true });

test("a push run beside a working job hands it only the new items, and nothing while it is parked on its quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-hand-off-"));
  try {
    const output = join(dir, "output.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(output)}, process.env.OUTPUT_FILE);`);
    const measure = (pages: string[], extra: FlaggedSlice[] = []) =>
      writeFile(output, JSON.stringify({ metrics: { wiki_problems: pages.length }, flagged: [...pages.map(page), ...extra] }));
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-22T05:23:00Z");
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles ... should always be up to date", goal: "the wiki matches the code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 24 * 60 },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active",
      createdAt: now - 25 * 60 * MIN, updatedAt: now - 25 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const live = new Set<string>();
    let parked = false;
    const started: string[] = [];
    const steers: { job: DutyJobRef; text: string }[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        working: async job => live.has(job.id),
        retire: async () => {},
        start: async (_chat, name) => { const id = `job-${started.length + 1}`; started.push(name); live.add(id); return { id, name }; },
        kept: async () => parked ? "has an active scheduled job (quota-resume)" : null,
        steer: async (job, text) => { steers.push({ job, text }); },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    const tick = async (pages: string[], extra: FlaggedSlice[] = []) => { now += 61 * MIN; await measure(pages, extra); await duties.tick(); await duties.settled(); };

    await measure(["a.html", "b.html"]);
    await duties.tick();
    await duties.settled();
    assert.deepEqual(started.length, 1, "the scheduled run starts the job with a and b in its brief");

    await tick(["a.html", "b.html", "c.html", "d.html"], [{ kind: "correction", item: "c170", excerpt: "new correction" }]);
    assert.equal(started.length, 1, "no second job starts beside the working one");
    assert.equal(steers.length, 1);
    assert.equal(steers[0]!.job.id, "job-1");
    assert.match(steers[0]!.text, /found 2 flagged items/);
    assert.ok(steers[0]!.text.includes("- stale_vs_code c.html: c.html behind") && steers[0]!.text.includes("d.html"));
    assert.ok(!steers[0]!.text.includes("a.html") && !steers[0]!.text.includes("c170"), "items in the brief and items with no handOff stay out");
    const [push] = await store.runs(CHAT);
    assert.equal(push!.trigger, "push");
    assert.match(push!.summary, /skipped: previous run still working \(job [^)]+\); handed it 2 new flagged items$/);

    await tick(["a.html", "b.html", "c.html", "d.html"]);
    assert.equal(steers.length, 1, "nothing new, nothing handed");

    parked = true;
    const runsBefore = (await store.runs(CHAT)).length;
    await tick(["a.html", "e.html"]);
    assert.equal(steers.length, 1, "a job parked on its quota gets no message");
    assert.equal((await store.runs(CHAT)).length, runsBefore, "and no push run starts beside it");

    parked = false;
    await tick(["a.html", "e.html"]);
    assert.equal(steers.length, 2);
    assert.match(steers[1]!.text, /found 1 flagged item that/);
    assert.ok(steers[1]!.text.includes("e.html"));
    assert.equal(started.length, 1);
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
