// Guards the 10-15 13:48Z incident: a token hook failure and a worker stop ended about 20 jobs, and nothing restarted them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { OWNER_UI } from "../src/checkin-settings.ts";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { InterruptedRuns, resumeChatJobs, runScript } from "../src/chat-resume.ts";
import { CHECK_IN_TICK_MS, Chats, SUPERVISOR_RESUME_MS } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { InterruptedReport, InterruptedRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * Crawler VP 10-15: alert follow through stopped mid-tool at 13:29Z, and at 13:48Z a token hook failure and a worker stop ended about 20 more
 * jobs, some of them two levels under the chat (tunnel-budget, curl-multi-gate). The server only woke a direct job on a token or connection
 * error, and the resume script, run by hand, counted no job whose chat had taken a message since. Nothing restarted them, so every step they
 * owned sat on its wait and stalled_steps read 1 for two check-ins in a row. The server now sends each interrupted job of its chats
 * "continue" itself.
 */
const at = "2026-10-15T13:48:27Z";
const job = (id: string, reason: InterruptedRun["reason"], head: string): InterruptedRun =>
  ({ id: id.slice(-12), name: id, reason, session_id: id, error: "x", errored_at: at, head: head.slice(-12), head_session_id: head });

test("resumeJobs messages each interrupted job itself, reopens a dead worker's head, and leaves hung runs alone", async () => {
  const planned: InterruptedReport = { paused: [job("j-alert", "cut_off", "chat1"), job("j-curl", "error", "chat1"), job("j-hung", "hung", "chat1"),
    job("j-dead", "worker_failed", "chat2"), job("chat1", "cut_off", "chat1"), job("j-other", "error", "owner-terminal")], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  const reopened: string[] = [];
  const owned = new Set(["chat1", "chat2"]);
  await runs.resumeJobs(run => run.session_id !== "chat1" && owned.has(run.head_session_id ?? ""), async id => { reopened.push(id); });
  assert.deepEqual(reopened, ["chat2"]);
  assert.deepEqual(calls, [["--dry-run", "--direct"], ["--direct", "--only", "j-alert,j-curl,j-dead", "--this-box"]]);
});

test("resumeJobs aborts a hung job asleep in its provider retry and continues it, and leaves other hung runs alone", async () => {
  // 10-18: after the account outage, ssh tailnet only (01a14e17) showed working 146 min after its 08:20:32Z 429, with the accounts back.
  const asleep = { ...job("j-429", "hung", "chat1"), retry_error: "429 This request would exceed your account's rate limit. Please try again later." };
  const planned: InterruptedReport = { paused: [asleep, job("j-tool", "hung", "chat1"), job("j-cut", "cut_off", "chat1")], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  const aborted: string[] = [];
  await runs.resumeJobs(() => true, async () => {}, new Set(), undefined, new Set(), async id => { aborted.push(id); });
  assert.deepEqual(aborted, ["j-429"]);
  assert.deepEqual(calls.slice(1), [["--dry-run", "--direct", "--only", "j-429", "--this-box"], ["--direct", "--only", "j-429,j-cut", "--this-box", "--unstuck", "j-429"]]);
  calls.length = 0;
  await runs.resumeJobs(() => true, async () => {});
  assert.deepEqual(calls[1], ["--direct", "--only", "j-cut", "--this-box"]);
});

test("a job asleep in its retry whose pool answer is unknown is reported and not aborted", async () => {
  const blocked = { ...job("j-429", "hung", "chat1"), retry_blocked: "unknown: pi-pool who gave no anthropic answer for the tree" };
  const runs = new InterruptedRuns(async () => ({ paused: [blocked], heads: [], checked_at: "now" }));
  const aborted: string[] = [];
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { assert.equal(await runs.resumeJobs(() => true, async () => {}, new Set(), undefined, new Set(), async id => { aborted.push(id); }), null); }
  finally { process.stderr.write = write; }
  assert.deepEqual(aborted, []);
  assert.ok(lines.some(line => line.includes("not aborted: unknown: pi-pool who")), lines.join(""));
});

test("a job deleted between discovery and abort is neither aborted nor continued", async () => {
  // chat-057a's review of ec7f11b11 (10-18): the abort ran on the discovery pass alone, so a job its chat deleted in between, or one pi-pool
  // put in its 0 to 120 min backoff, would be aborted although its continue was then refused. The recheck right before the abort reads the
  // stop records and the pool again; here the delete hides the run, and here an abort that did not settle leaves the run alone.
  const asleep = { ...job("j-429", "hung", "chat1"), retry_error: "429 rate limit" };
  const planned: InterruptedReport = { paused: [asleep], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return args.includes("--only") ? { paused: [], heads: [], checked_at: "now" } : planned; });
  const aborted: string[] = [];
  assert.equal(await runs.resumeJobs(() => true, async () => {}, new Set(), undefined, new Set(), async id => { aborted.push(id); }), null);
  assert.deepEqual(aborted, []);
  assert.deepEqual(calls, [["--dry-run", "--direct"], ["--dry-run", "--direct", "--only", "j-429", "--this-box"]]);
  calls.length = 0;
  const still = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  assert.equal(await still.resumeJobs(() => true, async () => {}, new Set(), undefined, new Set(), async () => { throw new Error("the turn still runs 30 s after its abort"); }), null);
  assert.equal(calls.filter(args => !args.includes("--dry-run")).length, 0, "no continue goes to a run whose abort did not settle");
});

test("the send pass reads the other boxes only when a job is on one of them", async () => {
  // 10-18: the 06:56Z send pass named 11 jobs on us-metal02, spent the Mac's 30 to 60 s lists on top, and died on the 90 s limit.
  const onMac = { ...job("j-mac", "cut_off", "chat1"), host: "mac" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [job("j-box", "cut_off", "chat1"), onMac], heads: [], checked_at: "now" }; });
  await runs.resumeJobs(() => true, async () => {});
  assert.deepEqual(calls[1], ["--direct", "--only", "j-box,j-mac"]);
});

test("resumeJobs runs nothing more when no job of a chat is interrupted", async () => {
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [job("j-other", "error", "elsewhere")], heads: [], checked_at: "now" }; });
  assert.equal(await runs.resumeJobs(run => run.head_session_id === "chat1", async () => {}), null);
  assert.deepEqual(calls, [["--dry-run", "--direct"]]);
});

test("the server resumes the interrupted jobs of its active chats and their root jobs once per job sweep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interrupted-jobs-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await index.add("c2");
  const start = Date.parse("2026-10-15T13:50:00Z");
  let now = start;
  const root: ChatAgent = { key: "thread:r1", sessionId: "r1", name: "ops land follow through", job: "session:r1", sender: "ops land follow through", link: "root",
    state: "idle", steps: [], lastActivityAt: at };
  const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [root] }), row("c2", at, { chat: true, agents: [] })];
  const asked: InterruptedRun[][] = [];
  const paused = [job("j-alert", "cut_off", "c1"), job("j-nested", "error", "c1"), job("r1", "worker_stopped", "r1"), job("c1", "cut_off", "c1"),
    job("j-paused-chat", "cut_off", "c2"), job("j-terminal", "error", "t1")];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), interrupted: async isJob => { asked.push(paused.filter(isJob)); return null; } }, () => {});
  await chats.adopt();
  await chats.setCheckIn("c2", { pause: "forever" }, OWNER_UI);
  const step = async (ms: number) => { now += ms; await chats.tick(); await chats.settled(); };
  await step(0);
  assert.deepEqual(asked.map(found => found.map(run => run.session_id)), [["j-alert", "j-nested", "r1"]],
    "jobs of c1 at any depth and its root job; never a chat, a job of a chat the owner paused, or a run outside the chats");
  await step(JOB_CLEANUP_EVERY_MS - 1);
  assert.equal(asked.length, 1, "once per job sweep");
  await step(1);
  assert.equal(asked.length, 2);
  chats.close();
});

test("a new daemon supervisor brings the pass over interrupted jobs forward", async () => {
  // census writer speed, 10-18: Prime's update cut it at 06:46:02Z, and the next pass of a 10 min sweep came too late; it waited 29 min.
  const dir = await mkdtemp(join(tmpdir(), "interrupted-jobs-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-10-18T06:40:00Z");
  const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [] })];
  let passes = 0;
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), interrupted: async () => { passes++; return null; } }, () => {});
  await chats.adopt();
  const step = async (ms: number) => { now += ms; await chats.tick(); await chats.settled(); };
  await step(0);
  assert.equal(passes, 1);
  await step(CHECK_IN_TICK_MS);
  chats.interruptedSoon();
  await step(SUPERVISOR_RESUME_MS - 1);
  assert.equal(passes, 1, "the new workers get time to start");
  await step(1);
  assert.equal(passes, 2, "the pass runs SUPERVISOR_RESUME_MS after the new supervisor, not at the next 10 min sweep");
  chats.close();
});

test("a job pi-pool holds gets its pass at the first tick at or after its pool time, and one with no pool time is asked about at each tick", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interrupted-jobs-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-10-19T05:55:37Z");
  const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [] })];
  const held = (poolAt: string | null) => ({ id: "bebde466d3af", name: "twitch index gaps", session_id: "01a151d3", head: "bfae1773e0a0", head_session_id: "c1",
    tree: "c1", provider: "anthropic", errored_at: "2026-10-19T02:31:41.345Z", held_by: "claude7@slack.green is limited", pool_at: poolAt });
  const reports: InterruptedReport[] = [{ paused: [], heads: [], checked_at: "", held: [held("2026-10-19T05:59:59+00:00")] },
    { paused: [], heads: [], checked_at: "", held: [held(null)] }];
  const passes: string[] = [], asked: string[] = [];
  let admits = (): boolean => now >= Date.parse("2026-10-19T05:59:59Z");
  const lines: string[] = [];
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), interrupted: async () => { passes.push(new Date(now).toISOString()); return reports.shift() ?? null; },
      poolAdmits: async tree => { asked.push(`${tree} ${new Date(now).toISOString()}`); return admits(); } }, line => lines.push(line));
  await chats.adopt();
  const step = async (ms: number) => { now += ms; await chats.tick(); await chats.settled(); };
  await step(0);
  for (let tick = 0; tick < 8; tick++) await step(CHECK_IN_TICK_MS);
  assert.deepEqual([passes, asked], [["2026-10-19T05:55:37.000Z"], []], "no pool read and no pass before the pool time");
  await step(CHECK_IN_TICK_MS);
  assert.deepEqual([passes, asked], [["2026-10-19T05:55:37.000Z", "2026-10-19T06:00:07.000Z"], ["c1 2026-10-19T06:00:07.000Z"]],
    "the first tick at or after 05:59:59Z asks the pool and runs the pass, not the 06:05:37Z sweep");
  admits = () => false;
  await step(CHECK_IN_TICK_MS);
  await step(CHECK_IN_TICK_MS);
  admits = () => true;
  await step(CHECK_IN_TICK_MS);
  assert.deepEqual([passes.length, asked.slice(1)], [3, ["c1 2026-10-19T06:00:37.000Z", "c1 2026-10-19T06:01:07.000Z", "c1 2026-10-19T06:01:37.000Z"]],
    "a held run with no pool time is asked about at each tick");
  assert.ok(lines.includes("job twitch index gaps: held by pi-pool until 2026-10-19T05:59:59+00:00: claude7@slack.green is limited (cut at 2026-10-19T02:31:41.345Z, tree c1, 01a151d3)"), lines.join("\n"));
  chats.close();
});

test("a resume run a signal ends names the signal, time and flags instead of the bare command", async () => {
  // 06:52Z and 06:57Z on 10-18 the service logged "Command failed: python3 -B .../resume_paused.py --json ... --owners <134 ids>" and nothing more.
  const dir = await mkdtemp(join(tmpdir(), "resume-script-"));
  const killed = join(dir, "killed.py");
  await writeFile(killed, "import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n");
  await assert.rejects(runScript(["--dry-run", "--direct", "--owners", "a,b,c"], killed),
    /^Error: resume_paused\.py --dry-run --direct --owners <3 ids> ended by SIGTERM after \d+\.\d s$/);
  const failing = join(dir, "failing.py");
  await writeFile(failing, "import sys\nsys.exit('prime-agent list --json failed (1): Timed out after 3000ms waiting for the daemon handshake')\n");
  await assert.rejects(runScript(["--direct"], failing),
    /^Error: resume_paused\.py --direct exited 1 after \d+\.\d s: prime-agent list --json failed \(1\): Timed out after 3000ms/);
});

test("a pass past its warning budget logs the overrun, finishes both boxes and sends each continue once", async () => {
  // 06:57Z on 10-18: the 90 s kill ended the pass while it read the Mac, after this box's sends, so the Mac's jobs went unchecked.
  const dir = await mkdtemp(join(tmpdir(), "resume-overrun-"));
  const home = join(dir, "home"), bin = join(dir, "bin"), sends = join(dir, "sends.txt");
  const python = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const cut = [{ type: "message", timestamp: ago(12), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] } },
    { type: "message", timestamp: ago(11), message: { role: "toolResult", content: "x" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const local = "01a14da6-e39d-72c5-82d8-5882bce4a3a2", remote = "01a14d56-4447-714c-beb1-7aa8a2c9c09b";
  const remoteFile = `/remote/.prime/agent/sessions/${remote}.jsonl`;
  await mkdir(join(home, ".prime", "agent", "sessions"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, ".prime", "agent", "sessions", `${local}.jsonl`), cut);
  const rowOf = (id: string, sessionFile: string) => ({ id, sessionId: id, lifecycle: "live", activity: "idle", sessionFile, sessionName: id, runtimeKind: "top-level", lastActivityAt: ago(11) });
  const fake = (rows: unknown[], host: string, verb: number) => `#!${python}\nimport json, sys, time\ntime.sleep(0.4)\nargs = sys.argv[${verb}:]\n` +
    `if args[0] == "list": print(json.dumps({"sessions": json.loads(${JSON.stringify(JSON.stringify(rows))})}))\n` +
    `else: open(${JSON.stringify(sends)}, "a").write("${host} " + args[-2] + "\\n"); print(json.dumps({"deliveryStatus": "delivered"}))\n`;
  await writeFile(join(bin, "prime-agent"), fake([rowOf(local, join(home, ".prime", "agent", "sessions", `${local}.jsonl`))], "local", 1), { mode: 0o755 });
  await writeFile(join(bin, "node"), fake([rowOf(remote, remoteFile)], "slowbox", 4), { mode: 0o755 });
  const relay = createServer((request, response) => {
    const path = new URL(request.url ?? "", "http://x").searchParams.get("path");
    if (request.headers.authorization !== "Bearer t0ken" || path !== remoteFile) { response.writeHead(403).end("{}"); return; }
    const start = Number(/bytes=(\d+)-/.exec(request.headers.range ?? "")?.[1] ?? 0);
    if (start >= cut.length && start) { response.writeHead(416, { "X-File-Size": String(cut.length) }).end(); return; }
    response.writeHead(start ? 206 : 200, { "X-File-Size": String(cut.length) }).end(cut.slice(start));
  });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  await writeFile(join(dir, "token"), "t0ken");
  await writeFile(join(dir, "hosts.json"), JSON.stringify({ hosts: [{ name: "slowbox", hostname: "slowbox-host", address: "127.0.0.1", relayPort: (relay.address() as AddressInfo).port, token: "file:token" }] }));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, PYTHON: python, PRIME_AGENT_BIN: join(bin, "prime-agent"), SIEUN_PI_HOSTS: join(dir, "hosts.json") });
  const warnings: string[] = [];
  try {
    const report = await runScript(["--direct"], undefined, 300, line => warnings.push(line));
    assert.equal(report.incomplete, undefined);
    assert.deepEqual(report.children?.map(child => [(child as { host?: string }).host ?? "local", child.result]),
      [["local", { deliveryStatus: "delivered", deliveryMode: null }], ["slowbox", { deliveryStatus: "delivered", deliveryMode: null }]]);
    assert.equal(warnings[0], "resume: resume_paused.py --direct still running after 0.3 s");
    assert.match(warnings[1] ?? "", /^resume: resume_paused\.py --direct took \d+\.\d s$/);
    assert.deepEqual((await runScript(["--direct"], undefined, 60_000)).paused, []);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    relay.close();
  }
  assert.deepEqual((await readFile(sends, "utf8")).trim().split("\n").sort(), [`local ${local.slice(-12)}`, `slowbox ${remote.slice(-12)}`]);
});

test("a stopped resume run answers the boxes it finished and the stop its script named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-script-"));
  const partial = join(dir, "partial.py");
  const report: InterruptedReport = { paused: [job("j-alert", "cut_off", "chat1")], heads: [], children: [{ id: "j-alert", name: "j-alert", head: "chat1", result: { deliveryStatus: "delivered" } }],
    checked_at: "now", incomplete: [{ host: "mac", error: "stopped by SIGTERM after 88.0 s while it checked mac, last step: node hosts-cli.mjs daemon mac list" }] };
  await writeFile(partial, `import sys\nprint(${JSON.stringify(JSON.stringify(report))})\nsys.exit(143)\n`);
  assert.deepEqual(await runScript(["--direct"], partial), report);
  const silent = join(dir, "silent.py");
  await writeFile(silent, `import sys\nprint(${JSON.stringify(JSON.stringify({ ...report, incomplete: undefined }))})\nsys.exit(1)\n`);
  const answered = await runScript(["--direct"], silent);
  assert.deepEqual(answered.children, report.children);
  assert.match(answered.incomplete?.[0]?.error ?? "", /^resume_paused\.py --direct exited 1 after \d+\.\d s$/);
});

test("the job sweep logs each box a resume pass did not finish, also when it found no job", async () => {
  const incomplete = [{ host: "mac", error: "stopped by SIGTERM after 88.0 s while it checked mac" }];
  const runs = new InterruptedRuns(async () => ({ paused: [job("j-other", "error", "elsewhere")], heads: [], checked_at: "now", incomplete }));
  const lines: string[] = [];
  await resumeChatJobs([row("chat1", at)], new Set(["chat1"]), (isJob, owners) => runs.resumeJobs(isJob, async () => {}, owners), line => lines.push(line));
  assert.deepEqual(lines, ["chats: interrupted jobs: not finished on mac: stopped by SIGTERM after 88.0 s while it checked mac"]);
});

test("a report over 4 MiB comes back whole", async () => {
  // runScript used maxBuffer 4 MiB, and a longer report killed the run.
  const dir = await mkdtemp(join(tmpdir(), "resume-script-"));
  const big = join(dir, "big.py");
  await writeFile(big, "import json\nruns = [{'id': f'{i:012d}', 'name': 'x' * 400, 'reason': 'cut_off', 'error': 'e', 'errored_at': None, 'head': 'h'} for i in range(12000)]\n" +
    "print(json.dumps({'paused': runs, 'heads': [], 'children': [], 'checked_at': 'now'}))\n");
  const report = await runScript(["--dry-run"], big);
  assert.equal(report.paused.length, 12000);
  assert.equal(report.paused.at(-1)?.id, "000000011999");
  assert.ok(JSON.stringify(report).length > 4 * 1024 * 1024);
});

test("a malformed report is rejected with the field it got wrong", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-script-"));
  const printing = async (name: string, report: unknown, code = 0) => {
    const file = join(dir, `${name}.py`);
    await writeFile(file, `import sys\nprint(${JSON.stringify(JSON.stringify(report))})\nsys.exit(${code})\n`);
    return runScript(["--direct"], file);
  };
  const good = { paused: [job("j-alert", "daemon_restart", "chat1")], heads: [], children: [{ id: "j-alert", name: "j-alert", head: "chat1", result: { deliveryStatus: "delivered" } }], checked_at: "now" };
  assert.deepEqual(await printing("good", good), good);
  const cases: [string, unknown, RegExp][] = [
    ["list", [], /^Error: resume_paused\.py --direct printed JSON that is not an object after \d+\.\d s$/],
    ["nochecked", { ...good, checked_at: 1 }, /printed a report whose checked_at is missing or has the wrong type after/],
    ["reason", { ...good, paused: [{ ...good.paused[0], reason: "gone" }] }, /printed a report whose paused\[0\]\.reason is missing/],
    ["heads", { ...good, heads: undefined }, /printed a report whose heads is missing/],
    ["child", { ...good, children: [{ id: "j-alert", name: "j-alert", head: "chat1", result: { error: 3 } }] }, /printed a report whose children\[0\]\.result is missing/],
    ["incomplete", { ...good, incomplete: [{ host: 3, error: "x" }] }, /printed a report whose incomplete\[0\]\.host is missing/],
  ];
  for (const [name, report, cause] of cases) await assert.rejects(printing(name, report), cause);
  const text = join(dir, "text.py");
  await writeFile(text, "print('Traceback (most recent call last): token=t0ken')\n");
  await assert.rejects(runScript(["--direct"], text), (error: Error) => /^resume_paused\.py --direct printed 47 bytes that are not JSON after \d+\.\d s$/.test(error.message) && !error.message.includes("t0ken"));
  await assert.rejects(printing("failed", { ...good, paused: "x" }, 1), /^Error: resume_paused\.py --direct exited 1 after \d+\.\d s and printed a report whose paused is missing/);
});

test("the job sweep logs an unresolved stop of a chat's job, does not send it, and leaves other trees' stops out", async () => {
  const stop = (id: string, head: string) => ({ id: id.slice(-12), name: id, session_id: id, head: head.slice(-12), head_session_id: head,
    archived_at: "2026-10-18T06:52:53.805Z", error: "An archive with no recorded cause stopped its turn, so it is not resumed." });
  const calls: string[][] = [];
  const deleted = (id: string, head: string) => ({ id: id.slice(-12), name: id, session_id: id, head: head.slice(-12), head_session_id: head,
    stopped_at: "2026-10-18T10:40:44.800Z", stopped_by: "its parent deleted it (rlm ledger delete, reason user, at 2026-10-18T10:40:44.763Z)" });
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [], heads: [], checked_at: "now",
    unresolved: [stop("j-mine", "chat1"), stop("j-other", "elsewhere")], stopped: [deleted("j-deleted", "chat1"), deleted("j-far", "elsewhere")] }; });
  const lines: string[] = [];
  await resumeChatJobs([row("chat1", at)], new Set(["chat1"]), (isJob, owners) => runs.resumeJobs(isJob, async () => {}, owners), line => lines.push(line));
  assert.deepEqual(calls, [["--dry-run", "--direct"]]);
  assert.deepEqual(lines, [
    "job j-mine: not resumed: An archive with no recorded cause stopped its turn, so it is not resumed. (archive at 2026-10-18T06:52:53.805Z, j-mine)",
    "job j-deleted: not resumed, stopped on purpose: its parent deleted it (rlm ledger delete, reason user, at 2026-10-18T10:40:44.763Z) (j-deleted)"]);
  const dir = await mkdtemp(join(tmpdir(), "resume-script-"));
  const bad = join(dir, "bad.py");
  await writeFile(bad, `print(${JSON.stringify(JSON.stringify({ paused: [], heads: [], checked_at: "now", unresolved: [{ ...stop("j-mine", "chat1"), session_id: 3 }] }))})\n`);
  await assert.rejects(runScript(["--dry-run"], bad), /printed a report whose unresolved\[0\]\.session_id is missing/);
  await writeFile(bad, `print(${JSON.stringify(JSON.stringify({ paused: [], heads: [], checked_at: "now", stopped: [{ ...deleted("j-deleted", "chat1"), stopped_by: 3 }] }))})\n`);
  await assert.rejects(runScript(["--dry-run"], bad), /printed a report whose stopped\[0\]\.stopped_by is missing/);
});

test("the sweep continues a top-level root that is no chat and no chat's job, asleep in its retry after pi-pool admits its tree", async () => {
  // us-metal02 10-19 01:23:36Z: the release owner (01a10810) and the metal box owner (01a11d24), moved from the Mac at 21:14Z, slept in Prime's
  // usage wait for their 00:26Z and 00:49Z 429 draws (retries at 02:21Z and 02:48Z) while pi-pool already gave their trees claude7.
  const releaseOwner = "01a10810-34b5-710f-88fe-3d369f89a8c9", metal = "01a11d24-ac9b-757d-ac51-9b2b7598782f", crawler = "01a115e2-9544-7204-b8db-8ce4d5319048";
  const retry = "429 This request would exceed your account's rate limit. Please try again later.";
  const planned: InterruptedReport = { paused: [{ ...job(releaseOwner, "hung", releaseOwner), retry_error: retry }, { ...job(metal, "hung", metal), retry_error: retry },
    job(crawler, "error", crawler), job("01a14fe2-sub", "error", "01a0cc5e-elsewhere")], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  const aborted: string[] = [];
  await resumeChatJobs([row(crawler, at)], new Set([crawler]), (isJob, owners) => runs.resumeJobs(isJob, async () => {}, owners, undefined, new Set(),
    async id => { aborted.push(id); }), () => {});
  assert.deepEqual(aborted, [releaseOwner, metal]);
  assert.deepEqual(calls.at(-1), ["--direct", "--only", `${releaseOwner},${metal}`, "--this-box", "--unstuck", `${releaseOwner},${metal}`]);
});

// The VP of CI's 10-19 triage jobs (01a153d7, 01a153d9, 01a153da, 01a15421, 01a1543c): the dry run listed each as paused on its slot-wait error,
// the send pass's token hook held it, and when the dry run held any other job the pass kept only that list, so PoolHeldJobs never ran a pass at its slot.
test("a job the send pass holds on its pool wait joins the held list, so its pass runs at its slot", async () => {
  const cut = job("01a153d7-a9ce-7558-0000-000000000000", "error", "chat1");
  const hold = { id: cut.id, name: "alert triage VP of CI", session_id: cut.session_id!, head: cut.head, head_session_id: "chat1", tree: "chat1", provider: "anthropic",
    errored_at: at, held_by: "the token hook gave no anthropic token (exit 1)", pool_at: "2026-10-19T11:30:00+00:00" };
  const other = { ...hold, id: "other", name: "census canary run", session_id: "01a15033-beca-757a-b361-94ef06732721" };
  const runs = new InterruptedRuns(async args => args.includes("--dry-run") ? { paused: [cut], heads: [], checked_at: "now", held: [other] }
    : { paused: [], heads: [], children: [], checked_at: "now", held: [hold] });
  const report = await runs.resumeJobs(() => true, async () => {});
  assert.deepEqual(report?.held?.map(run => run.session_id).sort(), [other.session_id, cut.session_id].sort());
});

test("every resume run looks back with no limit, so a cut older than a day still gets its continue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-look-back-"));
  try {
    const echo = join(dir, "echo.py");
    await writeFile(echo, `import json, sys\nprint(json.dumps({"paused": [], "heads": [], "checked_at": " ".join(sys.argv[1:])}))\n`);
    assert.equal((await runScript(["--dry-run", "--direct"], echo)).checked_at, "--json --since-minutes 0 --dry-run --direct");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
