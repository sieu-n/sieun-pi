// d7's 08:08 KST run on 11-20 read 29 of 30 clean, and its one dirty minute named only "chat designer bro, works on 5180 only +2.22 GB (1.02 to
// 3.24 GB)". The cause was designer bro's job "5180 viewer feed pictures" (01a1f603), which started 11 `node scripts/demo/snapshot-media.mjs`
// runs on the Mac at 22:57Z on 11-19 in ~/Documents/Github/auto-sns-agent. They ran under its kernel in no rig dir, so d7 counted no job-rig
// minute and named no job to steer. The fixture is the watch's 22:56:30Z and 22:57:30Z lines with the Mac's part as written, a calm us-metal02
// reading in place of that box's own, and the job's `kernelRigs` the watch now writes, estimated from the chat tree's 0.35 and 2.65 GB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { type Footprints, hostWatchLine, type WatchLine } from "../src/mac-usable-watch.ts";

const ROOT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const JOB = "01a1f603-69f4-71ad-81cb-6287331774c5";
const lines = JSON.parse(readFileSync(new URL("fixtures/mac-job-commands-1119-2257.json", import.meta.url), "utf8")) as WatchLine[];
const NOW = Date.parse("2026-11-19T22:58:10Z");

test("the 22:57Z Mac swap minute names the job whose commands jumped and counts it as a job-rig minute", () => {
  const { metrics, flagged } = measure({ now: NOW, watch: lines, log: { holds: [] }, chats: [] });
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /22:57Z mac unusable \(swapouts; the largest jump since 22:56Z was chat designer bro, works on 5180 only, job 5180 viewer feed pictures \+2\.22 GB \(1\.02 to 3\.24 GB, node scripts\/demo\/snapshot-media\.mjs --subjects post:DKGPhFf/);
  assert.equal(metrics.harness_rig_unusable_min_30, 1);
  assert.match(flagged?.find(slice => slice.kind === "job_rig_minutes")?.excerpt ?? "",
    /^designer bro, works on 5180 only's job 5180 viewer feed pictures held most of the harness's memory on mac with its rigs in 1 unusable minute \(22:57Z\), up to 2\.45 GB in its commands \(node scripts\/demo\/snapshot-media\.mjs.*Steer designer bro, works on 5180 only /);
});

test("the Mac's watch line names each session's commands by its chat and job, whatever dir they run in", async () => {
  const GB = 1024 ** 3;
  const footprints: Footprints = { workers: { "51476": { pids: 30, bytes: 3.34 * GB } }, swap_used_bytes: 17.6 * GB, pressure_level: 2, cpu_s: 0,
    kernels: [
      { pid: 100, root: ROOT, session: ROOT, pids: 2, bytes: 0.4 * GB, own: 0.2 * GB, biggest: { pid: 101, bytes: 0.2 * GB, started: 1, command: "/Users/sieunpark/.local/bin/aside mcp" } },
      { pid: 200, root: ROOT, session: JOB, pids: 12, bytes: 2.6 * GB, own: 0.15 * GB,
        biggest: { pid: 55737, bytes: 0.24 * GB, started: 1795129037, command: "node scripts/demo/snapshot-media.mjs --subjects post:DKGPhFfP5qi" } },
      { pid: 300, root: ROOT, session: "01a1f600-0000-7000-8000-000000000001", pids: 1, bytes: 0.1 * GB, own: 0.1 * GB, biggest: null }] };
  const rows = [
    { sessionId: ROOT, sessionName: "designer bro", lifecycle: "live", activeSessionId: ROOT, workerPid: 51476 },
    { sessionId: JOB, parentSessionId: ROOT, sessionName: "5180 viewer feed pictures", lifecycle: "live", activeSessionId: JOB, workerPid: 51476, activity: "working" }];
  const line = await hostWatchLine({ name: "mac", rows, read: async () => ({ usable: null, footprints }) },
    { now: NOW, chats: new Set([ROOT]), title: id => id === ROOT ? "designer bro, works on 5180 only" : null });
  assert.deepEqual(line.kernelRigs, [
    { session: JOB, root: ROOT, tree: "designer bro, works on 5180 only", job: "5180 viewer feed pictures", gb: 2.45, pids: 11, command: "node scripts/demo/snapshot-media.mjs --subjects post:DKGPhFfP5qi" },
    { session: ROOT, root: ROOT, tree: "designer bro, works on 5180 only", gb: 0.2, pids: 1, command: "/Users/sieunpark/.local/bin/aside mcp" }]);
});
