/**
 * Names the code that ran in an event-loop stall nothing tracked. On 11-23 from 19:15Z to 20:23Z, 24 of 34 stall lines said "no tracked
 * work" with 500 to 1,800 ms on CPU (~/work/pi-host-stalls/l-untracked/report.md).
 *
 * pi-host runs V8's sampling profiler on its own process through an in-process inspector session (no port, no outside debugger) and
 * starts a new profile every minute, so a profile holds at most a minute of samples. When `LoopStalls` sees a stall, `take` starts the
 * next profile, ends the running one at once and sums the samples that fall inside the gap: the functions with the most self time, and the call
 * stack under the top one. It writes those samples as a `.cpuprofile` file DevTools opens, and deletes files older than 2 days.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { console as inspectorConsole, Session, type Profiler } from "node:inspector";
import { findSourceMap, type SourceMapping } from "node:module";
import { join } from "node:path";

export interface StallProfileOptions {
  /** Where each stall's `.cpuprofile` goes; unset writes no file. */
  dir?: string;
  /**
   * Microseconds between samples, default 20 ms: 25 samples in a 500 ms stall. An idle process with pi-host's modules loaded used 35 to
   * 42 ms of CPU a minute with no profiler, 173 with 50 ms, 363 with 20 ms and 1,045 with 10 ms (~/work/pi-host-stalls/l-untracked/idle-cost.txt).
   */
  intervalUs?: number;
  /** A new profile starts this often, so samples never pile up for longer. */
  restartMs?: number;
}

/** What a stall's samples say: a line part for host.log, and the file they went to. */
export interface StallSlice {
  readonly text: string;
  readonly file: string | undefined;
}

const KEEP_MS = 2 * 86_400_000;
const SELF_FRAMES = 5;
const STACK_FRAMES = 12;
/** V8's own entries: no JS ran in them, or the sampler found the loop idle. */
const IDLE = new Set(["(root)", "(idle)"]);

/** A file URL or path cut to where it says the most: after the last `node_modules/` or `packages/`, so a release folder's prefix drops. */
function place(url: string): string {
  const cut = Math.max(...["/node_modules/", "/packages/"].map(dir => { const at = url.lastIndexOf(dir); return at < 0 ? -1 : at + dir.length; }));
  return cut > 0 ? url.slice(cut) : url.replace(/^file:\/\//, "");
}

/** `findEntry` answers `{}` for a place its map does not cover. */
const isMapping = (entry: SourceMapping | object): entry is SourceMapping => "originalSource" in entry && "originalLine" in entry;

/** tsx compiles each .ts file to one long line, so a frame's line comes from the file's source map, which tsx registers with Node. */
function frameOf(node: Profiler.ProfileNode): string {
  const { functionName, url, lineNumber, columnNumber } = node.callFrame;
  const name = functionName || "(anonymous)";
  if (!url) return name;
  const entry = url.startsWith("file:") ? findSourceMap(url)?.findEntry(lineNumber, columnNumber) : undefined;
  return entry && isMapping(entry) ? `${name} ${place(entry.originalSource)}:${entry.originalLine + 1}` : `${name} ${place(url)}:${lineNumber + 1}`;
}

const ms = (n: number): number => Math.round(n);

export class StallProfiler {
  private readonly session = new Session();
  /** `process.hrtime` minus `performance.now()`, in ms: profile timestamps are hrtime microseconds. */
  private readonly offsetMs = Number(process.hrtime.bigint()) / 1e6 - performance.now();
  private readonly timer: NodeJS.Timeout;
  /** The running profile's title, or undefined once stopped. */
  private current: string | undefined;
  private count = 0;
  private readonly id = randomUUID().slice(0, 8);
  /** The title `roll` is ending, and the profile the session hands over for it inside the `profileEnd` call. */
  private ending: string | undefined;
  private finished: Profiler.Profile | undefined;

  constructor(private readonly options: StallProfileOptions = {}) {
    this.session.connect();
    // console.profile reaches every inspector session in the process, so a session hears of another profiler's profiles too.
    this.session.on("Profiler.consoleProfileFinished", message => { if (message.params.title === this.ending) this.finished = message.params.profile; });
    this.session.post("Profiler.enable");
    this.session.post("Profiler.setSamplingInterval", { interval: options.intervalUs ?? 20_000 });
    this.current = this.begin();
    this.timer = setInterval(() => this.roll(), options.restartMs ?? 60_000);
    this.timer.unref();
  }

  /**
   * Starts a profile next to the running one. Only the first start is slow: V8 then logs every compiled function, 110 to 170 ms on a
   * copy rig, while a start beside a running profile took 0.1 to 0.3 ms (~/work/pi-host-stalls/l-untracked/report.md). So the profiler
   * never stops between profiles: each new one starts before the old one ends.
   */
  private begin(): string {
    const title = `pi-host stall profile ${this.id} ${++this.count}`;
    inspectorConsole.profile(title);
    return title;
  }

  /** Starts the next profile and ends the running one, whose samples it returns. */
  private roll(): Profiler.Profile | undefined {
    const old = this.current;
    if (old === undefined) return undefined;
    this.current = this.begin();
    this.ending = old;
    this.finished = undefined;
    inspectorConsole.profileEnd(old);
    this.ending = undefined;
    return this.finished;
  }

  /** Ends the running profile, starts the next and sums its samples from `from` to `to` (`performance.now()` ms). */
  take(from: number, to: number, label: string): StallSlice | undefined {
    const profile = this.roll();
    if (!profile?.samples || !profile.timeDeltas) return undefined;
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parent = new Map<number, number>();
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
    const frames = new Map<number, string>();
    const frame = (node: Profiler.ProfileNode): string => frames.get(node.id) ?? frames.set(node.id, frameOf(node)).get(node.id)!;
    const self = new Map<string, number>();
    const leaves = new Map<number, number>();
    const kept: { node: number; at: number }[] = [];
    let at = profile.startTime / 1000 - this.offsetMs;
    for (let i = 0; i < profile.samples.length; i++) {
      const before = at;
      at += profile.timeDeltas[i]! / 1000;
      const inside = Math.min(at, to) - Math.max(before, from);
      if (inside <= 0) continue;
      const id = profile.samples[i]!;
      const node = nodes.get(id);
      if (!node) continue;
      kept.push({ node: id, at });
      if (IDLE.has(node.callFrame.functionName)) continue;
      self.set(frame(node), (self.get(frame(node)) ?? 0) + inside);
      leaves.set(id, (leaves.get(id) ?? 0) + inside);
    }
    if (!self.size) return undefined;
    const top = [...self].sort((a, b) => b[1] - a[1]);
    const parts = [`profile self: ${top.slice(0, SELF_FRAMES).map(([frame, time]) => `${frame} ${ms(time)} ms`).join(", ")}`];
    const leaf = [...leaves].filter(([id]) => frames.get(id) === top[0]![0]).sort((a, b) => b[1] - a[1])[0]?.[0];
    const stack: string[] = [];
    for (let id: number | undefined = leaf; id !== undefined && stack.length < STACK_FRAMES;) {
      const node = nodes.get(id)!;
      if (!IDLE.has(node.callFrame.functionName) && !node.callFrame.url.startsWith("node:")) stack.push(frame(node));
      id = parent.get(id);
    }
    if (stack.length > 1) parts.push(`its stack: ${stack.join(" < ")}`);
    const file = this.write(profile, kept, label);
    if (file) parts.push(`profile file ${file}`);
    return { text: parts.join(" | "), file };
  }

  /** Writes the stall's samples as a `.cpuprofile`, and deletes this folder's files older than 2 days. */
  private write(profile: Profiler.Profile, kept: readonly { node: number; at: number }[], label: string): string | undefined {
    const dir = this.options.dir;
    if (!dir || !kept.length) return undefined;
    try {
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name.endsWith(".cpuprofile") && now - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
      }
      const startTime = Math.round((kept[0]!.at + this.offsetMs) * 1000);
      const times = kept.map(sample => Math.round((sample.at + this.offsetMs) * 1000));
      const slice: Profiler.Profile = {
        nodes: profile.nodes,
        startTime,
        endTime: times[times.length - 1]!,
        samples: kept.map(sample => sample.node),
        timeDeltas: times.map((time, i) => time - (i ? times[i - 1]! : startTime)),
      };
      const file = join(dir, `${label}.cpuprofile`);
      writeFileSync(file, JSON.stringify(slice));
      return file;
    } catch {
      return undefined;
    }
  }

  /** Ends the running profile and closes the session; a second call does nothing, since a closed session throws ERR_INSPECTOR_NOT_CONNECTED. */
  stop(): void {
    if (this.current === undefined) return;
    clearInterval(this.timer);
    inspectorConsole.profileEnd(this.current);
    this.current = undefined;
    this.session.post("Profiler.disable");
    this.session.disconnect();
  }
}
