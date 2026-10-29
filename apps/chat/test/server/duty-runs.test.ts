/**
 * A chat's duties with runs imported from Prime and runs this server recorded: GET /duties lists every run newest first with the judged last
 * verdict and the next run, a run shows as running and reaches the page as a `duties` event, and a second import keeps the recorded runs.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-runs.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRow, LiveEvent } from "../../web/src/lib/api/types.ts";
import type { DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { nextRun } from "../../server/boards.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const PRIME_ID = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };
const result = (value: number) => ({ up: { value, target: 99, op: ">=" as const, met: value >= 99 } });

/** A run as Prime's chat wrote it: a rounded slot, a push or schedule trigger, and an after-job measure that can flip the verdict. */
const imported = (at: number, value: number, afterValue?: number): DutyRunRecord => ({
  duty: "d1", at, slot: at - (at % 60_000), trigger: "push", ms: 900, verdict: value >= 99 ? "met" : "missed", metrics: result(value), summary: `up ${value}`,
  ...(afterValue === undefined ? {} : { after: { at: at + HOUR, verdict: afterValue >= 99 ? "met" : "missed", metrics: result(afterValue), summary: `up ${afterValue}` } }),
} as DutyRunRecord);

let s: Running;
let prime: string;
const now = Date.now();
const chatDir = () => join(s.app.store.dir, "boards", ids.vent);
const duties = async (): Promise<DutyRow[]> => (await s.get<{ duties: DutyRow[] }>(`/api/threads/${ids.vent}/duties`)).duties;

before(async () => {
  s = await start();
  const work = mkdtempSync(join(tmpdir(), "duty-runs-"));
  const script = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 100 }, flagged: [] }))`;
  const duty = { id: "d1", name: "Vent gateway", ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "daily", at: "07:04" },
    precheck: { command: ["node", "-e", script], cwd: work, timeoutMs: 30_000 }, onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now,
    lastRunAt: now - HOUR, runCount: 3 };
  // The Prime export: two runs from 10 and 6 days ago, the newer one missed before its job and met after it.
  prime = mkdtempSync(join(tmpdir(), "prime-chat-"));
  mkdirSync(join(prime, "duties"));
  writeFileSync(join(prime, "duties", `${PRIME_ID}.json`), JSON.stringify({ version: 1, duties: [duty] }));
  const old = [imported(now - 10 * 24 * HOUR, 100), imported(now - 6 * 24 * HOUR, 90, 100)];
  writeFileSync(join(prime, "duties", `${PRIME_ID}.runs.jsonl`), old.map(run => JSON.stringify(run)).join("\n"));
  // The chat server's own file after the move: the imported runs plus one run it recorded an hour ago, in the order the file holds them.
  mkdirSync(chatDir(), { recursive: true });
  const recorded = { duty: "d1", at: now - HOUR, slot: now - HOUR, trigger: "schedule", ms: 1200, verdict: "missed", metrics: result(95), summary: "up 95",
    detail: join(chatDir(), "duties", "d1-recorded.json"), job: { id: "job-1", name: "Vent gateway duty recorded" } };
  writeFileSync(join(chatDir(), "duties.json"), JSON.stringify({ duties: [duty], runs: { d1: [...old, recorded] } }));
});
after(async () => {
  await s.close();
});

test("GET /duties lists imported and recorded runs newest first, with the judged last verdict and the next run", async () => {
  const [row] = await duties();
  assert.deepEqual(row!.runs.map(run => run.at), [now - HOUR, now - 6 * 24 * HOUR, now - 10 * 24 * HOUR]);
  assert.equal(row!.running, false);
  assert.deepEqual(row!.last, { verdict: "missed", at: now - HOUR, streak: 1, afterJob: false });
  assert.equal(row!.nextAt, nextRun({ kind: "daily", at: "07:04" }, now - HOUR));
  assert.ok(row!.nextAt! > now);
  assert.equal(row!.card.job?.name, "Vent gateway duty recorded");
});

test("a run shows as running, and its start and end reach the page as duties events", async () => {
  const live = await s.live();
  const ran = await s.send("POST", `/api/threads/${ids.vent}/duties`, { duty: "d1", action: "run" });
  assert.equal(ran.status, 200);
  const isDuties = (event: LiveEvent): event is Extract<LiveEvent, { type: "duties" }> => event.type === "duties" && event.chatId === ids.vent;
  const started = await live.waitFor(event => isDuties(event) && event.duties[0]!.running);
  assert.ok(isDuties(started));
  const ended = await live.waitFor(event => isDuties(event) && !event.duties[0]!.running && event.duties[0]!.runs.length === 4);
  assert.ok(isDuties(ended));
  live.close();
  const [row] = ended.duties;
  assert.equal(row!.runs[0]!.trigger, "owner");
  assert.ok(row!.runs[0]!.at >= now);
  assert.deepEqual(row!.runs.slice(1).map(run => run.at), [now - HOUR, now - 6 * 24 * HOUR, now - 10 * 24 * HOUR]);
  assert.equal(row!.last?.verdict, "met");
  assert.equal(row!.nextAt, nextRun({ kind: "daily", at: "07:04" }, row!.runs[0]!.at));
  assert.deepEqual((await duties())[0]!.runs.map(run => run.at), row!.runs.map(run => run.at));
});

test("an import run again keeps the runs this server recorded", async () => {
  const before = (await duties())[0]!.runs.map(run => run.at);
  s.app.config.sharedDir = prime;
  const imported = await s.send("POST", `/api/threads/${ids.vent}/import-prime`, { prime: PRIME_ID });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.runs, 4);
  assert.deepEqual((await duties())[0]!.runs.map(run => run.at), before);
  const file = JSON.parse(readFileSync(join(chatDir(), "duties.json"), "utf8")) as { runs: Record<string, DutyRunRecord[]> };
  assert.equal(file.runs.d1!.length, 4);
});

test("the agent's config reads the same judged verdict as the Duties card", async () => {
  await until(() => duties(), rows => !rows[0]!.running);
  const config = await s.get(`/api/agents/${ids.vent}/config`);
  assert.equal(config.swarm.duties[0].lastVerdict, "met");
});
