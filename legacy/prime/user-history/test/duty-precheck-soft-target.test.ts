// Guards the soft precheck target (owner rule c98): until 10-19 the duty runner killed every precheck at 120 s (PRECHECK_TIMEOUT_MS) and paused a
// duty after 3 error runs in a row, and ops guy's Grafana precheck, 188 s serially, had to be made parallel to fit.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties, precheckHardStopMs } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type Duty, overrunWords, parseDutyInput } from "../src/shared/chat-duties.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

async function runOnce(body: string, timeoutMs: number, previousErrors = 0) {
  const dir = await mkdtemp(join(tmpdir(), "duty-soft-target-"));
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, body);
  const store = new DutyStore(dir);
  const now = Date.parse("2026-10-19T02:00:00Z");
  const duty: Duty = {
    id: "d1", name: "Grafana", ownerWords: "watch grafana", goal: "panels load", metrics: [{ key: "broken", label: "Broken panels", op: "<=", target: 0, headline: true }],
    schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs }, onMiss: "fix it", status: "active",
    createdAt: now - 31 * MIN, updatedAt: now - 31 * MIN, runCount: previousErrors,
  };
  await store.update(CHAT, duties => { duties.push(duty); });
  for (let index = previousErrors; index > 0; index--) {
    await store.appendRun(CHAT, { duty: "d1", at: now - index * 30 * MIN, trigger: "schedule", ms: 1, verdict: "error", metrics: {}, summary: "the precheck failed" });
  }
  const logs: string[] = [];
  const briefs: string[] = [];
  const duties = new Duties(store, {
    isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    jobs: {
      chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
      working: async () => false,
      retire: async () => {},
      start: async (_chat, name, brief) => { briefs.push(String(brief)); return { id: "job-1", name }; },
    },
  } as ConstructorParameters<typeof Duties>[1]);
  await duties.tick();
  await duties.settled();
  duties.close();
  return { dir, store, logs, briefs, runs: await store.runs(CHAT), list: await store.list(CHAT) };
}

test("a precheck past its soft target finishes, and its run, log, detail file and brief say how long it took against the target", async () => {
  const { dir, runs, logs } = await runOnce(
    `import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { broken: 0 } })), 1600);`, 1000);
  try {
    const [run] = runs;
    assert.equal(run!.verdict, "met");
    assert.ok(run!.overrun, "the run records the overrun");
    assert.equal(run!.overrun!.targetMs, 1000);
    assert.ok(run!.overrun!.ms >= 1600, `took ${run!.overrun!.ms} ms`);
    assert.match(overrunWords(run!.overrun!), /^the precheck took \d+ s, over its 1 s target$/);
    assert.ok(logs.some(line => /past its 1 s target and keeps running, up to its hard stop of 30 min/.test(line)), logs.join("\n"));
    const detail = await readFile(join(dir, "duties", CHAT, `d1-${run!.detail!.split("d1-")[1]!.replace(".json", ".flagged.md")}`), "utf8");
    assert.match(detail, /This run went over: the precheck took \d+ s, over its 1 s target/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a precheck inside its target records no overrun", async () => {
  const { dir, runs } = await runOnce(`import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { broken: 0 } }));`, 30_000);
  try { assert.equal(runs[0]!.verdict, "met"); assert.equal(runs[0]!.overrun, undefined); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test("a precheck that prints more than 1 MB is not killed for it, and a failing one keeps all of its stderr in a file", async () => {
  const big = await runOnce(`import { writeFileSync } from "node:fs"; process.stdout.write("x".repeat(3 << 20)); process.stderr.write("y".repeat(3 << 20)); ` +
    `writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { broken: 0 } }));`, 30_000);
  try { assert.equal(big.runs[0]!.verdict, "met"); } finally { await rm(big.dir, { recursive: true, force: true }); }
  const failing = await runOnce(`console.error("first line"); console.error("grafana: 502"); process.exit(3);`, 30_000);
  try {
    const error = failing.runs[0]!.error!;
    assert.match(error, /^exit 3: first line grafana: 502 \(all of stderr: .+d1-.+\.stderr\.log\)$/);
    assert.equal(await readFile(/\(all of stderr: (.+)\)$/.exec(error)![1]!, "utf8"), "first line\ngrafana: 502\n");
  } finally { await rm(failing.dir, { recursive: true, force: true }); }
});

test("a fourth error run in a row keeps the duty active and tells its job the streak against the target", async () => {
  const { dir, list, briefs } = await runOnce(`process.exit(1);`, 30_000, 3);
  try {
    assert.equal(list[0]!.status, "active");
    assert.ok(briefs.some(brief => /failed 4 runs in a row, over the target of 3: fix the precheck first/.test(brief)), briefs.join("\n---\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a duty's own timeoutMs above 120 s is kept as its target, and the hard stop is its schedule gap, never under that target", () => {
  const parsed = parseDutyInput({ name: "Grafana", ownerWords: "w", goal: "g", onMiss: "o", metrics: [{ key: "broken", label: "Broken", op: "<=", target: 0 }],
    schedule: { kind: "daily", at: "07:00" }, precheck: { command: ["node", "p.mjs"], cwd: ".", timeoutMs: 240_000 } }, "d1", 0);
  assert.equal(parsed.precheck.timeoutMs, 240_000);
  assert.equal(precheckHardStopMs(parsed), 24 * 60 * MIN);
  assert.equal(precheckHardStopMs({ schedule: { kind: "every", minutes: 1 }, precheck: { command: ["x"], cwd: ".", timeoutMs: 240_000 } }), 240_000);
});
