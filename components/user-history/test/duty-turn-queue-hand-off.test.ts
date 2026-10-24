// Guards the d4 skips of 10-23 and 10-24. A run that found the duty's last job waiting in pi-pool's turn queue skipped and handed it nothing,
// so the pages that fell behind meanwhile reached no job: 18 missed runs on 4 chats from 10-23 10:27Z to 10-24 05:18Z, among them d4 at
// 00:26Z and 05:18Z with 5 and 12 wiki problems. A job kept only by that queue takes the hand-off like a working job, and a job pi-pool holds
// for an account still takes none.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty, FlaggedSlice } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

async function steersBeside(why: string): Promise<{ steers: string[]; started: number; summaries: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "duty-turn-queue-hand-off-"));
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
    const steers: string[] = [];
    let started = 0;
    let keep: string | null = null;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        working: async () => true, retire: async () => {},
        start: async (_chat, name) => { started++; return { id: `job-${started}`, name }; },
        kept: async () => keep, reported: async () => false, steer: async (_job, text) => { steers.push(text); },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    await measure(["a.html", "b.html"]);
    await duties.tick();
    await duties.settled();
    keep = why;
    now += 61 * MIN;
    await measure(["a.html", "b.html", "c.html"]);
    await duties.tick();
    await duties.settled();
    const summaries = (await store.runs(CHAT)).map(run => run.summary);
    duties.close();
    return { steers, started, summaries };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a duty job waiting in pi-pool's turn queue takes the run's new flagged items, and one pi-pool holds for an account takes none", async () => {
  const queued = await steersBeside("waits 87 of 99 in pi-pool's turn queue");
  assert.equal(queued.started, 1, "the queued job keeps the duty");
  assert.equal(queued.steers.length, 1, "the queued job is handed the page that fell behind");
  assert.match(queued.steers[0]!, /c\.html: c\.html behind/);
  assert.doesNotMatch(queued.steers[0]!, /a\.html/, "its brief's pages are not handed again");
  assert.match(queued.summaries[0]!, /turn queue\); handed it 1 new flagged item$/);

  const held = await steersBeside("waits on pi-pool for its slot");
  assert.equal(held.started, 1);
  assert.equal(held.steers.length, 0, "a job pi-pool holds for an account takes no message");
});
