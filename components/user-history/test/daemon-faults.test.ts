// Guards the VP's 10-18 rule for d7: a minute where opening a chat, a status read or a send to a session fails or takes over 30 s, on either box,
// is not clean. The fixtures are service.log lines cut from that day: requests routed to Mac worker 35553 hung from about 08:03Z, and the owner's
// open of AI harness developer environment VP timed out its 30 s attach on us-metal02 at 08:16Z, while every watch line read both boxes usable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { listedSessions, readServiceFaults, readSupervisorFaults } from "../src/daemon-faults.ts";
import { timedWorkerStart } from "../src/daemon-worker-start.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const MAC_HANG = [
  "2026-10-18T08:03:33.781Z idle unload: 01a14d93: Error: Timed out after 30000ms waiting for the Prime Agent daemon response to \"get_state\". Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log.",
  "2026-10-18T08:03:33.781Z idle unload: 01a14df3: Error: Timed out after 30000ms waiting for the Prime Agent daemon response to \"get_state\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.",
  "2026-10-18T08:03:33.782Z idle unload: 01a14df8: Error: Timed out after 30000ms waiting for the Prime Agent daemon response to \"get_state\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.",
  "open 01a11ba8 saved 705 messages: catalog 497ms, first page 258ms, queue 0ms, failed: Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log., total 31754ms",
  "2026-10-18T08:03:34.008Z idle unload: 01a14dde: Error: Timed out after 30000ms waiting for the Prime Agent daemon response to \"kill\". Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log.",
  "2026-10-18T08:03:47.002Z wakes: wake 01a14d7c for run 39101049264: Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log.; tried again next tick",
  "open 01a14dea saved 133 messages: catalog 734ms, first page 17ms, queue 0ms, attach 1426ms, failed: Timed out after 30000ms waiting for the Prime Agent daemon response to \"get_queue\". Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log., total 32368ms",
];
const OWNER_ATTACH = [
  "2026-10-18T08:16:25.138Z reopen: 01a1164b answered \"Session worker is failed\"; opened it again and sent again: sent",
  "2026-10-18T08:16:32.154Z wakes: woke 01a14dd3 for its time, waited 30 min, sent 19 s after the tick began",
  "open 01a1164b saved 1000 messages: catalog 0ms, first page 9ms, queue 0ms, failed: Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\". Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log., total 30041ms",
];
const FRONTEND = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const chats = [{ id: FRONTEND, name: "frontend bro", duties: [], runs: [] }, { id: VP, name: "AI harness developer environment VP", duties: [], runs: [] }];

// The row of the Mac's catalog copy (~/.cache/sieun-pi/hosts/mac.sessions.json) for the job whose status read hung, cut to the fields read.
const MAC_COPY = JSON.stringify({ version: 1, rows: [{ id: "01a14df3-2e22-705c-b0a8-56ef01bcc980", lifecycle: "live", runtimeKind: "subagent", rlmDepth: 2,
  sessionId: "01a14df3-2e22-705c-b0a8-56ef01bcc980",
  sessionFile: "/Users/sieunpark/.prime/agent/session-artifacts/01a11ba8-9d2c-727c-8ded-38f819ca9f29/sub-1d1e32d8/sub-75c41934/01a14df3-2e22-705c-b0a8-56ef01bcc980.jsonl",
  sessionName: "checklist-research" }] });

const RUN = Date.parse("2026-10-18T08:20:10Z");
const clean = (minute: number): WatchLine => ({ at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02",
  usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 });
const watch = Array.from({ length: 30 }, (_, minute) => clean(minute));

test("the 08:03Z Mac hang and the owner's 08:16Z attach timeout make their minutes dirty, naming the chat", () => {
  const daemonFaults = readServiceFaults([...MAC_HANG, ...OWNER_ATTACH], "us-metal02");
  const listed = listedSessions([MAC_COPY], daemonFaults.flatMap(fault => fault.session ? [fault.session] : []));
  const { metrics, flagged } = measure({ now: RUN, watch, log: { holds: [] }, chats, daemonFaults, listed });
  assert.equal(metrics.daemon_fail_min_30, 2);
  assert.equal(metrics.clean_min_30, 28);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /^08:03Z daemon calls failed or ran over 30 s for frontend bro, job checklist-research on mac \(an idle check failed, get_state timed out after 30 s\), frontend bro on mac \(opening it failed, attach timed out after 30 s\), session 01a14d93 on us-metal02 .* and 3 more; /);
  assert.match(dirty, /08:16Z daemon calls failed or ran over 30 s for AI harness developer environment VP on us-metal02 \(a send failed, its session worker was failed; opening it failed, attach timed out after 30 s\)$/);
});

test("a status read on the Mac bridge and a wake's send count, and a kill that timed out does not", () => {
  const faults = readServiceFaults(MAC_HANG, "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.session} ${fault.host} ${fault.what}`), [
    "01a14d93 us-metal02 an idle check failed, get_state timed out after 30 s",
    "01a14df3 mac an idle check failed, get_state timed out after 30 s",
    "01a14df8 mac an idle check failed, get_state timed out after 30 s",
    "01a11ba8 mac opening it failed, attach timed out after 30 s",
    "01a14d7c us-metal02 a wake's send failed, send_message timed out after 30 s",
    "01a14dea mac opening it failed, get_queue timed out after 30 s",
  ]);
  assert.equal(faults[3]!.at, Date.parse("2026-10-18T08:03:33.782Z"));
});

test("an open counts when it reached the daemon and ran over 30 s, and not when its tab closed it or it only read the file", () => {
  const faults = readServiceFaults([
    "2026-10-18T08:22:45.000Z feeds: closed a socket that missed a pong for 25000 ms",
    "open 01a14d7c live 181 messages: catalog 0ms, first page 5ms, queue 0ms, attach 47592ms, snapshot+project 2114ms, total 49712ms",
    "open 01a14dea saved 170 messages: catalog 15014ms, first page 13269ms, total 28295ms",
    "open 01a14b76 saved 337 messages: catalog 30586ms, first page 23ms, total 30707ms",
    "open 01a14e05 saved 35 messages: catalog 1ms, first page 426ms, queue 11008ms, listed active but the daemon has no live 89e3d43034ec: read saved, failed: This thread was closed while it was opening., total 16458ms",
    "open 01a14d56 live 89 messages: catalog 0ms, first page 285ms, queue 8100ms, attach 10347ms, snapshot+project 3058ms, total 21791ms",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.session} ${fault.what}`), ["01a14d7c opening it took 50 s"]);
});

test("a worker start refused or over 30 s counts at its end, and an answer in 5.7 s does not", () => {
  const faults = readServiceFaults([
    "2026-10-18T10:47:02.083Z daemon create /Users/sieunpark: refused in 215.1 s",
    "2026-10-18T08:02:25.603Z daemon create check-in YouTube crawler failures 17:02: answered in 5.7 s",
    "2026-10-18T08:21:08.992Z daemon resume 01a14ded: answered in 37.2 s",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => [new Date(fault.at).toISOString(), fault.title ?? fault.session, fault.what]), [
    ["2026-10-18T10:50:37.183Z", "/Users/sieunpark", "its create was refused in 215.1 s"],
    ["2026-10-18T08:21:46.192Z", "01a14ded", "its resume was answered in 37.2 s"],
  ]);
});

// 10-18 11:37:37Z the release cut off a duty create ("client closed"), the daemon made the session anyway, and the retry at 11:40:09Z was
// refused for the taken name, which the duty adopted; before the reason was logged that refusal made the minute dirty with no cause named.
// The cut itself is the service closing its own daemon link at its stop, so it is the restart and no daemon fault.
test("a worker start's refusal carries its reason, and a create the service's stop cut or one refused for a name an earlier create took is left out", async () => {
  const lines: string[] = [];
  let now = Date.parse("2026-10-18T11:40:09.644Z");
  await timedWorkerStart("create visitors become paying users slack green guy 20:37", async () => { now += 2_100;
    return { success: false, error: 'Agent name "visitors become paying users slack green guy 20:37" is unavailable: an agent of that name already exists at depth 0 under this parent' }; },
  line => { lines.push(line); }, () => now);
  assert.match(lines[0]!, /refused in 2\.1 s: Agent name .* is unavailable: an agent of that name already exists/);
  const faults = readServiceFaults([
    "2026-10-18T11:37:37.028Z daemon create visitors become paying users slack green guy 20:37: no answer after 3.5 s: Prime Agent daemon client closed before the operation completed. Socket: /tmp/prime-agent-1001/daemon.sock.",
    ...lines,
    "2026-10-18T10:47:02.083Z daemon create check-in chat-057a 15:32: refused in 0.1 s: Session worker is failed",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => [fault.title, fault.what]), [
    ["check-in chat-057a 15:32", "its create was refused in 0.1 s, its session worker was failed"],
  ]);
});

test("a job's wake that failed reading its file through the Mac's relay is no daemon call, and a wake whose send timed out is one", () => {
  const faults = readServiceFaults([
    "2026-10-18T11:15:20.468Z catalog: copy of 01a11d25 from mac: read ECONNRESET",
    "job 01a14dea: wake: The session file on mac did not read: read ECONNRESET",
    "job 01a14e0f: wake: Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\". Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log.",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.session} ${fault.what}`), ["01a14e0f a job's wake failed, attach timed out after 30 s"]);
});

test("the supervisor's failed send counts, and a send to a stale session id does not", () => {
  const faults = readSupervisorFaults([
  "[2026-10-18T08:16:14.983Z] supervisor: Supervisor command send_message failed: Error: read ECONNRESET",
  "    at close (node:net:676:40)",
  "[2026-10-18T02:45:16.064Z] supervisor: Supervisor command send_message failed: Error: Unknown active session: 01a14ccf-848b-7217-bc9c-a6cdc9873319",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => fault.what), ["the supervisor's send_message failed, its worker reset the connection"]);
});

// 10-18 on us-metal02: the 12:29:25Z release closed the service's daemon link 3.3 s into a duty create, and the outbox's refusals for a target
// whose worker was stopping or starting (12:06Z, 12:17Z, 12:18Z, 12:22Z) each counted, though the outbox delivered every one 6 to 63 s later.
test("the service's own stop and an outbox wait on a moving worker are no fault, and a wait past 30 s is a slow send", () => {
  const faults = readServiceFaults([
    "2026-10-18T12:29:18.575Z daemon create check-in metal-management 21:29: no answer after 3.3 s: Prime Agent daemon client closed before the operation completed. Socket: /tmp/prime-agent-1001/daemon.sock. Daemon log: /home/sieun/.prime/agent/logs/daemon.sock.ee92e1d8.log.",
    "2026-10-18T12:30:15.405Z daemon create check-in metal-management 21:29: refused in 0.2 s: Agent name \"check-in metal-management 21:29\" is unavailable: an agent of that name already exists at depth 0 under this parent",
    "2026-10-18T12:17:28.457Z outbox 01a11d25: the target's worker is stopping; m-ded9b958-ea2c-4eb7-ba6a-35e8ed97eec9 and the sends after it wait until get_state reads it",
    "2026-10-18T12:18:31.152Z outbox 01a11d25: m-ded9b958-ea2c-4eb7-ba6a-35e8ed97eec9 went after its target's worker was stopping for 63 s",
    "2026-10-18T12:22:34.446Z outbox 01a11ba8: the target's worker is starting; m-68c27818-0ab7-491f-b26c-33f68a8531f4 and the sends after it wait until get_state reads it",
    "2026-10-18T12:22:40.141Z outbox 01a11ba8: m-68c27818-0ab7-491f-b26c-33f68a8531f4 went after its target's worker was starting for 6 s",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => `${new Date(fault.at).toISOString()} ${fault.session} ${fault.what}`),
    ["2026-10-18T12:18:31.152Z 01a11d25 an outbox send waited 63 s while its worker was stopping"]);
});

// 10-18: outbox and open lines named no box unless a timeout's Socket did, so d7 booked the waits and refusals of Mac sessions 01a11d25,
// 01a10810, 01a10db4, 01a11ba8 and 01a14ec1 on us-metal02. The lines now name another box after the session, and a job's wake takes the box
// of the open just before it.
test("an outbox or open line that names its box books the fault there, and a job's wake takes the box of its open", () => {
  const faults = readServiceFaults([
    "2026-10-18T12:18:31.152Z outbox 01a11d25 on mac: m-ded9b958-ea2c-4eb7-ba6a-35e8ed97eec9 went after its target's worker was stopping for 63 s",
    "2026-10-18T12:19:27.037Z outbox 01a11ba8 on mac: m-bee74f88-b7da-4906-8918-f3ebb3720426 try 1: Session worker is failed",
    "open 01a14ec1 on mac live 149 messages: catalog 297ms, first page 55ms, queue 0ms, attach 2678ms, failed: Session worker is stopping, total 4163ms",
    "job 01a14ec1: wake: Session worker is stopping",
    "2026-10-18T12:32:20.015Z duty 01a14d31/d1: met, tool_rows_off 0 (on target)",
    "open 01a14efc saved 21 messages: catalog 0ms, first page 150ms, queue 0ms, failed: Session worker is stopping, total 516ms",
    "job 01a14efc: wake: Session worker is stopping",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.session} ${fault.host}`),
    ["01a11d25 mac", "01a11ba8 mac", "01a14ec1 mac", "01a14ec1 mac", "01a14efc us-metal02", "01a14efc us-metal02"]);
});

// 12:46:22Z on 10-18 the supervisor refused a wake's send_message with "Session worker is stopping", the outbox waited it out with no line,
// and the refusal alone made the minute dirty; the open of 01a14efc at 12:32:33Z was refused the same way.
test("the supervisor's refusal for a worker that is stopping or starting is no fault, since the service waits it out", () => {
  const faults = readSupervisorFaults([
    "[2026-10-18T12:46:22.561Z] supervisor: Supervisor command send_message failed: Error: Session worker is stopping",
    "[2026-10-18T12:32:33.591Z] supervisor: Supervisor command attach failed: Error: Session worker is stopping",
    "[2026-10-18T06:47:36.113Z] supervisor: Supervisor command attach failed: Error: Session worker is starting",
    "[2026-10-18T12:30:36.871Z] supervisor: Supervisor command reload failed: Error: Daemon worker client closed",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => fault.what), ["the supervisor's reload failed, its worker's connection closed"]);
});
