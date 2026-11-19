import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { console as inspectorConsole } from "node:inspector";
import { Session } from "node:inspector/promises";
import { join } from "node:path";

/**
 * CPU and heap profiles of the chat service's run, from its start to its stop in windows of `ROLL_MS`, while `<dataDir>/cpu-profiles` exists at
 * start. The live service takes no debugger (AGENTS.md) and perf needs root on us-metal02 (perf_event_paranoid 4), so the service profiles
 * itself through an in-process inspector session. Each sample keeps its time, so a stall's stack reads from the profile's samples and timeDeltas.
 *
 * V8 keeps every sample of a running profile in native memory until Profiler.stop. Until 11-19 one profile at 1 ms covered the whole run: the
 * live chat that started at 07:37Z on 11-18 took 905 samples a second, as its 5 h predecessor's 16.1 M did, and 32 h in it held 9.5 GB of
 * anonymous memory, 4.6 GB of it in swap and about 5 GB of it samples at the 47 bytes each measured below, while its major GCs grew from
 * 30 ms to 0.6 s and stalled its loop 1.1 s at 15:47Z on 11-19.
 */
export const CPU_PROFILE_DIR = "cpu-profiles";
/**
 * 10 ms keeps 100 samples of a 1 s stall, which still name its stack, at a tenth of the memory and of the stop's cost of 1 ms, V8's default.
 */
const SAMPLE_US = 10_000;
/**
 * A stop holds the loop while V8 serializes the window. On 11-20 a scratch node on us-metal02 with the chat's bundle loaded and a tree of
 * 8,200 nodes, as the live chat's 7,016, stopped 11,000 samples in 95 to 106 ms, 113,000 in 244 ms and 367,000, an hour at 10 ms, in 392 ms.
 * A quarter hour, about 90,000 samples, stops near 200 ms, which keeps a roll well under d7's 1 s stall line on a busy box.
 */
export const ROLL_MS = 900_000;
/**
 * Each roll keeps one profile of its own open across the stop and the start. With none open the inspector disposes V8's CPU profiler at the
 * stop, and the next start logs every compiled function again: on the same scratch node that start held the loop 1.8 to 2.1 s, and in
 * the live chat the 18:06Z to 19:06Z roll on 11-19 took 1,835 ms and stalled its loop 1.7 s. With the bridge the start took 0.2 ms.
 */
const BRIDGE_TITLE = "run-profile roll";
/**
 * The heap profile beside the last CPU profile holds the run's sampled allocations still live at the stop, so it names the code that holds the heap.
 * On 11-03 the live chat kept 1.3 GB in V8 heap pages, 442 MB of them in swap. A 64 KiB interval cost no CPU a bench on us-metal02 could
 * measure (4.25 s with it against 4.41 s without, 300 rounds of 20,000 rows). Reading it forces a full GC, 115 ms with a 112 MB heap and 896 ms
 * with 1.25 GB on the scratch node, so only the run's stop reads it and the rolls do not.
 */
const HEAP_SAMPLE_BYTES = 64 * 1024;
export const HEAP_PROFILE_SUFFIX = ".heapprofile";
/**
 * On 11-20 the folder held 965 profiles and 18 GB from 10-20 on. Every read of it in session history opened a profile from the same day, and
 * a week of quarter hour windows is about 2 GB.
 */
export const KEEP_MS = 7 * 24 * 3_600_000;

export interface RunProfile { stop(): Promise<string | null> }

const isDir = (path: string): Promise<boolean> => stat(path).then(found => found.isDirectory(), () => false);
const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/** Deletes the profiles in `dir` last written before `before`. */
async function prune(dir: string, before: number): Promise<number> {
  let deleted = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".cpuprofile") && !name.endsWith(HEAP_PROFILE_SUFFIX)) continue;
    const path = join(dir, name);
    const found = await stat(path).catch(() => null);
    if (!found || found.mtimeMs >= before) continue;
    await unlink(path).then(() => deleted++, () => {});
  }
  return deleted;
}

export async function startRunProfile(input: { dataDir: string; log: (line: string) => void; now?: () => Date; rollMs?: number }): Promise<RunProfile> {
  const dir = join(input.dataDir, CPU_PROFILE_DIR);
  const now = input.now ?? (() => new Date());
  if (!(await isDir(dir))) return { stop: async () => null };
  const pruneOld = (): Promise<void> => prune(dir, now().getTime() - KEEP_MS).then(
    deleted => { if (deleted > 0) input.log(`cpu profile: deleted ${deleted} profiles older than ${KEEP_MS / 86_400_000} days`); },
    error => input.log(`cpu profile: the prune failed: ${error instanceof Error ? error.message : String(error)}`));
  let began = now();
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
  await session.post("Profiler.start");
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", { samplingInterval: HEAP_SAMPLE_BYTES });
  input.log(`cpu profile: on, each ${Math.round((input.rollMs ?? ROLL_MS) / 60_000)} min of the run goes to ${dir}`);
  let pruning = pruneOld();
  /** Writes the window since `began` and starts the next one, or ends profiling and writes the heap profile when `last`. */
  const save = async (last: boolean): Promise<string> => {
    const at = Date.now();
    let held = performance.now();
    if (!last) inspectorConsole.profile(BRIDGE_TITLE);
    let profile: unknown;
    try {
      ({ profile } = await session.post("Profiler.stop"));
      if (!last) await session.post("Profiler.start");
    } finally {
      if (!last) inspectorConsole.profileEnd(BRIDGE_TITLE);
    }
    const heap = last ? (await session.post("HeapProfiler.stopSampling")).profile : null;
    if (last) session.disconnect();
    const cpuJson = JSON.stringify(profile);
    held = performance.now() - held;
    const ended = now();
    const stem = join(dir, `${stamp(began)}--${stamp(ended)}-pid${process.pid}`);
    began = ended;
    const file = `${stem}.cpuprofile`;
    await mkdir(dir, { recursive: true });
    await writeFile(file, cpuJson);
    if (heap) await writeFile(`${stem}${HEAP_PROFILE_SUFFIX}`, JSON.stringify(heap));
    input.log(`cpu profile: ${file} in ${Date.now() - at} ms, ${Math.round(held)} ms of it in the profiler`);
    return file;
  };
  let saving: Promise<unknown> = Promise.resolve();
  const roll = setInterval(() => {
    saving = saving.then(() => save(false)).catch(error => input.log(`cpu profile: the roll failed: ${error instanceof Error ? error.message : String(error)}`));
    pruning = pruning.then(pruneOld);
  }, input.rollMs ?? ROLL_MS);
  roll.unref();
  let done: Promise<string | null> | null = null;
  return { stop: () => done ??= (async () => {
    clearInterval(roll);
    await saving;
    await pruning;
    return await save(true);
  })() };
}
