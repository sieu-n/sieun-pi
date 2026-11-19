import { mkdir, stat, writeFile } from "node:fs/promises";
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
 * A stop holds the loop for as long as V8 takes to serialize the samples: 0.4 s for 3 min, 3.3 s for 1 h 41 min and 22.3 s for 9 h 20 min
 * of 1 ms samples in service.log from 11-16 to 11-17. A scratch node on us-metal02 on 11-19 held 468,544 samples in 22 MB more RSS than the
 * same run unprofiled and stopped in 196 ms, so an hour at 10 ms, about 360,000 samples, costs a stop near 150 ms and about 17 MB.
 */
export const ROLL_MS = 3_600_000;
/**
 * The heap profile beside each CPU profile holds the run's sampled allocations still live at that window's end, so it names the code that holds the heap.
 * On 11-03 the live chat kept 1.3 GB in V8 heap pages, 442 MB of them in swap. A 64 KiB interval cost no CPU a bench on us-metal02 could
 * measure (4.25 s with it against 4.41 s without, 300 rounds of 20,000 rows).
 */
const HEAP_SAMPLE_BYTES = 64 * 1024;
export const HEAP_PROFILE_SUFFIX = ".heapprofile";

export interface RunProfile { stop(): Promise<string | null> }

const isDir = (path: string): Promise<boolean> => stat(path).then(found => found.isDirectory(), () => false);
const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

export async function startRunProfile(input: { dataDir: string; log: (line: string) => void; now?: () => Date; rollMs?: number }): Promise<RunProfile> {
  const dir = join(input.dataDir, CPU_PROFILE_DIR);
  const now = input.now ?? (() => new Date());
  if (!(await isDir(dir))) return { stop: async () => null };
  let began = now();
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
  await session.post("Profiler.start");
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", { samplingInterval: HEAP_SAMPLE_BYTES });
  input.log(`cpu profile: on, each ${Math.round((input.rollMs ?? ROLL_MS) / 60_000)} min of the run goes to ${dir}`);
  /** Writes the window since `began` and starts the next one, or ends profiling when `last`. */
  const save = async (last: boolean): Promise<string> => {
    const at = Date.now();
    const { profile } = await session.post("Profiler.stop");
    if (!last) await session.post("Profiler.start");
    const { profile: heap } = last ? await session.post("HeapProfiler.stopSampling") : await session.post("HeapProfiler.getSamplingProfile");
    if (last) session.disconnect();
    const ended = now();
    const stem = join(dir, `${stamp(began)}--${stamp(ended)}-pid${process.pid}`);
    began = ended;
    const file = `${stem}.cpuprofile`;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(profile));
    await writeFile(`${stem}${HEAP_PROFILE_SUFFIX}`, JSON.stringify(heap));
    input.log(`cpu profile: ${file} in ${Date.now() - at} ms`);
    return file;
  };
  let saving: Promise<unknown> = Promise.resolve();
  const roll = setInterval(() => {
    saving = saving.then(() => save(false)).catch(error => input.log(`cpu profile: the roll failed: ${error instanceof Error ? error.message : String(error)}`));
  }, input.rollMs ?? ROLL_MS);
  roll.unref();
  let done: Promise<string | null> | null = null;
  return { stop: () => done ??= (async () => {
    clearInterval(roll);
    await saving;
    return await save(true);
  })() };
}
