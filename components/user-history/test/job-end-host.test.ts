// 10-19: the chat service runs on us-metal02, and a Mac chat's job folders, owned.json records, strays and Aside tabs are on the Mac, so a Mac
// job's end found no folder on the box and stopped nothing (signup and add brand recorded box world units only in Mac owned.json files). The
// end now runs on the box whose daemon runs the folder's session, and the units a Mac record names are stopped on the box.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const box = mkdtempSync(join(tmpdir(), "job-end-host-box-"));
process.env.HOME = box;
const { ARTIFACTS, endLeftovers, hostLeftovers, sshLeftovers } = await import("../src/job-leftovers.ts");
type Source = Parameters<typeof endLeftovers>[0];
const mac = { name: "mac", hostname: "Sieuns-MacBook-Pro", address: "100.66.173.18", relayPort: 7790, token: "file:x", daemonSocket: "/tmp/d.sock", ssh: "sieunpark@mac", roles: {} };
const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const JOB = "01a15515-c587-705b-ab73-77b9e3023031";

function fakeSource(stopUnits: Source["stopUnits"], log: string[]): Source {
  return { strays: async () => [], started: async () => null, kill: () => {}, closeTabs: async () => 0, later: () => {}, removeCopies: async () => [], inside: async () => [],
    removeTmp: async dirs => dirs, stopContainers: async () => [], stopUnits, writeOwned: async file => { log.push(`write ${file}`); }, artifactCopies: async () => [], kernelStates: async () => [],
    stopServices: async () => [] };
}

test("a Mac chat's job ends on the Mac, and the box stops the box units its record names", async () => {
  const stops: string[][] = [];
  const calls: [string, readonly string[]][] = [];
  const local = fakeSource(async units => { stops.push([...units]); return units; }, []);
  const ends = hostLeftovers({ local, hostOf: id => id === CHAT ? mac : null, remote: async (host, args) => {
    calls.push([host.name, args]);
    return { stopped: [], tabs: 1, copies: [], artifacts: [], owned: ["/Users/sieunpark/scratch/bp"], units: [], elsewhere: ["bp-world.service"] };
  } });
  const left = await ends.leftovers(join(ARTIFACTS, CHAT, "sub-63cc71f6"), JOB);
  assert.deepEqual(calls, [["mac", ["end", `${CHAT}/sub-63cc71f6`, JOB]]]);
  assert.deepEqual(stops, [["bp-world.service"]]);
  assert.deepEqual([left.tabs, left.owned, left.units], [1, ["/Users/sieunpark/scratch/bp"], ["bp-world.service"]]);
  await ends.deleted(CHAT);
  assert.deepEqual(calls.at(-1), ["mac", ["deleted", CHAT]]);
  const boxChat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  await ends.leftovers(join(ARTIFACTS, boxChat, "sub-c86d652b"));
  await ends.deleted(boxChat);
  assert.equal(calls.length, 2, "a box chat's job ends on the box");
});

test("on a box with no systemd the units its records name come back as elsewhere and leave the record", async () => {
  const job = join(ARTIFACTS, CHAT, "sub-63cc71f6");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [], units: ["bp-world.service"] }));
  const log: string[] = [];
  const left = await endLeftovers(fakeSource(async () => null, log), job);
  assert.deepEqual([left.units, left.elsewhere], [[], ["bp-world.service"]]);
  assert.deepEqual(log, [`write ${join(job, "owned.json")}`]);
});

test("a Mac job's end deletes the box trees its record names for the box and its box job folder, and sends a third box's paths there", async () => {
  // 10-20: Mac jobs held 22.4 GB of trees on us-metal02 they made over ssh, and no record could name a box path.
  for (const name of ["flow-at-scale-convex-scale", JOB, "not-named"]) mkdirSync(join(box, "scratch", name), { recursive: true });
  const removed: string[][] = [];
  const local = { ...fakeSource(async units => units, []), removeTmp: async (dirs: readonly string[]) => { removed.push([...dirs]); return dirs; } };
  const calls: [string, readonly string[]][] = [];
  const other = { ...mac, name: "far", ssh: "u@far" };
  const ends = hostLeftovers({ local, hostOf: id => id === CHAT ? mac : null, self: () => "us-metal02", hostNamed: name => name === "far" ? other : null,
    remote: async (host, args) => {
      calls.push([host.name, args]);
      return args[0] === "away" ? { stopped: [], tabs: 0, copies: [], artifacts: [], units: [], owned: ["/home/u/scratch/far-tree"] }
        : { stopped: [], tabs: 0, copies: [], artifacts: [], owned: [], units: [], sessions: [JOB],
          away: { "us-metal02": ["~/scratch/flow-at-scale-convex-scale", "~/scratch/../src", "~/.ssh"], far: ["~/scratch/far-tree"] } };
    } });
  const left = await ends.leftovers(join(ARTIFACTS, CHAT, "sub-77630b38"), JOB);
  assert.deepEqual(removed, [[join(box, "scratch", "flow-at-scale-convex-scale"), join(box, "scratch", JOB)]]);
  assert.deepEqual(calls.at(-1), ["far", ["away", "~/scratch/far-tree"]]);
  assert.deepEqual(left.owned, [join(box, "scratch", "flow-at-scale-convex-scale"), join(box, "scratch", JOB), "/home/u/scratch/far-tree"]);
});

test("a box record's paths on another box come back as away and stay in the record", async () => {
  const job = join(ARTIFACTS, "01a1164b-4a2d-742d-b27a-82f086ed0200", "sub-c86d652b");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [], units: [], hosts: { mac: ["~/scratch/mac-tree", "/etc/x"], "bad host": ["~/scratch/y"] } }));
  const written: unknown[] = [];
  const left = await endLeftovers({ ...fakeSource(async () => [], []), writeOwned: async (_file, record) => { written.push(record); } }, job);
  assert.deepEqual(left.away, { mac: ["~/scratch/mac-tree"] });
  assert.deepEqual(written, [{ paths: [], units: [], hosts: { mac: ["~/scratch/mac-tree"] } }]);
});

test("the remote end runs the CLI in the other box's sieun-pi checkout over ssh and deletes what that box's record owns", { skip: process.platform !== "linux" }, async t => {
  const other = mkdtempSync(join(tmpdir(), "job-end-host-mac-"));
  t.after(() => { rmSync(other, { recursive: true, force: true }); rmSync(box, { recursive: true, force: true }); });
  const bin = join(box, "fake-bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(other, ".local", "bin"), { recursive: true });
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor arg; do last="$arg"; done\nHOME=${other} exec sh -c "$last"\n`);
  writeFileSync(join(other, ".local", "bin", "sieun-pi"), `#!/bin/sh\necho ${resolve(import.meta.dirname, "..", "..", "..")}\n`);
  writeFileSync(join(other, ".local", "bin", "systemctl"), "#!/bin/sh\nexit 1\n");
  for (const file of [join(bin, "ssh"), join(other, ".local", "bin", "sieun-pi"), join(other, ".local", "bin", "systemctl")]) chmodSync(file, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const job = join(other, ".prime", "agent", "session-artifacts", CHAT, "sub-63cc71f6");
  const tree = join(other, "scratch", "brand-page", "tree");
  mkdirSync(job, { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(job, `${JOB}.jsonl`), "{}\n");
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [tree], units: [] }));
  const left = await sshLeftovers(mac, ["end", `${CHAT}/sub-63cc71f6`]);
  assert.deepEqual(left.owned, [tree]);
  assert.ok(!existsSync(tree));
  const boxTree = join(other, "work", "box-build");
  mkdirSync(boxTree, { recursive: true });
  const away = await sshLeftovers(mac, ["away", "~/work/box-build", "~/src", "~/scratch/it's-gone"]);
  assert.deepEqual(away.owned, [boxTree]);
  assert.ok(!existsSync(boxTree) && existsSync(join(other, ".local")));
});
