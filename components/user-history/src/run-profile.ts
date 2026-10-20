import { mkdir, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";

/**
 * One CPU profile of the chat service's whole run, from its start to its stop, while `<dataDir>/cpu-profiles` exists at start. The live
 * service takes no debugger (AGENTS.md) and perf needs root on us-metal02 (perf_event_paranoid 4), so the service profiles itself through an
 * in-process inspector session. Profiler.stop held the loop 0.7 to 1.3 s per 20 s window in 84bd688e's stall profiler (reverted in 66797edc),
 * so this one stops only once, in the service's stop, when no request waits on the loop. Each sample keeps its time, so a stall's stack reads
 * from the profile's samples and timeDeltas.
 */
export const CPU_PROFILE_DIR = "cpu-profiles";
/** 1 ms is V8's default sampling interval; a 1 s stall then holds about 1,000 samples. */
const SAMPLE_US = 1000;

export interface RunProfile { stop(): Promise<string | null> }

const isDir = (path: string): Promise<boolean> => stat(path).then(found => found.isDirectory(), () => false);
const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

export async function startRunProfile(input: { dataDir: string; log: (line: string) => void; now?: () => Date }): Promise<RunProfile> {
  const dir = join(input.dataDir, CPU_PROFILE_DIR);
  const now = input.now ?? (() => new Date());
  if (!(await isDir(dir))) return { stop: async () => null };
  const began = now();
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
  await session.post("Profiler.start");
  input.log(`cpu profile: on, the run's profile goes to ${dir} at stop`);
  let done: Promise<string | null> | null = null;
  return { stop: () => done ??= (async () => {
    const at = Date.now();
    const { profile } = await session.post("Profiler.stop");
    session.disconnect();
    const file = join(dir, `${stamp(began)}--${stamp(now())}-pid${process.pid}.cpuprofile`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(profile));
    input.log(`cpu profile: ${file} in ${Date.now() - at} ms`);
    return file;
  })() };
}
