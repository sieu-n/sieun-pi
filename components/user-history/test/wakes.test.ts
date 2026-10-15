import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { withWakes } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { parseWake, pendingWakes, RUN_LOOK_MS, type RunState, startWakes, TICKED, type WakeOn, Wakes, waking } from "../src/wakes.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

// 10-14 20:5xZ: 125 of 152 working sessions had ended their turn and waited on a bash handle in their Python kernel (82 on a CI run, 11 on a
// sleep), so Prime counted them busy, never passivated them and never evicted their trees: 8.69 GB of kernels, and 18 root jobs kept a Bun
// worker each up only to wait (8.92 GB). board.wake writes a wake file and the job ends its turn; the chat service sends the wake.

const NOW = Date.parse("2026-10-14T12:00:00Z");
const MIN = 60_000;
const SESSION_A = "01a13a49-d957-71b8-bb92-f4ccb8d4eed4";
const SESSION_B = "01a13a3e-103d-70f9-a848-580a776e5501";

async function fixture(states: Map<number, RunState>) {
  const dir = await mkdtemp(join(tmpdir(), "wakes-"));
  let now = NOW;
  const reads: number[] = [];
  const sent: { session: string; text: string }[] = [];
  const failing = new Set<string>();
  const gone = new Set<string>();
  const stamps = new Map<number, string>();
  const evicted = new Map<string, string>();
  const started: string[] = [];
  const wakes = new Wakes({ dir, now: () => now, log: () => {},
    startRoot: async root => { started.push(root); for (const [child, of] of evicted) if (of === root) evicted.delete(child); },
    runState: async (on: Extract<WakeOn, { kind: "run" }>) => { reads.push(on.run); return states.get(on.run) ?? { done: false }; },
    stamp: async run => stamps.get(run) ?? null,
    deliver: async (session, text) => {
      if (failing.has(session)) throw new Error("Timed out waiting for daemon worker response");
      if (gone.has(session) || evicted.has(session)) return "gone";
      sent.push({ session, text });
      return "sent";
    } });
  const put = (name: string, body: unknown) => writeFile(join(dir, name), JSON.stringify(body));
  return { dir, wakes, reads, sent, failing, gone, stamps, evicted, started, put, files: () => readdir(dir), at: (ms: number) => { now = ms; } };
}

test("wakes: a session waiting on a CI run is messaged once when the run finishes, and its wake file goes", async () => {
  const states = new Map<number, RunState>();
  const f = await fixture(states);
  await f.put(`${SESSION_A}-run-38556270524.json`, { session: SESSION_A, on: { kind: "run", run: 38556270524 }, note: "land r11 on green", since: NOW - 20 * MIN });
  assert.equal(await f.wakes.tick(), 0);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.files()).length, 1);
  states.set(38556270524, { done: true, conclusion: "success", url: "https://github.com/sieu-n/auto-sns-agent/actions/runs/38556270524", label: "verify-dev.yml on ci/rpo-stack-r11" });
  f.stamps.set(38556270524, "moved");
  assert.equal(await f.wakes.tick(), 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.session, SESSION_A);
  assert.match(f.sent[0]!.text, /^\[wake\] Run 38556270524 finished: success \(verify-dev\.yml on ci\/rpo-stack-r11\)\./);
  assert.match(f.sent[0]!.text, /land r11 on green/);
  assert.deepEqual(await f.files(), []);
  assert.equal(await f.wakes.tick(), 0);
  assert.equal(f.sent.length, 1);
});

test("wakes: a run whose CI cache stamp did not move is read again only after RUN_LOOK_MS, and two waiters on one run cost one read", async () => {
  const f = await fixture(new Map());
  f.stamps.set(7, "s1");
  await f.put(`${SESSION_A}-run-7.json`, { session: SESSION_A, on: { kind: "run", run: 7 }, note: "", since: NOW });
  await f.put(`${SESSION_B}-run-7.json`, { session: SESSION_B, on: { kind: "run", run: 7 }, note: "", since: NOW });
  await f.wakes.tick();
  assert.deepEqual(f.reads, [7]);
  f.at(NOW + 30_000);
  await f.wakes.tick();
  assert.deepEqual(f.reads, [7]);
  f.stamps.set(7, "s2");
  await f.wakes.tick();
  assert.deepEqual(f.reads, [7, 7]);
  f.at(NOW + 30_000 + RUN_LOOK_MS);
  await f.wakes.tick();
  assert.deepEqual(f.reads, [7, 7, 7]);
});

test("wakes: a session's wakes due in one tick go out as one message, so a release driver with 17 finished runs is one turn, not 17", async () => {
  const states = new Map<number, RunState>();
  const f = await fixture(states);
  for (let run = 1; run <= 17; run++) {
    states.set(run, { done: true, conclusion: "success", url: `https://example.test/${run}`, label: "verify-dev.yml" });
    await f.put(`${SESSION_A}-run-${run}.json`, { session: SESSION_A, on: { kind: "run", run }, note: "", since: NOW });
  }
  await f.put(`${SESSION_B}-run-3.json`, { session: SESSION_B, on: { kind: "run", run: 3 }, note: "", since: NOW });
  assert.equal(await f.wakes.tick(), 2);
  assert.deepEqual(f.sent.map(({ session }) => session).sort(), [SESSION_A, SESSION_B].sort());
  const a = f.sent.find(({ session }) => session === SESSION_A)!;
  assert.equal(a.text.split("\n").length, 17);
  assert.match(a.text, /^\[wake\] Run 1 finished: success/);
  assert.deepEqual(await f.files(), []);
});

test("wakes: a time wake fires at its time and not before", async () => {
  const f = await fixture(new Map());
  const at = Date.parse("2026-10-14T22:30:00Z");
  await f.put(`${SESSION_A}-time.json`, { session: SESSION_A, on: { kind: "time", at }, note: "remeasure heavy demand", since: NOW });
  await f.wakes.tick();
  assert.equal(f.sent.length, 0);
  f.at(at + 5_000);
  assert.equal(await f.wakes.tick(), 1);
  assert.match(f.sent[0]!.text, /^\[wake\] It is 2026-10-14T22:30:05\.000Z, the time you set with board\.wake \(2026-10-14T22:30:00\.000Z\)\. Your note: remeasure heavy demand$/);
});

test("wakes: a failed send keeps the wake for the next tick, a session the daemon does not know is dropped, and a bad file is removed", async () => {
  const f = await fixture(new Map());
  await f.put(`${SESSION_A}-time.json`, { session: SESSION_A, on: { kind: "time", at: NOW - 1 }, note: "", since: NOW });
  await f.put(`${SESSION_B}-time.json`, { session: SESSION_B, on: { kind: "time", at: NOW - 1 }, note: "", since: NOW });
  await f.put("junk.json", { session: "x", on: { kind: "run", run: -1 } });
  f.failing.add(SESSION_A);
  f.gone.add(SESSION_B);
  assert.equal(await f.wakes.tick(), 0);
  assert.deepEqual(await f.files(), [`${SESSION_A}-time.json`]);
  f.failing.clear();
  assert.equal(await f.wakes.tick(), 1);
  assert.deepEqual(await f.files(), []);
});

test("wakes: replay of 10-15 12:29 to 12:31Z, five sends that each time out after 30 s keep TICKED under 2 min old while the tick runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wakes-ticked-"));
  const sessions = ["01a10db8", "01a12faa", "01a13ec4", "01a13ed2", "01a13ed9"].map(prefix => `${prefix}-0000-7000-8000-000000000000`);
  for (const session of sessions) await writeFile(join(dir, `${session}-time.json`), JSON.stringify({ session, on: { kind: "time", at: NOW - MIN }, note: "", since: NOW - 15 * MIN }));
  let now = NOW;
  const ages: number[] = [];
  let calls = 0;
  let done: () => void = () => {};
  const finished = new Promise<void>(resolve => { done = resolve; });
  const stop = startWakes({ dir, now: () => now, runState: async () => ({ done: false }), log: () => {},
    deliver: async () => {
      ages.push(now - Date.parse(await readFile(join(dir, TICKED), "utf8")));
      now += 30_000;
      if (++calls === sessions.length) setTimeout(done, 20);
      throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message".');
    } }, 5);
  await finished;
  stop();
  const first = ages.slice(0, sessions.length);
  assert.ok(Math.max(...first) <= 30_000, `TICKED ages ${first.join(", ")} ms`);
});

test("wakes: board.wake refuses while no service ticks, then writes the wake file this service reads, with the session id of a subagent or a root", async () => {
  const root = await mkdtemp(join(tmpdir(), "wake-skill-"));
  const child = join(root, "session-artifacts", SESSION_B, "sub-1b2103cc");
  await mkdir(child, { recursive: true });
  await writeFile(join(child, `${SESSION_A}.jsonl`), "");
  await writeFile(join(child, "semantic-edges.jsonl"), "");
  const data = join(root, "browser-chat");
  const script = 'import board; print(board.wake(run=38556270524, note="land")); print(board.wake(at="2026-10-14T22:30:00Z"))';
  const run = (sessionDir: string) => promisify(execFile)("python3", ["-B", "-c", script],
    { env: { ...process.env, PYTHONPATH: resolve(import.meta.dirname, "../../../skills/board/src"), RLM_SESSION_DIR: sessionDir, AGENT_CHAT_DATA_DIR: data } });
  await assert.rejects(run(child), /No chat service delivers wakes now \(.*\.ticked is missing\)\. Wait inside this turn with await bash\(\.\.\.\) instead\./);
  const stop = startWakes({ dir: join(data, "wakes"), runState: async () => ({ done: false }), deliver: async () => "sent", log: () => {} }, 5);
  for (let i = 0; i < 100 && !(await readdir(join(data, "wakes")).catch(() => [] as string[])).includes(TICKED); i++) await new Promise(done => setTimeout(done, 10));
  stop();
  const { stdout } = await run(child);
  assert.match(stdout, /^Wake set: the chat service messages this session when run 38556270524 finishes\. End this turn now/);
  await run(join(root, "session-artifacts", SESSION_B));
  const names = (await readdir(join(data, "wakes"))).filter(name => name !== TICKED).sort();
  assert.deepEqual(names, [`${SESSION_B}-run-38556270524.json`, `${SESSION_B}-time-1792017000.json`, `${SESSION_A}-run-38556270524.json`, `${SESSION_A}-time-1792017000.json`].sort());
  const wake = parseWake(JSON.parse(await readFile(join(data, "wakes", `${SESSION_A}-run-38556270524.json`), "utf8")));
  assert.deepEqual(wake && { session: wake.session, root: wake.root, on: wake.on, note: wake.note }, { session: SESSION_A, root: SESSION_B, on: { kind: "run", run: 38556270524 }, note: "land" });
  assert.equal(parseWake(JSON.parse(await readFile(join(data, "wakes", `${SESSION_B}-run-38556270524.json`), "utf8")))?.root, undefined);
  const time = parseWake(JSON.parse(await readFile(join(data, "wakes", `${SESSION_A}-time-1792017000.json`), "utf8")));
  assert.deepEqual(time?.on, { kind: "time", at: Date.parse("2026-10-14T22:30:00Z") });
});

test("wakes: a finished job that set a board.wake is kept by the cleanup, and deleted once its wake is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-cleanup-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const report = (name: string, body: string): ThreadMessage =>
    ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n${body}`, display: true, timestamp: NOW - MIN }) as ThreadMessage;
  threads.transcripts.set("c1", [report("redis streams phase out", "Pushed r11, verify-dev 38556270524 is running; I commit once it is green.")]);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const wakeDir = join(dir, "wakes");
  await mkdir(wakeDir);
  await writeFile(join(wakeDir, `${SESSION_A}-run-38556270524.json`), JSON.stringify({ session: SESSION_A, on: { kind: "run", run: 38556270524 }, note: "", since: NOW }));
  const plan: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: plan }, () => NOW), waking: session => waking(wakeDir, session) }, line => lines.push(line));
  await chats.adopt();
  const child: ChildAgent = { id: "sub-93487470", label: "redis streams phase out", sessionName: "redis streams phase out", sessionId: SESSION_A, status: "done",
    repliedSinceTask: true, lastActivityAt: NOW - MIN };
  threads.fire().live("c1", [{ ...child, status: "running", activity: { kind: "writing" } }]);
  threads.fire().children("c1", [child]);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), []);
  assert.ok(lines.includes("chat c1: kept job redis streams phase out: it waits on a board.wake"));
  await rm(join(wakeDir, `${SESSION_A}-run-38556270524.json`));
  threads.fire().idle("c1");
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-93487470"]);
  chats.close();
});

test("wakes: a child whose chat tree was evicted is reached by starting its root's worker first, and a wake with no root to start is dropped", async () => {
  const f = await fixture(new Map());
  const ROOT = "01a13a3e-103d-70f9-a848-580a776e5501";
  const CHILD = "01a13a7e-9bd4-7519-a1a4-f62625dbcb96";
  f.evicted.set(CHILD, ROOT);
  await f.put(`${CHILD}-time.json`, { session: CHILD, root: ROOT, on: { kind: "time", at: NOW - 1 }, note: "passivated child probe", since: NOW - 40 * MIN });
  assert.equal(await f.wakes.tick(), 1);
  assert.deepEqual(f.started, [ROOT]);
  assert.equal(f.sent[0]!.session, CHILD);
  f.gone.add(SESSION_A);
  await f.put(`${SESSION_A}-time.json`, { session: SESSION_A, on: { kind: "time", at: NOW - 1 }, note: "", since: NOW });
  assert.equal(await f.wakes.tick(), 0);
  assert.deepEqual(f.started, [ROOT]);
  assert.deepEqual(await f.files(), []);
});

test("wakes: a tick stamps TICKED when it starts, so a check-in during a long tick, such as the first one after a release restart, still sees the wakes owed", async () => {
  // VP of CI 10-15: ci release driver (01a138a6) ended its turn at 10:16:18Z on a board.wake on run 38708750431, the 19:32 KST release killed
  // the service mid-tick, and its restarted service's first tick was still reading runs at 10:33:27Z. The 10:33:18Z check-in read the stamp of
  // the old service's last finished tick, over WAKE_LATE_MS old, owed nothing, and listed "ci release driver thread: idle".
  const dir = await mkdtemp(join(tmpdir(), "wakes-restart-"));
  const driver = "01a138a6-4245-71b9-96bf-b2e1269c4d6a";
  const at = (clock: string) => Date.parse(`2026-10-15T${clock}Z`);
  await writeFile(join(dir, `${driver}-run-38708750431.json`), JSON.stringify({ session: driver, on: { kind: "run", run: 38708750431 }, note: "promote 10 try 3", since: at("10:16:18") }));
  await writeFile(join(dir, TICKED), new Date(at("10:31:05")).toISOString());
  let release!: () => void;
  const reading = new Promise<void>(done => { release = done; });
  let read!: () => void;
  const started = new Promise<void>(done => { read = done; });
  const stop = startWakes({ dir, now: () => at("10:32:45"), runState: async () => { read(); await reading; return { done: false }; }, deliver: async () => "sent", log: () => {} }, 5);
  await started;
  const owed = await pendingWakes(dir, at("10:33:18"));
  stop();
  release();
  assert.deepEqual(owed.map(wake => wake.session), [driver], "the tick that started at 10:32:45Z is still reading runs and owes the wake");
  const thread: JobFact = { key: `thread:${driver}`, name: "ci release driver", state: "ended", activityAt: at("10:16:18") };
  assert.deepEqual(withWakes([thread], owed, () => undefined).map(fact => [fact.state, fact.wake]), [["working", "a board.wake on run 38708750431"]]);
});
