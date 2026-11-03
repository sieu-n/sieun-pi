// Guards the Duties card's read of the AI harness chat on 10-28: each chat release restarts the service, and the first api/threads/<chat>/duties
// read after it parsed the chat's whole runs file (1,935 records, 3.4 MB) beside the duty tick's cold parse of every chat's file, 818 to 1,126 ms
// in four restart minutes, which d7 counted dirty. The card shows 14 runs per duty, so a cold view parses only those. The test counts the
// characters JSON.parse reads, because its first check compared wall times and failed releases that ran 20 test files at once: the view took
// 0.64, 0.89 and 0.91 of a whole parse on 10-29, 11-02 and 11-04, against 0.27 to 0.38 in 12 passing runs of the same files. The view before
// the tail read parsed 1.0 of the file's characters, and the tail read parses 0.06.
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties, VIEW_RUNS } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty, DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
/** A cold copy of the same chat for the whole parse. */
const PARSED = "01a1164b-0000-0000-0000-000000000011";
const MIN = 60_000;
/** The AI harness chat's runs per duty on 10-28: d8 runs rarely, so its 14 newest reach back to the file's first line. */
const COUNTS: Record<string, number> = { d7: 695, checkin: 575, d4: 209, d9: 167, d10: 145, d5: 79, d11: 52, d8: 12 };
const IDS = ["d4", "d5", "d7", "d8", "d9", "d10", "d11"];

const duty = (id: string, at: number): Duty => ({
  id, name: `Duty ${id}`, ownerWords: "keep it green", goal: "green", metrics: [{ key: "pct", label: "Pct", op: ">=", target: 100, headline: true }],
  schedule: { kind: "every", minutes: 30 }, precheck: { command: ["true"], cwd: "/", timeoutMs: 30_000 }, onMiss: "fix it",
  status: "active", createdAt: at, updatedAt: at, runCount: 0,
});

/** About 1.75 KB a record, as the real file's 3.4 MB over 1,935 lines. */
function runsFile(start: number): string {
  const order = Object.entries(COUNTS).flatMap(([id, count]) => Array.from({ length: count }, (_, index) => ({ id, index, of: count })))
    .sort((a, b) => a.index / a.of - b.index / b.of);
  return order.map(({ id }, index): string => {
    const at = start + index * MIN;
    const record: DutyRunRecord = { duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: index % 3 ? "met" : "missed",
      metrics: { pct: { value: index % 101, target: 100, op: ">=", met: index % 101 === 100 } }, summary: `run ${index} of ${id}: 시간 ${"steps and readings ".repeat(85)}` };
    return JSON.stringify(record) + "\n";
  }).join("");
}

/** What `read` gives and the characters every JSON.parse call during it read. */
async function parsedChars<T>(read: () => Promise<T>): Promise<{ result: T; chars: number }> {
  const parse = JSON.parse;
  let chars = 0;
  JSON.parse = (text, reviver) => { chars += text.length; return parse(text, reviver); };
  try { const result = await read(); return { result, chars }; } finally { JSON.parse = parse; }
}

test("a cold Duties view of a 1,935-run chat parses its 14 newest runs per duty, under a tenth of a whole parse, and shows the same runs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "duty-view-cold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DutyStore(dir);
  const now = Date.parse("2026-10-28T07:00:00Z");
  const text = runsFile(now - 2000 * MIN);
  for (const id of [CHAT, PARSED]) {
    await store.update(id, duties => { duties.push(...IDS.map(entry => duty(entry, now - 9 * 24 * 60 * MIN))); });
    await writeFile(join(store.dir, `${id}.runs.jsonl`), text);
  }
  const duties = new Duties(store, {
    isChat: async () => true, now: () => now, tickMs: 0,
    jobs: { chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }), working: async () => false, retire: async () => {},
      start: async (_chat, name) => ({ id: "job", name }), ended: async last => [...last], stop: async () => {} },
    checkIn: { view: async () => ({ everyMs: 15 * MIN, paused: false, nextAt: now + MIN }) as CheckInView, set: async () => null, run: async () => {} },
  });

  const { result: cold, chars: viewChars } = await parsedChars(() => duties.view(CHAT));
  const { result: all, chars: parseChars } = await parsedChars(() => store.runs(PARSED));
  if (process.env.DUTY_VIEW_CHARS) console.log(JSON.stringify({ viewChars, parseChars, share: viewChars / parseChars }));
  assert.ok(viewChars < parseChars / 10, `a cold view parsed ${viewChars} characters against ${parseChars} for a whole parse of the same file`);

  const expected = (records: readonly DutyRunRecord[], id: string) => records.filter(run => run.duty === id).slice(0, VIEW_RUNS);
  assert.deepEqual(cold.map(view => view.duty.id), ["checkin", ...IDS]);
  for (const view of cold) assert.deepEqual(view.runs, expected(all, view.duty.id), view.duty.id);
  assert.equal(cold.find(view => view.duty.id === "d8")?.runs.length, 12);

  await store.runs(CHAT);
  const record: DutyRunRecord = { duty: "d8", at: now + MIN, slot: now + MIN, trigger: "owner", ms: 1, verdict: "met", metrics: { pct: { value: 100, target: 100, op: ">=", met: true } }, summary: "new" };
  await store.appendRun(CHAT, record);
  const grown = await duties.view(CHAT);
  assert.equal(grown.find(view => view.duty.id === "d8")?.runs[0]?.summary, "new", "an append reaches a view built from the settled parse");
  for (const view of grown) assert.deepEqual(view.runs, expected(await store.runs(CHAT), view.duty.id), view.duty.id);

  await writeFile(join(store.dir, "next.tmp"), text.replace(/"summary":"run (\d+) of d8/g, '"summary":"rewritten run $1 of d8'));
  await rename(join(store.dir, "next.tmp"), join(store.dir, `${CHAT}.runs.jsonl`));
  const rewritten = await duties.view(CHAT);
  assert.match(rewritten.find(view => view.duty.id === "d8")?.runs[0]?.summary ?? "", /^rewritten/, "another process's rewrite reaches the view");
  for (const view of rewritten) assert.deepEqual(view.runs, expected(await store.runs(CHAT), view.duty.id), view.duty.id);
});
