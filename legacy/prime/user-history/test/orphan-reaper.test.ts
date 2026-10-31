// Guards p661 (10-31): a Mac job's Chrome driver ran 2 days on us-metal02 after its job ended, so d2 stops a process only when its own env or its
// group names a session that ended over 1 h ago, and lists a group with no owner without signalling it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ENDED_FOR_MS, KILL_AFTER_MS, type Group, type ProcRow, type Verdict, decide, groupProcesses, hostMatcher, ownerOf, piThreadRow, readVerdicts, stopGroups, unitFileNames, unitOf, verdict } from "../src/orphan-reaper.ts";

const JOB = "01a183f7-0a0b-725c-984d-d59f150e6420";
const LIVE = "01a190a3-1b2e-74ad-88ca-f217e0f956a8";
const USER = "/user.slice/user-1001.slice/user@1001.service/app.slice";
const row = (pid: number, ppid: number, command: string, extra: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid, started: 1000 + pid, bytes: 1 << 20, command,
  sessionDir: null, harnessSession: null, lcSession: null, sshFrom: null, prime: false, shared: false, cgroup: `${USER}/prime-agent-daemon.service`, cwd: null, ...extra });
const base = [row(4578, 1, "/usr/lib/systemd/systemd --user", { cgroup: `/user.slice/user-1001.slice/user@1001.service/init.scope` })];
const hosts = hostMatcher([{ name: "us-metal02", hostname: "us-metal02", address: "100.83.139.73" }, { name: "mac", hostname: "Sieuns-MacBook-Pro", address: "100.66.173.18" }]);
const group = (rows: ProcRow[], files: string[] = []) => groupProcesses([...base, ...rows], new Set(files), hosts, "us-metal02");

test("a Chrome with a wiped environ takes the owner of the detached driver it runs under, and the driver's ssh tag names the Mac job", () => {
  const groups = group([
    row(10, 4578, "node driver.mjs --port 47811", { lcSession: `${JOB}@Sieuns-MacBook-Pro`, sshFrom: "100.66.173.18" }),
    row(11, 10, "/opt/google/chrome/chrome --remote-debugging-pipe", { cgroup: `${USER}/app-com.google.Chrome-11.scope` }),
    row(12, 11, "/opt/google/chrome/chrome --type=renderer", { cgroup: `${USER}/app-com.google.Chrome-11.scope` }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.pids.sort(), [10, 11, 12]);
  assert.deepEqual(groups[0]!.owners, [{ session: JOB, host: "mac" }]);
});

test("nothing under a live kernel, pm2, a service with a unit file, a container or an ssh mux master forms a group", () => {
  const groups = group([
    row(20, 4578, "/home/sieun/.local/share/prime-agent/releases/x/prime-agent --mode daemon", { prime: true }),
    row(21, 20, "python -m rlm.repl", { prime: true }),
    row(22, 21, "node server.mjs", { sessionDir: "/h/.prime/agent/session-artifacts/r/sub-1" }),
    row(30, 4578, "PM2 v6.0.0: God Daemon (/home/sieun/.pm2)", { shared: true }),
    row(31, 30, "node vite dev", { sessionDir: "/h/.prime/agent/session-artifacts/r/sub-1" }),
    row(40, 4578, "node chat-service.mjs", { cgroup: `${USER}/sieun-pi-chat.service` }),
    row(50, 900, "next-server", { cgroup: "/system.slice/docker-abc.scope" }),
    row(60, 4578, "ssh: /home/sieun/.ssh/cm/x [mux]"),
  ], ["sieun-pi-chat.service"]);
  assert.deepEqual(groups, []);
});

test("a transient unit is one group whose owner any member names, and a unit file keeps a service out", () => {
  const unit = `${USER}/aw-drv.service`;
  const groups = group([
    row(70, 4578, "/usr/bin/sh -c npx tsx driver.mts", { cgroup: unit, lcSession: `${JOB}@Sieuns-MacBook-Pro` }),
    row(71, 70, "chrome", { cgroup: `${USER}/app-org.chromium.Chromium-71.scope` }),
    row(72, 4578, "chrome-headless-shell", { cgroup: unit }),
  ]);
  assert.equal(groups.length, 2, "the reparented Chrome of the unit groups with the unit, its child Chrome with its tree");
  const byUnit = groups.find(entry => entry.unit === "aw-drv.service")!;
  assert.deepEqual(byUnit.pids.sort(), [70, 72]);
  assert.deepEqual(byUnit.owners, [{ session: JOB, host: "mac" }]);
  assert.equal(unitOf(`${USER}/aw-drv.service`), "aw-drv.service");
  assert.deepEqual([...unitFileNames("llm-wiki.service enabled enabled\naw-drv.service transient -\n")], ["llm-wiki.service"]);
});

test("RLM_SESSION_DIR on this box wins over the ssh tag, and a tag with no host takes the box its ssh came from", () => {
  const dir = "/home/sieun/.prime/agent/session-artifacts/01a11af8-962e-773d-a19a-ee4104011987";
  assert.deepEqual(ownerOf(row(1, 0, "x", { sessionDir: dir, lcSession: `${JOB}@Sieuns-MacBook-Pro` }), hosts, "us-metal02"),
    { session: "01a11af8-962e-773d-a19a-ee4104011987", host: "us-metal02", dir });
  assert.deepEqual(ownerOf(row(1, 0, "x", { lcSession: JOB, sshFrom: "100.66.173.18" }), hosts, "us-metal02"), { session: JOB, host: "mac" });
  assert.equal(ownerOf(row(1, 0, "x", { harnessSession: "95399ef6-9e52-4b9e-8d71-737332eee4dd-6769" }), hosts, "us-metal02"), null);
});

test("a session is live while its roster says running or idle, a wake waits, it is an unarchived chat or a job above it is live", () => {
  assert.equal(verdict({ rosterStatus: "idle", topLevel: false, endedAt: 1 }).state, "live");
  assert.equal(verdict({ rosterStatus: "inactive", live: "its board.wake is pending", topLevel: false, endedAt: 1 }).state, "live");
  assert.equal(verdict({ topLevel: true, endedAt: 1 }).state, "live");
  assert.equal(verdict({ topLevel: true, archived: true, endedAt: 1 }).state, "ended");
  assert.equal(verdict({ topLevel: false, endedAt: 1, parentLive: "its parent job is live" }).state, "live");
  assert.deepEqual(verdict({ rosterStatus: "inactive", topLevel: false, endedAt: 5 }), { state: "ended", at: 5, why: "it is not resident and nothing waits to wake it" });
  assert.equal(verdict({ topLevel: false, endedAt: null }).state, "unknown");
});

test("a group stops only when every owner ended over 1 h ago; a live owner or a recent end holds it, and no owner lists it", () => {
  const now = 10 * ENDED_FOR_MS;
  const mk = (key: string, owners: Group["owners"]): Group => ({ key, root: 1, pids: [1], bytes: 0, started: 0, command: key, owners });
  const verdicts = new Map<string, Verdict>([[`mac/${JOB}`, { state: "ended", at: now - 2 * ENDED_FOR_MS, why: "" }],
    [`us-metal02/${LIVE}`, { state: "live", why: "its roster status is running" }], ["mac/recent", { state: "ended", at: now - 60_000, why: "" }]]);
  const decision = decide([mk("old", [{ session: JOB, host: "mac" }]), mk("mixed", [{ session: JOB, host: "mac" }, { session: LIVE, host: "us-metal02" }]),
    mk("recent", [{ session: "recent", host: "mac" }]), mk("none", [])], verdicts, now);
  assert.deepEqual(decision.stop.map(entry => entry.key), ["old"]);
  assert.deepEqual(decision.held.map(entry => entry.group.key), ["mixed", "recent"]);
  assert.deepEqual(decision.unknown.map(entry => entry.key), ["none"]);
});

test("the stop skips a reused pid, sends SIGTERM, and sends SIGKILL after 10 s only to the processes that still run", async () => {
  const rows = [row(1, 0, "a"), row(2, 0, "b"), row(3, 0, "c")];
  const sent: string[] = [];
  let waited = 0;
  let reads = 0;
  const result = await stopGroups([{ key: "g", root: 1, pids: [1, 2, 3], bytes: 0, started: 0, command: "", owners: [] }], rows, {
    starts: async () => reads++ === 0 ? new Map([[1, 1001], [2, 1002], [3, 9999]]) : new Map([[2, 1002]]),
    kill: (pid, signal) => { sent.push(`${signal} ${pid}`); },
    wait: async ms => { waited = ms; },
  });
  assert.deepEqual(sent, ["SIGTERM 1", "SIGTERM 2", "SIGKILL 2"]);
  assert.equal(waited, KILL_AFTER_MS);
  assert.deepEqual(result, { signalled: [1, 2], killed: [2] });
});

test("a job's dir names its transcript, a pending wake keeps it live, and a live parent job holds an ended child", async () => {
  const home = await mkdtemp(join(tmpdir(), "orphan-reaper-"));
  try {
    const root = join(home, ".prime/agent/session-artifacts/01a11af8-962e-773d-a19a-ee4104011987");
    const parentDir = join(root, "sub-parent");
    const childDir = join(parentDir, "sub-child");
    const ids = { parent: "01a18aa9-438f-70b1-81d2-b9e9a19a7ed0", child: "01a18e2c-0436-776c-a83f-cbe605a11f75", lone: "01a189fd-2015-71f2-be40-9d4317453f72" };
    const loneDir = join(root, "sub-lone");
    for (const [dir, id] of [[parentDir, ids.parent], [childDir, ids.child], [loneDir, ids.lone]] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.jsonl`), "{}\n");
      await writeFile(join(dir, "rlm-subagent.json"), JSON.stringify({ sessionFile: join(dir, `${id}.jsonl`) }));
      await utimes(join(dir, `${id}.jsonl`), 1_000, 1_000);
    }
    const dataDir = join(home, "browser-chat");
    await mkdir(join(dataDir, "wakes"), { recursive: true });
    await writeFile(join(dataDir, "wakes", `${ids.parent}-time-1.json`), JSON.stringify({ session: ids.parent, on: { kind: "time", at: 9e15 }, note: "", since: 1 }));
    const groups: Group[] = [childDir, loneDir].map(dir => ({ key: dir, root: 1, pids: [1], bytes: 0, started: 0, command: "", owners: [{ session: "", host: "us-metal02", dir }] }));
    const verdicts = await readVerdicts(groups, { here: "us-metal02", home, dataDir, now: 5_000_000, remote: async () => "", piThread: async () => null,
      list: async () => JSON.stringify({ sessions: [{ sessionId: ids.child, rosterStatus: "inactive" }] }) });
    assert.equal(verdicts.get(`us-metal02/${ids.child}`)?.state, "live");
    assert.match((verdicts.get(`us-metal02/${ids.child}`) as { why: string }).why, /parent job 01a18aa9.*board\.wake/);
    assert.deepEqual(verdicts.get(`us-metal02/${ids.lone}`), { state: "ended", at: 1_000_000, why: "it is not resident and nothing waits to wake it" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

// The pi-host half of p661: a pi thread's kernel tags its processes with LC_PRIME_SESSION=<thread id>@<host> (pi-host rlm.ts ownerTag), and a
// thread is the owner's chat, so its processes stop only once it is archived.
test("a pi-host thread from the durable index is live until it is archived, and an archived one has ended at its last update", async () => {
  const home = await mkdtemp(join(tmpdir(), "orphan-reaper-pi-"));
  try {
    const file = join(home, "index.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
    const live = "39ca7bbb-37a8-47e5-a06a-d6cea515b3cc";
    const archived = "230bbdbf-1111-4222-8333-444455556666";
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(live, 0, 1_000);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(archived, 1, 2_000);
    db.close();
    assert.deepEqual(piThreadRow(file, live), { archived: false, updatedAt: 1_000 });
    assert.equal(piThreadRow(file, "01a10000-0000-7000-8000-000000000000"), null);
    assert.equal(piThreadRow(join(home, "none.sqlite"), live), null);
    const groups: Group[] = [live, archived].map(session => ({ key: session, root: 1, pids: [1], bytes: 0, started: 0, command: "", owners: [{ session, host: "us-metal02" }] }));
    const verdicts = await readVerdicts(groups, { here: "us-metal02", home, dataDir: join(home, "chat"), now: 9_000_000, remote: async () => "",
      list: async () => JSON.stringify({ sessions: [] }), piThread: async id => piThreadRow(file, id) });
    assert.equal(verdicts.get(`us-metal02/${live}`)?.state, "live");
    assert.deepEqual(verdicts.get(`us-metal02/${archived}`), { state: "ended", at: 2_000, why: "it is archived" });
    const tagged = group([row(80, 4578, "/usr/bin/sh -c python drive.py cold", { cgroup: `${USER}/vent-lat-cold.service`, lcSession: `${live}@us-metal02` })]);
    assert.deepEqual(tagged[0]!.owners, [{ session: live, host: "us-metal02" }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
