// Guards 10-18 from about 14:00Z: the owner's MacBook Pro slept with its lid closed (Tailscale "offline, last seen 2h ago" at 16:02Z), the chat
// service on us-metal02 tried every queued message to about 14 Mac sessions every 50 s, each try burned a 10 s handshake timeout on hosts/mac.sock,
// and the Whole system precheck booked all 30 minutes as daemon faults (clean_min_30 0) while us-metal02 read usable in all of them.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import { HostReach, peerReach } from "../src/host-reach.ts";
import { hostWatchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import type { LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";

const MAC = "100.66.173.18";
const status = (online: boolean) => JSON.stringify({ Peer: { "nodekey:1": { DNSName: "main-dev-sieuns-macbook-pro-m2max.tail0c093d.ts.net.", TailscaleIPs: [MAC, "fd7a:115c:a1e0::1c34:ad13"], Online: online, LastSeen: "2026-10-18T13:10:00.1Z" } } });
const HANDSHAKE = "Timed out after 10000ms waiting for the Prime Agent daemon handshake. Socket: /home/sieun/.local/state/sieun-pi/hosts/mac.sock. Daemon log: /home/sieun/.prime/agent/logs/mac.sock.7f502fe7.log.";
const SESSIONS = ["01a14ecb-0000-7000-8000-000000000001", "01a14dea-0000-7000-8000-000000000002"];

test("Tailscale's peer entry reads the Mac by its address or its DNS name, and output it cannot read counts as online", () => {
  assert.deepEqual(peerReach(status(false), MAC), { online: false, lastSeen: "2026-10-18T13:10:00.1Z" });
  assert.deepEqual(peerReach(status(false), "main-dev-sieuns-macbook-pro-m2max.tail0c093d.ts.net"), { online: false, lastSeen: "2026-10-18T13:10:00.1Z" });
  assert.deepEqual(peerReach(status(true), MAC), { online: true });
  assert.deepEqual(peerReach("", MAC), { online: true });
  assert.deepEqual(peerReach(status(false), "100.83.139.73"), { online: true });
});

test("lanes that ask while one Tailscale read runs share it and write one offline line and one back line", async () => {
  let online = false;
  const lines: string[] = [];
  let clock = Date.parse("2026-10-18T16:27:47Z");
  const reach = new HostReach({ addressOf: () => MAC, status: async () => { await new Promise(done => setTimeout(done, 5)); return status(online); }, log: line => lines.push(line), now: () => clock });
  await Promise.all(Array.from({ length: 21 }, () => reach.reach("mac")));
  online = true;
  clock += 60_000;
  await Promise.all(Array.from({ length: 21 }, () => reach.reach("mac")));
  assert.deepEqual(lines, ["hosts: mac is offline (Tailscale last seen 3h ago); messages to its sessions wait until it is back", "hosts: mac is back online after 1 min; its waiting messages go now"]);
});

/** An outbox whose Mac sessions sit on a box Tailscale reads offline until `wake()`; every sleep moves the clock by its length. */
async function rig(answers: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-offline-"));
  let clock = Date.parse("2026-10-18T16:00:00Z");
  let online = false;
  const lines: string[] = [];
  const calls: string[] = [];
  let reads = 0;
  const reach = new HostReach({ addressOf: host => host === "mac" ? MAC : undefined, status: async () => { reads++; return status(online); }, log: line => lines.push(line), now: () => clock });
  const outbox = new AgentOutbox(dir, {
    log: line => lines.push(line),
    hostOf: session => SESSIONS.includes(session) ? "mac" : null,
    reach: host => reach.reach(host),
    send: async session => { calls.push(`send ${session.slice(0, 8)}`); if (!answers) throw new Error(HANDSHAKE); return "sent"; },
    target: async session => { calls.push(`target ${session.slice(0, 8)}`); return { queued: [], busy: false }; },
    fileOf: async () => null,
    now: () => clock,
    sleep: async ms => { clock += ms; await new Promise(done => setImmediate(done)); },
  });
  return { outbox, lines, calls, reads: () => reads, wake: () => { online = true; } };
}

test("a message to a session on an offline Mac waits with no try and no fault line, and goes once the Mac is back", async () => {
  const { outbox: box, lines, calls, reads, wake } = await rig(true);
  for (const session of SESSIONS) for (const n of [1, 2]) await box.deliver(session, `[wake] check ${n}`);
  while (reads() < 4) await new Promise(done => setTimeout(done, 1));
  assert.equal(calls.length, 0, "no daemon call to the offline Mac");
  assert.deepEqual(lines.filter(line => !/^outbox \S+ on mac: m-\S+ waits with no try while mac reads offline$/.test(line)),
    ["hosts: mac is offline (Tailscale last seen 3h ago); messages to its sessions wait until it is back"]);
  assert.equal(lines.length, 3, "and one line for each held lane head");
  const held = (await box.outbox.pending(() => true))!;
  assert.equal(held.attempts, 0, "no try counted while the Mac is offline");
  wake();
  await box.outbox.idle();
  await box.close();
  assert.deepEqual(calls.filter(call => call.startsWith("send")).sort(), ["send 01a14dea", "send 01a14ecb"], "each session's two wakes go in one send");
  assert.equal(lines.filter(line => line.includes("is offline")).length, 1);
  assert.equal(lines.filter(line => line.includes("is back online")).length, 1, lines.join("\n"));
  assert.ok(!lines.some(line => line.startsWith("outbox ") && !/: m-\S+ (carries 2 queued messages in one send|waits with no try while mac reads offline|waited \d+ s while mac read offline; it goes now)/.test(line)), lines.join("\n"));
  assert.deepEqual(readServiceFaults(lines.map(line => `2026-10-18T16:01:00.000Z ${line}`), "us-metal02"), []);
});

test("a message to an online Mac that does not answer is still a try with its fault line, as before", async () => {
  const { outbox: box, lines, wake } = await rig(false);
  wake();
  await box.deliver(SESSIONS[0]!, "[wake] check");
  while (!lines.some(line => line.includes("try 2"))) await new Promise(done => setTimeout(done, 1));
  await box.close();
  const tries = lines.filter(line => line.startsWith("outbox 01a14ecb on mac: m-"));
  assert.match(tries[0]!, /try 1: Timed out after 10000ms waiting for the Prime Agent daemon handshake/);
  assert.ok(!lines.some(line => line.startsWith("hosts: ")), lines.join("\n"));
  const faults = readServiceFaults(tries.map(line => `2026-10-18T16:01:00.000Z ${line}`), "us-metal02");
  assert.equal(faults[0]?.host, "mac");
  assert.equal(faults[0]?.what, "an outbox send failed, the handshake timed out after 10 s");
});

test("the watch writes a box Tailscale reads offline as offline and does not ask its relay", async () => {
  let asked = 0;
  const read = async () => { asked++; throw new Error("fetch failed"); };
  const input = { now: Date.parse("2026-10-18T16:07:30Z"), chats: new Set<string>(), title: () => null };
  const off = await hostWatchLine({ name: "mac", rows: [], read, reach: async () => ({ online: false, lastSeen: "2026-10-18T13:10:00.1Z" }) }, input);
  assert.equal(off.offline, true);
  assert.equal(off.error, "offline, Tailscale last seen 3h ago");
  assert.equal(asked, 0);
  const on = await hostWatchLine({ name: "mac", rows: [], read, reach: async () => ({ online: true }) }, input);
  assert.equal(on.offline, undefined);
  assert.equal(on.error, "fetch failed");
  assert.equal(asked, 1);
});

// The 16:02Z run's window: us-metal02 usable in every minute, and two Mac outbox handshake timeouts a minute.
const RUN = Date.parse("2026-10-18T16:02:10Z");
const box: LinuxUsable = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 32 };
const minuteAt = (minute: number) => RUN - 10_000 - (30 - minute) * 60_000;
const lineAt = (minute: number, mac: "offline" | "silent"): WatchLine => ({
  at: new Date(minuteAt(minute) + 30_000).toISOString(), host: "us-metal02", usable: box, workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null,
  mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null,
    ...mac === "offline" ? { offline: true as const, error: "offline, Tailscale last seen 2h ago" } : { error: "fetch failed" } }] });
const macFaults = Array.from({ length: 30 }, (_, minute) => [10_000, 40_000].map(offset => ({ at: minuteAt(minute) + offset, host: "mac", session: "01a14ecb", what: "an outbox send failed, the handshake timed out after 10 s" }))).flat();

test("the precheck books a minute the Mac is offline as offline, so the minute is clean when us-metal02 is, and says so in its flag", () => {
  const result = measure({ now: RUN, watch: Array.from({ length: 30 }, (_, minute) => lineAt(minute, "offline")), log: { holds: [] }, chats: [], daemonFaults: macFaults });
  assert.equal(result.metrics.clean_min_30, 30);
  assert.equal(result.metrics.daemon_fail_min_30, 0);
  assert.equal(result.metrics.offline_min_30, 30);
  assert.equal(result.metrics.offline_min_30_mac, 30);
  assert.equal(result.metrics.unknown_min_30_mac, 0);
  assert.equal(result.metrics.unknown_min_30, 0);
  const minutes = result.flagged?.find(slice => slice.kind === "minutes")?.excerpt ?? "";
  assert.match(minutes, /mac read usable in 0, unusable in 0, unknown in 0 and offline in 30/);
  assert.match(minutes, /Tailscale read mac offline in 30, and 60 daemon calls to a box while it was offline are left out\./);
  assert.equal(result.flagged?.find(slice => slice.kind === "offline_minutes")?.excerpt, "mac offline 15:32Z to 16:01Z");
});

test("a us-metal02 fault in a minute the Mac is offline still makes that minute dirty", () => {
  const faults = [...macFaults, { at: minuteAt(29) + 5_000, host: "us-metal02", session: "01a14eaf", what: "an outbox send failed, the handshake timed out after 10 s" }];
  const result = measure({ now: RUN, watch: Array.from({ length: 30 }, (_, minute) => lineAt(minute, "offline")), log: { holds: [] }, chats: [], daemonFaults: faults });
  assert.equal(result.metrics.clean_min_30, 29);
  assert.equal(result.metrics.daemon_fail_min_30, 1);
});

test("a Mac Tailscale reads online that does not answer still makes its minutes daemon faults, as before", () => {
  const result = measure({ now: RUN, watch: Array.from({ length: 30 }, (_, minute) => lineAt(minute, "silent")), log: { holds: [] }, chats: [], daemonFaults: macFaults });
  assert.equal(result.metrics.clean_min_30, 0);
  assert.equal(result.metrics.daemon_fail_min_30, 30);
  assert.equal(result.metrics.offline_min_30, 0);
  assert.equal(result.metrics.unknown_min_30_mac, 30);
  assert.equal(result.flagged?.find(slice => slice.kind === "offline_minutes"), undefined);
});

// 10-28: the relay could not reach the Mac at 01:38:30Z, 01:39:27Z and 01:40:30Z, each minute with handshake timeouts to its sessions, and
// Tailscale first read it offline at 01:41:30Z; d7's 01:42Z run counted 01:38Z and 01:39Z dirty.
test("unreached reads in the lines just before Tailscale reads the box offline count offline, and their daemon calls are left out", () => {
  const macUp = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 5, owners: [] };
  const errors: Record<number, string> = { 26: "The operation was aborted due to timeout", 27: "unread: the chat service stopped before the relay answered", 28: "fetch failed" };
  const watch = Array.from({ length: 30 }, (_line, minute): WatchLine => {
    const line = lineAt(minute, "offline");
    const mac = line.hosts![0]!;
    if (minute >= 29) return line;
    const { offline: _offline, error: _error, ...rest } = mac;
    return { ...line, hosts: [minute < 26 ? { ...rest, usable: macUp } : { ...rest, error: errors[minute]! }] } as WatchLine;
  });
  const faults = [26, 27].flatMap(minute => [10_000, 40_000].map(offset => ({ at: minuteAt(minute) + offset, host: "mac", session: "01a14ecb", what: "an outbox send failed, the handshake timed out after 10 s" })));
  const result = measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults: faults });
  assert.equal(result.metrics.offline_min_30_mac, 4);
  assert.equal(result.metrics.daemon_fail_min_30, 0);
  assert.equal(result.metrics.unknown_min_30_mac, 0);
  assert.equal(result.metrics.clean_min_30, 30);
});

test("an unreached read more than three lines before Tailscale reads the box offline stays a daemon fault", () => {
  const watch = Array.from({ length: 30 }, (_line, minute): WatchLine => {
    const line = lineAt(minute, "offline");
    if (minute >= 29) return line;
    const { offline: _offline, error: _error, ...rest } = line.hosts![0]!;
    return { ...line, hosts: [{ ...rest, error: "fetch failed" }] } as WatchLine;
  });
  const faults = [25].flatMap(minute => [10_000, 40_000].map(offset => ({ at: minuteAt(minute) + offset, host: "mac", session: "01a14ecb", what: "an outbox send failed, the handshake timed out after 10 s" })));
  const result = measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults: faults });
  assert.equal(result.metrics.offline_min_30_mac, 4);
  assert.equal(result.metrics.daemon_fail_min_30, 1);
});
