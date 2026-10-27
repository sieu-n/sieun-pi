import { readdir, readFile } from "node:fs/promises";

/**
 * Read-only evidence of what a Linux process holds, for a worker d7 flags as oversized: its status counters, smaps_rollup, its largest mappings
 * and its threads. Worker 132424 grew from 3 to 38 GB in three minutes at 07:49Z on 10-18 and was stopped at 08:16Z with only top and status
 * kept, which could not tell the JS heap from native or WASM memory. No inspector, signal or heap dump touches the process.
 */
export interface Mapping { range: string; perms: string; name: string; rssKb: number }

/** Each mapping in a /proc/<pid>/smaps text with its resident kB, largest first, at most `limit`. */
export function largestMappings(smaps: string, limit = 12): Mapping[] {
  const found: Mapping[] = [];
  let current: Mapping | null = null;
  for (const line of smaps.split("\n")) {
    const head = /^([0-9a-f]+-[0-9a-f]+) (\S+) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (head) { current = { range: head[1]!, perms: head[2]!, name: head[3]!.trim() || "[anon]", rssKb: 0 }; found.push(current); continue; }
    const rss = /^Rss:\s+(\d+) kB/.exec(line);
    if (rss && current) current.rssKb = Number(rss[1]);
  }
  return found.sort((a, b) => b.rssKb - a.rssKb).slice(0, limit);
}

/** A thread's name, state and CPU seconds from its /proc stat line. */
export function threadLine(stat: string, ticks = 100): string | null {
  const open = stat.indexOf("("), close = stat.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const rest = stat.slice(close + 2).split(" ");
  const cpu = (Number(rest[11]) + Number(rest[12])) / ticks;
  return `${stat.slice(0, open).trim()} ${stat.slice(open + 1, close)} ${rest[0]} ${cpu.toFixed(1)} s`;
}

/** The evidence text for `pid`, or null when the process is gone or this box has no /proc. */
export async function processEvidence(pid: number, proc = "/proc"): Promise<string | null> {
  const read = (name: string) => readFile(`${proc}/${pid}/${name}`, "utf8");
  let status: string;
  try { status = await read("status"); } catch { return null; }
  const rollup = await read("smaps_rollup").catch(() => "");
  const mappings = largestMappings(await read("smaps").catch(() => ""));
  const tasks = await readdir(`${proc}/${pid}/task`).catch(() => [] as string[]);
  const threads = (await Promise.all(tasks.map(task => readFile(`${proc}/${pid}/task/${task}/stat`, "utf8").then(threadLine, () => null))))
    .filter((line): line is string => line !== null);
  const counters = status.split("\n").filter(line => /^(Name|State|VmPeak|VmHWM|VmRSS|RssAnon|RssFile|VmData|VmSwap|Threads):/.test(line));
  return [`# /proc/${pid} at ${new Date().toISOString()}`, ...counters, "", "## smaps_rollup", rollup.trim(), "",
    "## largest mappings (kB resident)", ...mappings.map(map => `${map.rssKb} ${map.range} ${map.perms} ${map.name}`), "",
    "## threads (tid name state cpu)", ...threads].join("\n") + "\n";
}
