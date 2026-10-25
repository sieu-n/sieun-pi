// 10-23 us-metal02: the sweep of Crawler VP's deleted jobs deleted /drive2/sieun/scratch/01a1694a-d619-703c-8ccf-328d37540888 while that job's
// rig containers j1694a-ch, j1694a-kafka and j1694a-redis ran on it, and they ran on for 20 h; at 11:45Z on 10-24 the ClickHouse used 5.4
// cores and 2.5 GB RAM on its deleted parts. A container's processes read their paths inside the container, so the held check never saw the
// folder. A job's end now removes the containers that bind-mount a path it deletes, before it deletes it.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const box = mkdtempSync(join(tmpdir(), "job-end-containers-"));
process.env.HOME = box;
const { artifactsRoot, endLeftovers, leftoverSource, mountedIn } = await import("../src/job-leftovers.ts");
type Source = Parameters<typeof endLeftovers>[0];
const JOB = "01a1694a-d619-703c-8ccf-328d37540888";
const rig = "/drive2/sieun/scratch/01a1694a-d619-703c-8ccf-328d37540888";
const running = [
  { Name: "/j1694a-ch", Mounts: [{ Type: "bind", Source: `${rig}/ch` }] },
  { Name: "/j1694a-redis", Mounts: [{ Type: "bind", Source: `${rig}/redis` }] },
  { Name: "/nvme0w-pg", Mounts: [{ Type: "bind", Source: "/drive2/sieun/scratch/01a164d5-a2e8-708f-8162-63e671091625/pg" }, { Type: "volume", Source: `${rig}-vol` }] },
  { Name: "/auto-sns-agent-kafka-1" },
];

test("only the containers with a bind mount in a deleted path are picked", () => {
  assert.deepEqual(mountedIn(running, [rig]), ["j1694a-ch", "j1694a-redis"]);
  assert.deepEqual(mountedIn(running, [`${rig}/ch`]), ["j1694a-ch"]);
  assert.deepEqual(mountedIn(running, ["/drive2/sieun/scratch/01a1694a"]), []);
});

test("a job's end removes the containers on its folder before it deletes the folder, and reports them", async t => {
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const folder = join(box, "scratch", JOB);
  mkdirSync(folder, { recursive: true });
  const job = join(artifactsRoot(), "01a115e2-9544-7204-b8db-8ce4d5319048", "sub-9f6c8b05");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, `${JOB}.jsonl`), "{}\n");
  const steps: string[] = [];
  const source: Source = { strays: async () => [], stopServices: async () => [], started: async () => null, kill: () => {}, closeTabs: async () => 0, later: () => {},
    removeCopies: async () => [], inside: async () => [], artifactCopies: async () => [], kernelStates: async () => [], stopUnits: async () => [], writeOwned: async () => {},
    stopContainers: async dirs => { steps.push(`containers ${dirs.join(",")}`); return ["j1694a-ch"]; },
    removeTmp: async dirs => { steps.push(`remove ${dirs.join(",")}`); return dirs; } };
  const left = await endLeftovers(source, job);
  assert.deepEqual(steps, [`containers ${folder}`, `remove ${folder}`]);
  assert.deepEqual(left.containers, ["j1694a-ch"]);
});

test("the real source removes with docker rm -f only the running containers on the paths", { skip: process.platform === "win32" }, async t => {
  const bin = mkdtempSync(join(tmpdir(), "job-end-containers-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "inspect.json"), JSON.stringify(running));
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$*" >> ${log}\ncase "$1" in\n  ps) printf 'a1\\nb2\\nc3\\nd4\\n' ;;\n  inspect) cat ${join(bin, "inspect.json")} ;;\nesac\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  assert.deepEqual(await leftoverSource.stopContainers([rig]), ["j1694a-ch", "j1694a-redis"]);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["ps -q", "inspect a1 b2 c3 d4", "rm -f j1694a-ch", "rm -f j1694a-redis"]);
});
