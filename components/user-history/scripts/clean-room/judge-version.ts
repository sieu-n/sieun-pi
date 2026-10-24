import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Verdict } from "./session-read.ts";

/**
 * The judge a clean-room process runs: the code tree it loaded, that tree's commit and a sha256 over its judge sources. A collect loads its
 * judge once and runs for hours while prime-sync fast-forwards the checkout each minute. On 10-24 carried-wait release-run-1's collect judged
 * with the dc76a413 judge it had loaded, after later fixes had landed, wrote release-run-1.pass.md and deleted its inputs, so nobody could judge
 * it again. So a process judges in its own code only while the current sources match the ones it loaded, and else a fresh process of the
 * current code judges.
 */
export interface JudgeVersion { root: string; commit: string; sha256: string }

const HERE = resolve(import.meta.dirname, "../..");
const SOURCES = ["scripts/clean-room", "src"];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
    }
  };
  for (const dir of SOURCES) walk(join(root, dir));
  return out.sort();
}

function commitOf(root: string): string {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  const release = join(root, "../..", "release.json");
  return existsSync(release) ? String((JSON.parse(readFileSync(release, "utf8")) as { sha?: string }).sha ?? "unknown") : "unknown";
}

/** The version of the judge in `root`, a components/user-history folder. */
export function judgeVersion(root: string): JudgeVersion {
  const hash = createHash("sha256");
  for (const file of sourceFiles(root)) hash.update(relative(root, file)).update("\0").update(readFileSync(file)).update("\0");
  return { root, commit: commitOf(root), sha256: hash.digest("hex") };
}

/** The judge this process loaded, read when it started. */
export const LOADED: JudgeVersion = judgeVersion(HERE);

/**
 * Where the current judge lives: a process started from a chat release folder reads the release `current` points at now, and one started from
 * the checkout reads the checkout.
 */
export function currentRoot(root: string = HERE): string {
  const releases = join(homedir(), ".local/share/sieun-pi-chat");
  const inside = relative(releases, root);
  if (!inside.startsWith("release-") || !existsSync(join(releases, "current"))) return root;
  return join(realpathSync(join(releases, "current")), ...inside.split(sep).slice(1));
}

export const short = (version: JudgeVersion): string => `${version.commit.slice(0, 12)} (judge sources sha256 ${version.sha256.slice(0, 12)})`;

export type Judged =
  | { verdict: Verdict; text: string; judge: JudgeVersion; loaded: JudgeVersion }
  | { verdict: "open"; text: string; unjudged: string; judge: JudgeVersion; loaded: JudgeVersion };

/** The `judge` command's stdout: one JSON line with the verdict and the text, last. */
export const judgedLine = (verdict: Verdict, text: string): string => `${JSON.stringify({ verdict, text })}\n`;

/**
 * Judges `run` with the current judge: in this process through `local` while its sources match the loaded ones, else through the current
 * code's `clean-room.ts judge` in a fresh process. A current judge that cannot run gives an open result that names why, never a verdict of
 * the loaded judge.
 */
export async function judgeCurrent(run: string, local: () => Promise<{ verdict: Verdict; text: string }>,
  loaded: JudgeVersion = LOADED, root: string = currentRoot(loaded.root)): Promise<Judged> {
  const judge = judgeVersion(root);
  if (judge.sha256 === loaded.sha256) return { ...await local(), judge, loaded };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", join(root, "scripts/clean-room/clean-room.ts"), "judge", "--run", run],
      { cwd: root, env: process.env });
    const result = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "") as { verdict: Verdict; text: string };
    return { verdict: result.verdict, text: result.text, judge, loaded };
  } catch (error) {
    const unjudged = (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join(" ");
    return { verdict: "open", unjudged, judge, loaded, text: `# Clean-room run ${basename(run)}: open\n\nThe judge this process loaded, ${short(loaded)}, ` +
      `is older than the current one, ${short(judge)} in ${root}, and the current one could not run: ${unjudged}\n` };
  }
}
