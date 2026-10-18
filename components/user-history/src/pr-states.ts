import { execFile } from "node:child_process";
import type { PrState } from "./checkin-done.ts";

/**
 * The GitHub state of PRs by number, for the check-in's done test (`looksDone`) and its progress test (`noProgress`). A folder's repo comes from
 * `gh repo view`, and one GraphQL call reads every asked PR. A merged or closed PR never changes, so it is kept; an open one, a folder with no
 * GitHub repo and a failed read are read again after OPEN_TTL_MS. A PR GitHub does not know is left out, and the check-in reads it as not merged.
 */
export const OPEN_TTL_MS = 10 * 60_000;
type Gh = (args: readonly string[], cwd: string) => Promise<string>;
const gh: Gh = (args, cwd) => new Promise((resolve, reject) =>
  execFile("gh", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(Object.assign(error, { stdout })) : resolve(stdout)));

type GraphPr = { state: "MERGED" | "OPEN" | "CLOSED"; mergedAt: string | null } | null;

export function prStates(run: Gh = gh, now: () => number = Date.now): (cwd: string, numbers: readonly string[]) => Promise<ReadonlyMap<string, PrState>> {
  const repos = new Map<string, { repo: string | null; at: number }>();
  const known = new Map<string, { pr: PrState; at: number }>();
  const repoOf = async (cwd: string): Promise<string | null> => {
    const kept = repos.get(cwd);
    if (kept && (kept.repo !== null || now() - kept.at < OPEN_TTL_MS)) return kept.repo;
    const repo = await run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd).then(out => out.trim() || null, () => null);
    repos.set(cwd, { repo, at: now() });
    return repo;
  };
  return async (cwd, numbers) => {
    const repo = await repoOf(cwd);
    const states = new Map<string, PrState>();
    if (!repo) return states;
    const fresh = (number: string) => { const kept = known.get(`${repo}#${number}`); return kept && (kept.pr.state !== "open" || now() - kept.at < OPEN_TTL_MS) ? kept.pr : undefined; };
    const ask = [...new Set(numbers)].filter(number => /^\d{1,7}$/.test(number) && !fresh(number));
    if (ask.length) {
      const [owner, name] = repo.split("/");
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${ask.map(number => `p${number}: pullRequest(number: ${number}) { state mergedAt }`).join(" ")} } }`;
      // GitHub answers a PR number it does not know with an error next to the others' data, and gh then exits 1 with that JSON on stdout.
      const out = await run(["api", "graphql", "-f", `query=${query}`], cwd).catch((error: { stdout?: string }) => error.stdout ?? "");
      let data: Record<string, GraphPr> = {};
      try { data = (JSON.parse(out) as { data?: { repository?: Record<string, GraphPr> } }).data?.repository ?? {}; } catch { data = {}; }
      for (const number of ask) {
        const pr = data[`p${number}`];
        if (!pr) continue;
        const merged = Date.parse(pr.mergedAt ?? "");
        known.set(`${repo}#${number}`, { pr: { state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed", ...(Number.isFinite(merged) ? { mergedAt: merged } : {}) }, at: now() });
      }
    }
    for (const number of numbers) { const pr = fresh(number); if (pr) states.set(number, pr); }
    return states;
  };
}
