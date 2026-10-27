/**
 * The most CPU the main thread spent between two turns of the event loop while `work` runs, in ms. CPU time of this thread
 * (process.threadCpuUsage) and not wall time, so a test under a loaded box or a parallel suite reads the code's own hold of the loop and not
 * the time the thread waited for a core.
 */
export async function longestLoopCpu(work: () => Promise<unknown>): Promise<number> {
  const cpu = (): number => { const used = process.threadCpuUsage(); return (used.user + used.system) / 1000; };
  let last = cpu();
  let longest = 0;
  let done = false;
  const turn = (): void => { const now = cpu(); longest = Math.max(longest, now - last); last = now; if (!done) setImmediate(turn); };
  setImmediate(turn);
  await work();
  done = true;
  return longest;
}

/** The main thread's CPU time `work` takes from its start to its end, in ms. */
export function threadCpu(work: () => void): number {
  const before = process.threadCpuUsage();
  work();
  const used = process.threadCpuUsage(before);
  return (used.user + used.system) / 1000;
}
