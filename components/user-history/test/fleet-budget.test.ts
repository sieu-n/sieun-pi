import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyJobHost, dutyJobKind } from "../src/chat-duty-job.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIX_UNLISTED_MS, FLEET_GB, FleetBudget, type FleetAsk, isProdAlert, WORKER_GB } from "../src/fleet-budget.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

// The reboot at 13:48:58Z on 10-15 (kern.boottime), from the session files and browser-chat/service.log: in the 57 min to 14:46Z the server
// asked for 48 fix sessions (one duty 7 times, 5 chats with 2 to 7), 8 duty and check-in runs, 15 duty restarts and 6 send-backs, and the Prime
// workers went from 0 to 37 GB while pi-pool's queue grew to 102 turns for 12 slots.

const clock = () => {
  let now = Date.UTC(2026, 9, 15, 13, 50, 0);
  return { now: () => now, sleep: async (ms: number) => { now += ms; await new Promise(resolve => setImmediate(resolve)); } };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const queue = (queued: number, limit = 12): AgentQueueReading => ({ enabled: true, macWorkingMax: limit, governor: { limit }, queued: Array.from({ length: queued }, (_, i) => ({ session: `q${i}` })), working: [] }) as unknown as AgentQueueReading;

test("starts go one at a time in the order they asked, only while the workers hold under 16 GB", async () => {
  const time = clock();
  const reads = [17.2, 17.2, 14.0, 14.0, 14.0];
  const budget = new FleetBudget({ gb: async () => reads.shift() ?? 14.0, live: async () => false, log: () => {}, readMs: 15_000, ...time });
  const order: string[] = [];
  const asks: FleetAsk[] = [{ kind: "duty", label: "a" }, { kind: "checkin", label: "b" }, { kind: "sendback", label: "c" }, { kind: "duty", label: "d" }];
  const all = asks.map(ask => budget.admit(ask).then(done => { order.push(ask.label); done(); }));
  await Promise.all(all);
  // 14.0 GB lets 3 through before the next read (14.0, 14.72, 15.44; a 4th would make 16.16), so d waits for the next read.
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(14.0 + WORKER_GB * 3 >= FLEET_GB, true);
});

test("a fourth start waits for the next read once three made the projection cross 16 GB", async () => {
  const time = clock();
  let reads = 0;
  const budget = new FleetBudget({ gb: async () => { reads++; return 14.0; }, live: async () => false, log: () => {}, readMs: 15_000, ...time });
  const started = [0, 1, 2, 3].map(i => budget.admit({ kind: "duty", label: `j${i}` }));
  await Promise.all(started);
  assert.equal(reads, 2, "the 4th start needed a second read");
});

test("today's reboot: a chat gets one fix job at a time, and other chats' starts go ahead of a held fix", async () => {
  const time = clock();
  const log: string[] = [];
  const budget = new FleetBudget({ gb: async () => 4.0, live: async () => true, log: line => log.push(line), readMs: 15_000, ...time });
  // api portal vp's d2 asked for "fix portal matches crawler" 7 times between 14:01Z and 14:39Z; slack green guy's d1 6 times.
  const portal = "01a1301d-18de-7129-a559-cfb92f9b5fb1", slack = "01a11b0b-7c15-73da-9481-8de15903eab4";
  const got: string[] = [];
  const first = await budget.admit({ kind: "fix", chat: portal, label: "fix portal matches crawler api portal vp 22:58" });
  first("01a13fdd-portal");
  const second = budget.admit({ kind: "fix", chat: portal, label: "fix portal matches crawler api portal vp 23:01" }).then(done => { got.push("portal 23:01"); done("x"); });
  const other = budget.admit({ kind: "fix", chat: slack, label: "fix visitors become paying users slack green guy 22:58" }).then(done => { got.push("slack 22:58"); done("y"); });
  await other;
  await settle();
  assert.deepEqual(got, ["slack 22:58"], "the second portal fix waits while the first is live");
  await time.sleep(FIX_UNLISTED_MS * 10);
  await settle();
  assert.deepEqual(got, ["slack 22:58"], "still held: the first portal fix works");
  budget.stop();
  void second;
});

test("a held fix goes once its chat's fix job is no longer live", async () => {
  const time = clock();
  const live = new Set(["fixA"]);
  const budget = new FleetBudget({ gb: async () => 4.0, live: async session => live.has(session), log: () => {}, readMs: 15_000, ...time });
  const chat = "01a115e2-9544-7204-b8db-8ce4d5319048";
  (await budget.admit({ kind: "fix", chat, label: "fix crawler pipeline Crawler VP 22:53" }))("fixA");
  let second = false;
  const held = budget.admit({ kind: "fix", chat, label: "fix crawler pipeline Crawler VP 22:56" }).then(done => { second = true; done("fixB"); });
  await time.sleep(FIX_UNLISTED_MS + 1);
  await settle();
  assert.equal(second, false);
  live.delete("fixA");
  await held;
  assert.equal(second, true);
});

test("a fix job of the chat from before a service restart holds the chat's next fix", async () => {
  const time = clock();
  let before = true;
  const budget = new FleetBudget({ gb: async () => 4.0, live: async () => false, fixLive: async () => before, log: () => {}, readMs: 15_000, ...time });
  const asked = budget.admit({ kind: "fix", chat: "c", label: "fix x" });
  await settle();
  assert.equal(await Promise.race([asked.then(() => "went"), settle().then(() => "held")]), "held");
  before = false;
  await asked;
});

test("pi-pool's queue at 14:39Z (102 turns for 12 slots) shuts the budget even under 16 GB", async () => {
  const time = clock();
  const budget = new FleetBudget({ gb: async () => 9.5, queue: async () => queue(102), live: async () => false, log: () => {}, ...time });
  assert.match(await budget.held() ?? "", /102 turns for 12 slots/);
  assert.equal(await budget.tryAdmit({ kind: "wake", label: "w" }), null);
  const open = new FleetBudget({ gb: async () => 9.5, queue: async () => queue(41), live: async () => false, log: () => {}, ...time });
  assert.equal(await open.held(), null);
  assert.notEqual(await open.tryAdmit({ kind: "wake", label: "w" }), null);
});

test("tryAdmit yields to starts that already wait", async () => {
  const time = clock();
  let gb = 17.0;
  const budget = new FleetBudget({ gb: async () => gb, live: async () => false, log: () => {}, readMs: 15_000, ...time });
  const waiting = budget.admit({ kind: "duty", label: "d" });
  await settle();
  gb = 8.0;
  assert.equal(await budget.tryAdmit({ kind: "continue", label: "c" }), null);
  await waiting;
});

test("the boot replay starts at most what fits under 16 GB and one fix per chat, where the old code started all 73", async () => {
  const time = clock();
  let workers = 0.0;
  let admitted = 0;
  const budget = new FleetBudget({ gb: async () => workers, live: async () => true, log: () => {}, readMs: 15_000, ...time });
  const chats = ["portal", "crawler", "slack", "launch", "ops", "ci", "harness", "seo", "frontend"];
  const fixesPerChat: Record<string, number> = { portal: 7, crawler: 10, slack: 6, launch: 8, ops: 3, ci: 3, harness: 5, seo: 1, frontend: 1 };
  const asks: FleetAsk[] = [];
  for (const chat of chats) for (let i = 0; i < fixesPerChat[chat]!; i++) asks.push({ kind: "fix", chat, label: `fix ${chat} ${i}` });
  for (let i = 0; i < 8; i++) asks.push({ kind: i < 7 ? "checkin" : "duty", label: `run ${i}` });
  for (let i = 0; i < 15; i++) asks.push({ kind: "duty", label: `restart ${i}` });
  for (let i = 0; i < 6; i++) asks.push({ kind: "sendback", label: `back ${i}` });
  assert.equal(asks.length, 44 + 8 + 15 + 6);
  const fixChats = new Map<string, number>();
  for (const ask of asks) void budget.admit(ask).then(done => {
    admitted++;
    workers += WORKER_GB;
    if (ask.kind === "fix") fixChats.set(ask.chat!, (fixChats.get(ask.chat!) ?? 0) + 1);
    done(`s${admitted}`);
  });
  for (let i = 0; i < 40; i++) await time.sleep(15_000);
  await settle();
  assert.equal(admitted, Math.ceil(FLEET_GB / WORKER_GB), "22 starts fill the 16 GB budget");
  assert.ok([...fixChats.values()].every(count => count === 1), "never two fix jobs of one chat");
  assert.equal(budget.queued().length, asks.length - admitted);
  budget.stop();
});

test("dutyJobKind reads the job's kind from its name", () => {
  assert.equal(dutyJobKind("fix portal matches crawler api portal vp 22:58"), "fix");
  assert.equal(dutyJobKind("check-in Crawler VP 22:41"), "checkin");
  assert.equal(dutyJobKind("mac stays usable AI harness developer environment 22:41"), "duty");
});

test("a duty job's create and send-back wait for the fleet budget outside the one start lane", async () => {
  const asked: FleetAsk[] = [];
  const gates = new Map<string, () => void>();
  const fleet = { admit: (ask: FleetAsk) => { asked.push(ask); return new Promise<(session?: string) => void>(resolve => { gates.set(ask.label, () => resolve(() => {})); }); } };
  const created: string[] = [];
  const prompts: string[] = [];
  const host = dutyJobHost({
    threads: { create: async (input: { name?: string }) => { created.push(input.name!); return { id: `id-${input.name}` }; }, prompt: async (id: string) => { prompts.push(id); } } as never,
    archives: { add: async () => {} }, rows: async () => [], registry: { add: async () => {}, remove: async () => {}, chatOf: async () => undefined } as never,
    board: () => "", fleet });
  const chatA = { id: "A", name: "Crawler VP", cwd: "/r", board: "" }, chatB = { id: "B", name: "frontend bro", cwd: "/r", board: "" };
  const fixA = host.start(chatA, "fix crawler pipeline Crawler VP 22:53", "brief");
  const runB = host.start(chatB, "check-in frontend bro 22:50", "brief");
  await settle();
  assert.deepEqual(asked.map(ask => [ask.kind, ask.chat]), [["fix", "A"], ["checkin", "B"]]);
  gates.get("check-in frontend bro 22:50")!();
  await runB;
  assert.deepEqual(created, ["check-in frontend bro 22:50"], "B started while A's fix still waits");
  gates.get("fix crawler pipeline Crawler VP 22:53")!();
  await fixA;
  const back = host.steer!({ id: "id-x", name: "x" }, "[duty] go on");
  await settle();
  assert.equal(asked.at(-1)?.kind, "sendback");
  assert.equal(prompts.includes("id-x"), false);
  gates.get("x")!();
  await back;
  assert.equal(prompts.includes("id-x"), true);
});

// 10-16 at about 04:00 KST the owner said "FIRST KILL EVERYTHING FOR NOW UNTIL EVERYTHING IS FIXED"; the 03:55 KST batch had started 6
// check-ins and 8 fix jobs within 1 min of a daemon restart, all under 16 GB (service.log 18:56:03Z to 18:57:24Z).
test("the stop switch admits nothing while its file exists, at any memory, and lets the waiting starts go once it is deleted", async () => {
  const time = clock();
  const dir = await mkdtemp(join(tmpdir(), "fleet-stop-"));
  const stopFile = join(dir, "fleet-stop.json");
  await writeFile(stopFile, JSON.stringify({ why: "owner: kill everything until fixed" }));
  const budget = new FleetBudget({ gb: async () => 2.0, live: async () => false, log: () => {}, stopFile, readMs: 15_000, ...time });
  assert.match(await budget.switchedOff() ?? "", /stop switch is on \(owner: kill everything until fixed\)/);
  assert.equal(await budget.tryAdmit({ kind: "wake", label: "w" }), null);
  assert.equal(await budget.tryAdmit({ kind: "continue", label: "c" }), null);
  const started: string[] = [];
  const asks: FleetAsk[] = [{ kind: "checkin", label: "check-in launch main bro 03:55" }, { kind: "fix", chat: "c1", label: "fix limits rest on evidence ops guy 03:55" },
    { kind: "sendback", label: "fix arbitrary limits Crawler VP 22:59" }, { kind: "duty", label: "mac stays usable 03:55" }];
  const all = asks.map(ask => budget.admit(ask).then(done => { started.push(ask.label); done("s"); }));
  for (let i = 0; i < 20; i++) await time.sleep(15_000);
  assert.deepEqual(started, [], "nothing starts in 5 min with the switch on");
  await rm(stopFile);
  await Promise.all(all);
  assert.deepEqual(started, asks.map(ask => ask.label));
  assert.equal(await budget.switchedOff(), null);
});

test("prod alerts pass the stop switch and other alerts wait, by pi-pool's prod rule", () => {
  assert.equal(isProdAlert("[alert] A Grafana alert you own started firing: \"prod [no value]: Postgres WAL archive failing\""), true);
  assert.equal(isProdAlert("virev-prod-media-10 on us-metal01 is over 85% of its mem_limit"), true);
  assert.equal(isProdAlert("staging [no value]: Postgres WAL archive failing"), false);
  assert.equal(isProdAlert("us-metal01 CPU >85% for 30m"), false);
});

test("memory pressure high or critical shuts the budget with the workers under 16 GB (10-16 04:00 KST: 11.8 GB of workers, browsers about 19 GB)", async () => {
  const time = clock();
  const at = (level: string) => async () => ({ ...queue(4, 8), governor: { limit: 8, level } }) as unknown as AgentQueueReading;
  for (const level of ["high", "critical"]) {
    const budget = new FleetBudget({ gb: async () => 11.8, queue: at(level), live: async () => false, log: () => {}, ...time });
    assert.equal(await budget.held(), `pi-pool reads memory pressure ${level}`);
    assert.equal(await budget.tryAdmit({ kind: "fix", chat: "c", label: "fix x" }), null);
  }
  const ok = new FleetBudget({ gb: async () => 11.8, queue: at("ok"), live: async () => false, log: () => {}, ...time });
  assert.equal(await ok.held(), null);
});
