import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";

/**
 * Profiles the main thread of one service start on request, the in-process form of `node --cpu-prof` for a process that launchd starts.
 * `<data dir>/start-profile.request` holds the seconds to record and is used once. The profile goes to
 * `<data dir>/profiles/start-<time>.cpuprofile`, which Chrome DevTools and `scripts/profile-top.mjs` read.
 * Returns null when nothing was asked, else `done`, which resolves to the written path.
 */
export async function profileStart(argv: string[]): Promise<{ done: Promise<string> } | null> {
  const flag = argv.indexOf("--data-dir");
  const dir = flag === -1 ? undefined : argv[flag + 1];
  if (!dir) return null;
  const request = join(dir, "start-profile.request");
  let seconds: number;
  try { seconds = Number(readFileSync(request, "utf8").trim()); } catch { return null; }
  rmSync(request, { force: true });
  if (!(seconds > 0)) return null;
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  const path = join(dir, "profiles", `start-${new Date().toISOString().replaceAll(":", "-")}.cpuprofile`);
  const done = new Promise(resolve => setTimeout(resolve, seconds * 1000).unref()).then(async () => {
    const { profile } = await session.post("Profiler.stop");
    session.disconnect();
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(path, JSON.stringify(profile));
    return path;
  });
  return { done };
}
