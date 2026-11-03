// Guards d7's side of the Mac's unusable minutes from 14:48Z to 14:57Z on 11-03. Crawler VP's small model classify job (01a1a15b) started MPS
// model runs on the Mac over ssh under ~/scratch/01a1a15b-.../, which carried no session env, so the pressure feed named them by their script
// (other:run_mps_bench.sh, 30.81 GB) and d7 booked the minutes to the app or owner side.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { type HostView, jobRigGb, measure, minuteSide } from "../scripts/duties/whole-system.ts";
import type { LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { type Footprints, hostWatchLine, type JobRig, type RawJobRig, type UsableReading, type WatchLine } from "../src/mac-usable-watch.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const SMC = "01a1a15b-1e2a-7223-bdf4-fef3781b14be";

/** The Mac's watch reading at 14:48:30Z on 11-03, owners and groups as the pressure feed gave them. */
const at1448: UsableReading = { pressureLevel: 2, swapoutsPerS: 18205.9, kernelTaskPct: 52.4,
  owners: [{ owner: "other:run_mps_bench.sh", label: "run_mps_bench.sh", gb: 30.81 }, { owner: "browser:chrome", label: "Google Chrome", gb: 8.63 },
    { owner: "other:rest", label: "rest", gb: 3.48 }, { owner: "other:ChatGPT", label: "ChatGPT", gb: 3.39 }, { owner: "browser:aside", label: "Aside", gb: 2.14 },
    { owner: "chat:01a15427-145f-751d-ba15-d27b6c30f65f", label: "sep launch!! (product guy)", gb: 1.36 }],
  groups: { other: 38.9, browsers: 13.45, agents: 2.52, dev: 2.52, coding: 1.14, system: 8.66 } };
const rig: JobRig = { dir: `scratch/${SMC}`, gb: 30.81, pids: 3, command: "bash run_mps_bench.sh mdeberta" };
const view = (jobRigs?: JobRig[]): HostView => ({ name: "mac", usable: at1448, workers: 4, workerGb: 2.1, top: [], ...jobRigs ? { jobRigs } : {} });

test("a swap minute whose largest holder is a job's rig under ~/scratch goes to the harness", () => {
  assert.equal(jobRigGb(view([rig])), 30.81);
  assert.equal(minuteSide(view([rig])), "harness");
  assert.equal(minuteSide(view()), "other");
});

const RUN = Date.parse("2026-11-03T14:59:10Z");
const linux: LinuxUsable = { kind: "linux", memSomeAvg10: 0.5, memFullAvg10: 0.5, cpuSomeAvg10: 10, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 };
const line = (minute: number): WatchLine => ({ at: `2026-11-03T14:${minute}:30.015Z`, host: "us-metal02", usable: linux, workers: 22, workerGb: 50, top: [],
  live: 71, working: 43, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: at1448, workers: 4, workerGb: 2.1, top: [], live: 9, working: 3, swapGb: 35.2, jobRigs: [rig] }] });

test("d7 books the 14:48Z to 14:57Z Mac minutes to the harness and names the chat and job whose rigs held them", () => {
  const { metrics, flagged } = measure({ now: RUN, watch: Array.from({ length: 10 }, (_, at) => line(48 + at)), log: { holds: [] },
    chats: [{ id: CRAWLER, name: "Crawler VP", duties: [], runs: [] }], named: new Map([[CRAWLER, new Map([["small model classify", [SMC]]])]]) });
  assert.equal(metrics.harness_unusable_min_30, 10);
  assert.equal(metrics.harness_rig_unusable_min_30, 10);
  assert.equal(metrics.other_unusable_min_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /job rigs 30\.81 GB: Crawler VP, job small model classify 30\.81 GB in ~\/scratch\/01a1a15b/);
  assert.match(flagged?.find(slice => slice.kind === "job_rig_minutes")?.excerpt ?? "",
    /^Crawler VP's job small model classify held most of the harness's memory on mac with its rigs in 10 unusable minutes \(14:48Z.*\), up to 30\.81 GB.*Steer Crawler VP /);
});

test("the Mac's watch line keeps the helper's job rigs and drops a malformed one", async () => {
  const footprints = (rigs: unknown): Footprints => ({ workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: 2, cpu_s: 0, job_rigs: rigs as RawJobRig[] });
  const read = async (rigs: unknown) => await hostWatchLine({ name: "mac", rows: [], read: async () => ({ usable: null, footprints: footprints(rigs) }) },
    { now: RUN, chats: new Set(), title: () => null });
  const good = { dir: `scratch/${SMC}`, pids: 3, bytes: Math.round(30.81 * 1024 ** 3), biggest: { pid: 32283, bytes: 10 * 1024 ** 3, started: 0, command: "python train.py minilm_l256" } };
  assert.deepEqual((await read([good, { dir: "/etc", pids: 1, bytes: 5 }, { dir: "work/x", pids: -1, bytes: 5 }])).jobRigs,
    [{ dir: `scratch/${SMC}`, gb: 30.81, pids: 3, command: "python train.py minilm_l256" }]);
  assert.equal((await read(null)).jobRigs, undefined);
});

test("the footprint helper sums a rig dir's processes by cwd or command with their children, and leaves out a process with a session env", () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("wf", sys.argv[1]); wf = importlib.util.module_from_spec(spec); spec.loader.exec_module(wf)
home = wf.HOME
table = {10: (1, 10, 0, (["bash", "run_mps_bench.sh"], [])), 11: (10, 10, 0, (["python", "bench.py"], [])),
         12: (1, 12, 0, (["python", home + "/work/smc-enc/train.py"], [])), 20: (1, 20, 0, (["python", "x.py"], ["RLM_SESSION_DIR=/a"])),
         30: (1, 30, 0, (["vim"], [])), 40: (1, 40, 0, (["python", "y.py"], []))}
cwd = {10: home + "/scratch/abc/encoder", 11: home + "/scratch/abc/encoder", 12: home, 20: home + "/scratch/abc", 30: home, 40: home + "/scratch/abc"}
wf.cwd_of = cwd.get
wf.footprint = lambda pid: pid * 1000
print(json.dumps(wf.job_rigs(table, {40})))`;
  const rigs = JSON.parse(execFileSync("python3", ["-c", script, HELPER], { encoding: "utf8" })) as { dir: string; pids: number; bytes: number }[];
  assert.deepEqual(rigs.map(({ dir, pids, bytes }) => ({ dir, pids, bytes })), [{ dir: "scratch/abc", pids: 2, bytes: 21000 }, { dir: "work/smc-enc", pids: 1, bytes: 12000 }]);
});
