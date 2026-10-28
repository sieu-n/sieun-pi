import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Owner rule c193, 2026-10-28: "Copying the repo to do the test: THIS MUST BE BANNED". A trial reads the repo's own checkout, so setup refuses
 * a sandbox inside any other tree of auto-sns-agent or sieun-pi. A tree is one by its root package.json name, and for auto-sns-agent also a
 * turbo.json beside it, as the auto-sns-agent repo guard's `repoCopyRoot` reads it.
 */
const REPOS: Record<string, { marker?: string; checkouts: (home: string) => string[] }> = {
  "auto-sns-agent": { marker: "turbo.json", checkouts: home => [join(home, "Documents/Github/auto-sns-agent")] },
  "sieun-pi": { checkouts: home => [join(home, "src/sieun-pi"), join(home, "Documents/Github/sieun-pi")] },
};

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const nameOf = (file: string): string | undefined => { try { return (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name as string | undefined; } catch { return undefined; } };

/** The root of the auto-sns-agent or sieun-pi copy that holds `dir`, or null when `dir` sits in no such tree or in the repo's checkout. */
export function repoCopyOf(dir: string, home = homedir()): string | null {
  for (let at = real(dir); ; at = dirname(at)) {
    const name = nameOf(join(at, "package.json"));
    const repo = name === undefined ? undefined : REPOS[name];
    if (repo && (!repo.marker || existsSync(join(at, repo.marker)))) return repo.checkouts(home).map(real).includes(at) ? null : at;
    if (dirname(at) === at) return null;
  }
}
