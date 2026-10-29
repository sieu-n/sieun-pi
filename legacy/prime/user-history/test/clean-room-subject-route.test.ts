// Guards the clean-room trial wall. On 10-25 at 00:46:07 KST the AI harness developer environment VP's release notice reached "root disk
// readings", a running test chat, and voided its run. On 10-26 from 12:16 to 12:17Z three AI harness messages reached "test file counts 4"
// (01a177e7), whose clean-room-subjects.json entry was missing, after that trial's check-in job and chat had asked the AI harness chat for code
// changes. A message into a running trial's tree from outside it, or out of it to anyone but its runners, is refused; the tree's own sessions
// and the runners still reach it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { FINDINGS_CHAT, judgeCrossing, routedSend, routedSteer, routedTell, type Subject, type TrialSources, trialSources } from "../src/clean-room-subjects.ts";
import { sendCrossHost, type Root } from "../src/cross-host-message.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const TRIAL = "01a177e7-cec2-7794-9271-b2d025b779ba";
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const REALTIME = "01a0fd18-88e0-7168-8e3b-b0bc53da3610";
const OWNER = "01a16cf7-5ae1-731c-a7b9-d388a8209ff7";
const ROOT_JOB = "01a17823-0000-7000-8000-000000000001";
const CHECK_IN = "01a1781a-0000-7000-8000-000000000003";
const SUBAGENT = "01a177e9-0000-7000-8000-000000000004";
const OTHER = "01a1180e-6567-747f-bf44-452520ebdd1b";
// The trial's agents list: its own subagent and root job, and the VP, which it lists with link message because the two exchanged messages.
const AGENTS = [{ sessionId: SUBAGENT, name: "test file count", link: "subagent" }, { sessionId: VP, name: "AI harness developer environment VP", link: "message" }];
const ASK = "From the AI harness chat VP, on the check-in's stuck_steps finding: set p2's sessionId to the release owner's thread.";
const REPORT = "Counted 412 test files before and 415 after; p1 is done.";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
/** The 10-26 state: the trial listed in clean-room-chats.json, its resumed job filed in chat-jobs.json, and no subject entry unless given. */
const sources = (options: { trials?: string[]; subjects?: Record<string, Subject> } = {}): TrialSources => ({
  trials: async () => options.trials ?? [TRIAL], subjects: async () => options.subjects ?? {},
  chatOf: async session => session === ROOT_JOB ? TRIAL : undefined, participants: async id => id === TRIAL ? { agents: AGENTS, dutyJobs: [CHECK_IN] } : { agents: [], dutyJobs: [] } });

test("a message into a running trial from outside it is refused and names chat-2572, with no subject entry; its own tree and runners reach it", async () => {
  const ask = await judgeCrossing(sources(), { from: VP, to: TRIAL });
  assert.equal(ask.go, false, "the 10-26 sends: the AI harness chat is no session of the trial, though the trial lists it with link message");
  assert.match(ask.go ? "" : ask.reason, new RegExp(`${TRIAL} is the clean-room trial chat ${TRIAL}, and a message from outside the trial voids it\\. Send your findings to chat-2572 \\(${FINDINGS_CHAT}\\) instead\\.`));
  const toJob = await judgeCrossing(sources(), { from: VP, to: ROOT_JOB });
  assert.match(toJob.go ? "" : toJob.reason, /is in the tree of the clean-room trial chat/, "the trial's resumed root job is inside its wall too");
  for (const [from, why] of [[ROOT_JOB, "its resumed root job, filed in chat-jobs.json"], [CHECK_IN, "its check-in job"], [SUBAGENT, "its subagent"], [TRIAL, "itself"]] as const) {
    assert.deepEqual(await judgeCrossing(sources(), { from, to: TRIAL }), { go: true, trial: TRIAL }, `${why} reaches it`);
  }
  assert.deepEqual(await judgeCrossing(sources(), { from: "01a177ff-0000-7000-8000-000000000009", fromRoot: CHECK_IN, to: TRIAL }), { go: true, trial: TRIAL },
    "a deeper subagent of its check-in job names its root");
  assert.deepEqual(await judgeCrossing(sources(), { from: REALTIME, to: TRIAL }), { go: true, trial: TRIAL }, "the realtime layer runs trials");
  assert.equal((await judgeCrossing(sources(), { from: OWNER, to: TRIAL })).go, false, "a session no subject entry files is no runner");
  assert.equal((await judgeCrossing(sources({ subjects: { [TRIAL]: { owner: OWNER, run: "/runs/w81", name: "test file counts 4", at: 0 } } }), { from: OWNER, to: TRIAL })).go, true,
    "the trial owner a subject entry files is a runner");
  assert.deepEqual(await judgeCrossing(sources({ trials: [] }), { from: VP, to: TRIAL }), { go: true }, "an archived test chat's trial is over");
  assert.deepEqual(await judgeCrossing(sources(), { from: VP, to: OTHER }), { go: true }, "a message between two outside chats goes");
});

test("a running trial's tree sends nothing out but to its runners: a trial starts no outside work", async () => {
  for (const from of [TRIAL, CHECK_IN, ROOT_JOB]) {
    const out = await judgeCrossing(sources(), { from, to: VP });
    assert.equal(out.go, false, `${from} asked the AI harness chat for code changes on 10-26`);
    assert.equal(out.go ? "" : out.reason, `agent_message refused: a clean-room trial starts no outside work, so this session of trial chat ${TRIAL} sends nothing to ${VP}, which is outside the trial.`);
  }
  assert.equal((await judgeCrossing(sources(), { from: TRIAL, to: FINDINGS_CHAT })).go, true, "chat-2572 runs trials");
  assert.equal((await judgeCrossing(sources(), { from: TRIAL, to: REALTIME })).go, true);
  const other = "01a17779-ee90-7738-92e5-e75d13db321d";
  assert.equal((await judgeCrossing(sources({ trials: [TRIAL, other] }), { from: TRIAL, to: other })).go, false, "one trial does not reach another");
});

test("a root's sibling send across the wall raises the service's line in the sender's kernel; the trial's own root job sends as it came", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clean-room-wall-"));
  await writeFile(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [TRIAL] }));
  const receipts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const { from, fromName, to, message } = JSON.parse(body || "{}");
      const answer = new URL(req.url!, "http://127.0.0.1").pathname.endsWith("api/agent/route")
        ? routedSend(sources(), { path: "sibling send", from, fromName, to, text: message }, async session => session === ROOT_JOB ? TRIAL : session, line => receipts.push(line))
          .then(verdict => verdict.go ? { refused: false } : { refused: true, trial: verdict.trial, reason: verdict.reason })
        : Promise.reject(new Error(`unexpected ${req.url}`));
      answer.then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
        error => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  const send = async (me: string, name: string, to: { id: string; name: string }, text: string) => {
    await writeFile(join(dir, "rlm.py"), [
      "import json",
      "async def host_request(request_type, payload=None):",
      "    if request_type == 'agent_message.send':",
      "        open('local-sends.txt', 'a').write(payload['message'] + '\\n')",
      "        return {'deliveryStatus': 'delivered', 'local': True}",
      `    return {'current': {'sessionId': '${me}', 'sessionName': '${name}'},`,
      `            'agents': [{'sessionId': '${to.id}', 'sessionName': '${to.name}', 'relationship': 'sibling', 'runtimeKind': 'top-level'}]}`,
    ].join("\n") + "\n");
    await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
    await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
    const sessionDir = join(dir, "session-artifacts", me);
    await mkdir(sessionDir, { recursive: true });
    const script = messageCheckPrelude(dir) + [
      "import asyncio, json, agent_message",
      "async def main():",
      "    try:",
      `        print(json.dumps(await agent_message.host_request('agent_message.send', {'message': ${JSON.stringify(text)}, 'receiver_role': 'sibling', 'receiver_name': ${JSON.stringify(to.name)}})))`,
      "    except Exception as error:",
      "        print(json.dumps({'raised': type(error).__name__, 'error': str(error)}))",
      "asyncio.run(main())",
    ].join("\n");
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1", RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json"),
        PI_HOST_SOCKET: join(dir, "no-pi-host.sock"), PI_AGENT_BUS_BOXES: join(dir, "no-boxes.json") } });
    return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  };
  try {
    const ask = await send(VP, "AI harness developer environment VP", { id: TRIAL, name: "test file counts 4" }, ASK);
    assert.equal(ask.raised, "TrialRefused");
    assert.match(ask.error, /clean-room trial chat 01a177e7[\s\S]*Send your findings to chat-2572/);
    const out = await send(TRIAL, "test file counts 4", { id: VP, name: "AI harness developer environment VP" }, "Please make the precheck respect the explicit wait.");
    assert.equal(out.raised, "TrialRefused");
    assert.match(out.error, /a clean-room trial starts no outside work/);
    const report = await send(ROOT_JOB, "test file count resumed 21:15", { id: TRIAL, name: "test file counts 4" }, REPORT);
    assert.equal(report.local, true, "the trial's own root job sends to it as it came");
    assert.equal(await readFile(join(dir, "local-sends.txt"), "utf8"), REPORT + "\n", "only the root job's report went out");
    assert.deepEqual(receipts, [
      `refused sibling send: from session ${VP} (AI harness developer environment VP) of chat ${VP} to session ${TRIAL} as sha256:${sha(ASK)}, clean-room trial ${TRIAL}`,
      `refused sibling send: from session ${TRIAL} (test file counts 4) of chat ${TRIAL} to session ${VP} as sha256:${sha("Please make the precheck respect the explicit wait.")}, clean-room trial ${TRIAL}`,
      `delivery sibling send: from session ${ROOT_JOB} (test file count resumed 21:15) of chat ${TRIAL} to session ${TRIAL} as sha256:${sha(REPORT)}`,
    ], "one receipt per send names both sessions");
    await writeFile(join(dir, "archived-chats.json"), JSON.stringify({ ids: [TRIAL] }));
    await rm(join(dir, "local-sends.txt"));
    const after = await send(VP, "AI harness developer environment VP", { id: OTHER, name: "VP of CI" }, "p346 is live.");
    assert.equal(after.local, true, "with no running trial on the box the kernel asks the service nothing");
    assert.equal(receipts.length, 3);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a cross-host send across the wall is refused before the outbox takes it", async () => {
  const roots: Root[] = [{ sessionId: TRIAL, name: "test file counts 4", host: "us-metal02", status: "idle" }, { sessionId: REALTIME, name: "realtime layer", host: "mac", status: "idle" },
    { sessionId: "01a0aaaa-0000-7000-8000-000000000001", name: "mac chat", host: "mac", status: "idle" }];
  const sent: string[] = [];
  const directory = { roots: () => roots, reopen: async () => false, send: async (session: string) => { sent.push(session); return { deliveryStatus: "queued" }; },
    refuse: async (from: string, to: string) => { const verdict = await judgeCrossing(sources(), { from, to }); return verdict.go ? undefined : verdict.reason; } };
  await assert.rejects(sendCrossHost(directory, TRIAL, "mac chat", "please fix the precheck"), /a clean-room trial starts no outside work/);
  await sendCrossHost(directory, TRIAL, "realtime layer", "the run is done");
  await assert.rejects(sendCrossHost(directory, "01a0aaaa-0000-7000-8000-000000000001", TRIAL, "ping"), /Send your findings to chat-2572/);
  assert.deepEqual(sent, [REALTIME]);
});

test("the d9 sweep sends a running trial no push, with no subject entry; the trial's own duty notice and other chats' pushes go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clean-room-d9-"));
  const NOW = Date.parse("2026-10-26T12:20:00Z");
  const tells = [{ chat: TRIAL, text: "[d9 push 2026-10-26T12:20Z] test file counts 4: stuck steps p2" }, { chat: TRIAL, session: ROOT_JOB, text: "[d9 push 2026-10-26T12:20Z] job push p1" },
    { chat: OTHER, text: "[d9 push 2026-10-26T12:20Z] VP of CI: p346" }];
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs";
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { duties_green_pct: 45.7 }, tells: ${JSON.stringify(tells)} }));`);
  const store = new DutyStore(dir);
  const duty: Duty = { id: "d9", name: "Chat system", ownerWords: "every chat runs on its own", goal: "duties read green",
    metrics: [{ key: "duties_green_pct", label: "Duties green", op: ">=", target: 100, headline: true }],
    schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "push the chats",
    status: "active", createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, runCount: 0 };
  await store.update(VP, duties => { duties.push(duty); });
  const notices: string[] = [];
  const receipts: string[] = [];
  const logs: string[] = [];
  const tell = routedTell(sources(), { notice: async (chat, text) => { notices.push(`${chat.slice(0, 8)} ${text.slice(0, 30)}`); },
    job: async (session, text) => { notices.push(`job ${session.slice(0, 8)} ${text.slice(0, 30)}`); } }, line => receipts.push(line));
  const duties = new Duties(store, { isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, tell, log: line => logs.push(line),
    jobs: { chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }), working: async () => false, retire: async () => {},
      start: async (_chat, name) => ({ id: "job-1", name }), ended: async (last, older = []) => [...last, ...older], stop: async () => {} },
    checkIn: { view: async () => ({ everyMs: 7_200_000 }) as CheckInView, set: async () => null, run: async () => {} },
    board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }), fixLive: async () => false });
  try {
    await duties.tick();
    await duties.settled();
    assert.deepEqual(notices, [`01a1180e ${tells[2]!.text.slice(0, 30)}`], "the trial and its root job got no push from the AI harness chat's d9");
    assert.deepEqual(receipts, [
      `refused d9 push: from session ${VP} (duty d9) of chat ${VP} to session ${TRIAL} as sha256:${sha(tells[0]!.text)}, clean-room trial ${TRIAL}`,
      `refused d9 push: from session ${VP} (duty d9) of chat ${VP} to session ${ROOT_JOB} as sha256:${sha(tells[1]!.text)}, clean-room trial ${TRIAL}`,
      `delivery d9 push: from session ${VP} (duty d9) of chat ${VP} to session ${OTHER} as sha256:${sha(tells[2]!.text)}`,
    ]);
    assert.ok(logs.some(line => line.endsWith("d9: sent 1 notice from its precheck")), `only the delivered push counts as sent: ${logs.join(" | ")}`);
    assert.equal(await tell(TRIAL, "check-in: p3 waits on p2", { chat: TRIAL, duty: "checkin" }), true, "the trial's own duty notice reaches it");
    assert.equal(notices.at(-1), "01a177e7 check-in: p3 waits on p2");
  } finally { duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a job-steer across the wall is refused; the trial's own check-in job and its subagents steer its job, with a receipt per steer", async () => {
  const steered: string[] = [];
  const receipts: string[] = [];
  const job = "test file count";
  const steer = (chat: string, caller: string | undefined, callerRoot?: string) => routedSteer(sources(), { ...caller ? { caller } : {}, ...callerRoot ? { callerRoot } : {},
    ...caller ? { callerChat: callerRoot ?? caller } : {}, chat, job, message: "take p3 now" },
    { steer: async () => { steered.push(caller ?? "unnamed"); return { session: SUBAGENT, act: "steer" as const }; } }, line => receipts.push(line));
  const refused = await steer(TRIAL, VP);
  assert.match("refused" in refused ? refused.refused : "", /clean-room trial chat 01a177e7[\s\S]*chat-2572/, "the AI harness check-in's push job steering the trial's job is refused");
  assert.ok("refused" in await steer(TRIAL, undefined), "an unnamed caller is outside every trial");
  assert.match(JSON.stringify(await steer(OTHER, CHECK_IN)), /starts no outside work/, "the trial's check-in job steers no other chat's job");
  assert.deepEqual(await steer(TRIAL, CHECK_IN), { session: SUBAGENT, act: "steer" }, "the trial's own check-in job steers its job");
  assert.deepEqual(await steer(TRIAL, "01a177ff-0000-7000-8000-000000000009", CHECK_IN), { session: SUBAGENT, act: "steer" }, "so does a subagent of it, by its root");
  assert.deepEqual(steered, [CHECK_IN, "01a177ff-0000-7000-8000-000000000009"]);
  assert.equal(receipts.length, 5);
  assert.equal(receipts[0], `refused job-steer: from session ${VP} (steering job test file count of chat ${TRIAL}) of chat ${VP} to session ${TRIAL} as sha256:${sha("take p3 now")}, clean-room trial ${TRIAL}`);
  assert.equal(receipts[3], `delivery job-steer: from session ${CHECK_IN} (steering job test file count of chat ${TRIAL}) of chat ${CHECK_IN} to session ${SUBAGENT} as sha256:${sha("take p3 now")}`);
});

test("the service's trial sources read clean-room-chats.json less the archived chats, and chat-jobs.json for a job's chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clean-room-sources-"));
  try {
    const old = "01a16e1d-6592-73c6-9a96-81184bf35e5a";
    await writeFile(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [TRIAL, old] }));
    await writeFile(join(dir, "chat-jobs.json"), JSON.stringify({ jobs: { [ROOT_JOB]: { chat: "test file counts 4", at: Date.now(), chatId: TRIAL } } }));
    const read = trialSources(dir, { archived: async () => new Set([old]), rows: async () => [{ id: TRIAL, agents: AGENTS }], runs: async id => id === TRIAL ? [{ job: { id: CHECK_IN } }] : [] });
    assert.deepEqual(await read.trials(), [TRIAL]);
    assert.equal(await read.chatOf(ROOT_JOB), TRIAL);
    assert.equal((await judgeCrossing(read, { from: VP, to: ROOT_JOB })).go, false);
    assert.equal((await judgeCrossing(read, { from: CHECK_IN, to: TRIAL })).go, true);
    assert.equal((await judgeCrossing(read, { from: VP, to: old })).go, true, "an archived test chat's trial is over");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
