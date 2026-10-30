/**
 * Adding a duty through the chat server, as scripts/duties/add.ts does for a pi agent: a set adds a duty to a fresh agent, a second set with the
 * same name updates it and keeps its runs, the tick runs it on its schedule, and a remove deletes it with its runs and precheck state.
 * Prime's scripts/duties/add.ts and remove.ts send a duty for an agent of this chat here, and keep Prime's store for a Prime chat.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-set.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DutyRow } from "../../web/src/lib/api/types.ts";
import { MORNING_BANDS } from "../../web/src/lib/api/shared/chat-duties.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let agent: string;
const work = mkdtempSync(join(tmpdir(), "duty-set-"));
const script = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 100 }, flagged: [] }))`;
const definition = {
  name: "Probe system", ownerWords: "keep the probe up", goal: "the probe answers", onMiss: "fix the probe",
  metrics: [{ key: "up", label: "Up", op: ">=", target: 99, unit: "%" }],
  precheck: { command: ["node", "-e", script], cwd: work, timeoutMs: 30_000 },
};
const duties = async (): Promise<DutyRow[]> => (await s.get<{ duties: DutyRow[] }>(`/api/agents/${agent}/duties`)).duties;
const set = (duty: unknown) => s.send<{ duties: DutyRow[]; result: string; error?: string }>("POST", `/api/agents/${agent}/duties`, { action: "set", duty });

before(async () => {
  s = await start();
  agent = (await s.send<{ id: string }>("POST", "/api/agents", { name: "duty set probe" })).body.id;
});
after(async () => {
  await s.close();
});

test("a set adds the duty to a fresh agent, daily at a free minute of the high morning band", async () => {
  assert.deepEqual(await duties(), []);
  const added = await set(definition);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.result, "added d1");
  const [row] = await duties();
  assert.equal(row!.duty.name, "Probe system");
  assert.equal(row!.duty.metrics[0]!.headline, true);
  assert.equal(row!.schedule.kind, "daily");
  const [h, m] = (row!.schedule as { at: string }).at.split(":").map(Number);
  const minute = h! * 60 + m!;
  assert.ok(minute >= MORNING_BANDS.high[0] && minute <= MORNING_BANDS.high[1], `${minute} is outside the high band`);
});

test("a second set with the same name updates the duty and keeps its id, runs and run count", async () => {
  const ran = await s.send("POST", `/api/agents/${agent}/duties`, { action: "run", duty: "d1" });
  assert.equal(ran.status, 200);
  const [measured] = await until(() => duties(), rows => !rows[0]!.running && rows[0]!.runs.length === 1);
  assert.equal(measured!.runs[0]!.verdict, "met");
  const updated = await set({ ...definition, goal: "the probe answers fast", schedule: { kind: "every", minutes: 60 } });
  assert.equal(updated.body.result, "updated d1");
  const rows = await duties();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.duty.goal, "the probe answers fast");
  assert.deepEqual(rows[0]!.schedule, { kind: "every", minutes: 60 });
  assert.deepEqual(rows[0]!.runs.map(run => run.at), measured!.runs.map(run => run.at));
  assert.equal((await s.get(`/api/agents/${agent}/config`)).swarm.duties[0].runs, 1);
  assert.equal((await set({ ...definition, goal: "the probe answers fast" })).body.result, "unchanged d1", "a set with no schedule keeps the duty's schedule");
});

test("the tick runs the set duty when its schedule comes due, and not before", async () => {
  const [row] = await duties();
  const lastAt = row!.runs[0]!.at;
  await s.app.boards.tick(lastAt + 59 * 60_000);
  assert.equal((await duties())[0]!.running, false);
  assert.equal((await duties())[0]!.runs.length, 1);
  await s.app.boards.tick(lastAt + 61 * 60_000);
  const [ran] = await until(() => duties(), rows => !rows[0]!.running && rows[0]!.runs.length === 2);
  assert.equal(ran!.runs[0]!.trigger, "schedule");
  assert.equal(ran!.runs[0]!.verdict, "met");
});

test("a remove deletes the duty with its runs and precheck state, and a second remove changes nothing", async () => {
  const stateDir = join(s.app.boards.dir(agent), "duties");
  assert.ok(readdirSync(stateDir).some(name => name.startsWith("d1")));
  const removed = await s.send<{ duties: DutyRow[]; result: string }>("POST", `/api/agents/${agent}/duties`, { action: "remove", duty: "d1" });
  assert.equal(removed.body.result, "removed d1");
  assert.deepEqual(removed.body.duties, []);
  assert.ok(!readdirSync(stateDir).some(name => name.startsWith("d1")));
  assert.equal((await s.send<{ result: string }>("POST", `/api/agents/${agent}/duties`, { action: "remove", duty: "d1" })).body.result, "no duty d1");
});

test("a relative precheck cwd, a bad definition and an unknown agent are refused", async () => {
  const relative = await set({ ...definition, precheck: { ...definition.precheck, cwd: "../.." } });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error!, /relative/);
  const bad = await set({ ...definition, goal: "" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error!, /^goal/);
  const unknown = await s.send("POST", "/api/agents/ag_nobody/duties", { action: "set", duty: definition });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await duties(), []);
  assert.ok(existsSync(work));
});

test("add.ts and remove.ts send a duty for an agent of this chat here, with its precheck cwd resolved against the duty file, and keep Prime's store for a Prime chat", async () => {
  const userHistory = fileURLToPath(new URL("../../../../legacy/prime/user-history/", import.meta.url));
  const script = (name: string) => join(userHistory, "scripts/duties", name);
  const primeData = mkdtempSync(join(tmpdir(), "duty-set-prime-"));
  const folder = join(work, "duties");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "probe.duty.json"), JSON.stringify({ ...definition, name: "Probe by script", precheck: { ...definition.precheck, cwd: ".." } }));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: primeData, PI_HOST_CHAT_URL: s.base };
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", ...args], { cwd: userHistory, env }).then(out => out.stdout);
  assert.match(await run([script("add.ts"), agent, join(folder, "probe.duty.json")]), /^added d\d+ "Probe by script" in ag_duty-set-probe daily \d\d:\d\d, on the new chat /);
  const [row] = (await duties()).filter(duty => duty.duty.name === "Probe by script");
  assert.ok(row);
  const file = JSON.parse(readFileSync(s.app.boards.dutiesPath(agent), "utf8")) as { duties: { name: string; precheck: { cwd: string } }[] };
  assert.equal(file.duties.find(duty => duty.name === "Probe by script")!.precheck.cwd, work);
  assert.ok(!existsSync(join(primeData, ".prime")), "Prime's store stays untouched for an agent of this chat");
  assert.match(await run([script("remove.ts"), "--name", "Probe by script", "--chat", agent]), /^removed d\d+ "Probe by script" from ag_duty-set-probe, on the new chat\n1 removed\n$/);
  assert.deepEqual(await duties(), []);
  const prime = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
  assert.match(await run([script("add.ts"), prime, join(folder, "probe.duty.json")]), /^added d1 "Probe by script" in 01a14210-\S+ daily \d\d:\d\d, priority high\n$/);
  assert.equal(JSON.parse(readFileSync(join(primeData, ".prime/agent/browser-chat/duties", `${prime}.json`), "utf8")).duties[0].name, "Probe by script");
});
