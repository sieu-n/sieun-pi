// 10-23 to 11-02 us-metal02: each 10 min sweep of deleted jobs sshed to the Mac once per Mac chat while the Mac was offline, 59 tries a pass,
// each waiting out ConnectTimeout=10, and service.log took 37,233 "job leftovers on mac: ssh: connect to host 100.66.173.18 port 22: Connection
// timed out" lines. A pass now tries an unreachable box once and leaves its other chats to the next pass.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "deleted-sweep-away-"));
process.env.HOME = home;
const { HostUnreachable, hostLeftovers, sshLeftovers } = await import("../src/job-leftovers.ts");
type Source = Parameters<typeof hostLeftovers>[0]["local"];
const mac = { name: "mac", hostname: "Sieuns-MacBook-Pro", address: "100.66.173.18", relayPort: 7790, token: "file:x", daemonSocket: "/tmp/d.sock", ssh: "sieunpark@mac", roles: {} };
const MAC_CHATS = ["01a14c54-0000-7000-8000-000000000001", "01a14c49-0000-7000-8000-000000000002", "01a14bd1-0000-7000-8000-000000000003"];
const BOX_CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const local: Source = { strays: async () => [], started: async () => null, kill: () => {}, closeTabs: async () => 0, later: () => {}, removeCopies: async () => [],
  inside: async () => [], removeTmp: async dirs => dirs, stopContainers: async () => [], stopUnits: async units => units, writeOwned: async () => {},
  artifactCopies: async () => [], kernelStates: async () => [], stopServices: async () => [] };
const hostOf = (id: string) => MAC_CHATS.includes(id) ? mac : null;

test("a pass sshes to a box that does not connect once, gives null for its other chats, and tries it again on the next pass", async () => {
  const calls: string[] = [];
  const ends = hostLeftovers({ local, hostOf, remote: async (host, args) => {
    calls.push(`${host.name} ${args.join(" ")}`);
    throw new HostUnreachable(`job leftovers on ${host.name}: ssh: connect to host 100.66.173.18 port 22: Connection timed out`);
  } });
  const away = new Set<string>();
  await assert.rejects(ends.deleted(MAC_CHATS[0]!, away), HostUnreachable);
  assert.equal(await ends.deleted(MAC_CHATS[1]!, away), null);
  assert.equal(await ends.deleted(MAC_CHATS[2]!, away), null);
  assert.ok(await ends.deleted(BOX_CHAT, away), "a box chat's sweep runs on the box");
  assert.deepEqual(calls, [`mac deleted ${MAC_CHATS[0]}`]);
  await assert.rejects(ends.deleted(MAC_CHATS[1]!, new Set()), HostUnreachable);
  assert.equal(calls.length, 2, "the next pass tries the box again");
});

test("a box Tailscale reads offline gets no ssh at all, and a failing remote command keeps the box in the pass", async () => {
  const calls: string[] = [];
  let online = false;
  let fails = false;
  const ends = hostLeftovers({ local, hostOf, online: async () => online, remote: async (host, args) => {
    calls.push(`${host.name} ${args[0]}`);
    if (fails) throw new Error(`job leftovers on ${host.name}: node: not found`);
    return { stopped: [], tabs: 0, copies: [], artifacts: [], owned: [], units: [] };
  } });
  const away = new Set<string>();
  await assert.rejects(ends.deleted(MAC_CHATS[0]!, away), /mac is offline/);
  assert.equal(await ends.deleted(MAC_CHATS[1]!, away), null);
  assert.deepEqual(calls, []);
  online = true;
  fails = true;
  const next = new Set<string>();
  await assert.rejects(ends.deleted(MAC_CHATS[0]!, next), error => !(error instanceof HostUnreachable));
  await assert.rejects(ends.deleted(MAC_CHATS[1]!, next));
  assert.deepEqual(calls, ["mac deleted", "mac deleted"], "a remote failure that is not ssh's own leaves the box reachable");
});

test("sshLeftovers names ssh's own failure, exit 255, HostUnreachable, and a remote command's failure a plain error", { skip: process.platform === "win32" }, async t => {
  const bin = join(home, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(home, { recursive: true, force: true }); });
  process.env.PATH = `${bin}:${path}`;
  const ssh = (code: number, text: string) => { writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho '${text}' >&2\nexit ${code}\n`); chmodSync(join(bin, "ssh"), 0o755); };
  ssh(255, "ssh: connect to host 100.66.173.18 port 22: Connection timed out");
  await assert.rejects(sshLeftovers(mac, ["deleted", MAC_CHATS[0]!]), error => error instanceof HostUnreachable && /Connection timed out/.test(error.message));
  ssh(1, "node: not found");
  await assert.rejects(sshLeftovers(mac, ["deleted", MAC_CHATS[0]!]), error => !(error instanceof HostUnreachable) && /node: not found/.test((error as Error).message));
});

test("the sweep logs the one failed try and one line for the chats it left to the next pass", async () => {
  const { Chats } = await import("../src/chats.ts");
  const { IdIndex } = await import("../src/id-index.ts");
  const { loadRecord } = await import("../src/chat-brief.ts");
  const { JOB_CLEANUP_EVERY_MS } = await import("../src/chat-checkin.ts");
  const { fakeThreads, source } = await import("./chats-helpers.ts");
  const dir = join(home, "data");
  mkdirSync(dir, { recursive: true });
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of MAC_CHATS) await index.add(id);
  let tries = 0;
  const ends = hostLeftovers({ local, hostOf, remote: async () => { tries++; throw new HostUnreachable("job leftovers on mac: ssh: connect to host 100.66.173.18 port 22: Connection timed out"); } });
  let now = Date.parse("2026-11-02T06:51:00Z");
  const lines: string[] = [];
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now), archived: new IdIndex(join(dir, "archived-chats.json"), "Archived chat index"),
    deletedLeftovers: (chat, away) => ends.deleted(chat, away),
  }, line => lines.push(line));
  await chats.adopt();
  now += JOB_CLEANUP_EVERY_MS;
  await chats.tick();
  await chats.settled();
  chats.close();
  const sweep = lines.filter(line => line.includes("deleted job leftovers"));
  assert.equal(tries, 1);
  assert.equal(sweep.length, 2, sweep.join("\n"));
  assert.match(sweep[0]!, /Connection timed out/);
  assert.equal(sweep[1], "chats: deleted job leftovers: could not reach mac, so 2 more chats there wait for the next pass");
});
