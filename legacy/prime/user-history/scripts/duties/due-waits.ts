import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WAIT_COMMIT } from "../../src/checkin-load.ts";
import { OPEN, parkedBy, walk } from "../../src/checkin-steps.ts";
import { firstClause } from "../../src/shared/chat-board.ts";
import { heldByTodo } from "../../src/shared/todo-hold.ts";
import type { ChatBoard } from "../../src/shared/types.ts";

/**
 * The open steps whose wait on a land or a promote already came true, which d9 counts as stuck. A wait reads as held on purpose, so a step
 * whose land shipped sat behind it: metal-management's p232 waited 6.5 days for "A prod promote carrying 6c413ea27; promote 22 (main
 * b1fb45b230, 11-02 17:35Z) did not include it", while promote 22 held it. A land on staging is a one-parent commit titled
 * "land: dev/sieun <sha>" with a `Land-From: dev/sieun <full sha>` trailer, and a promote fast-forwards main to a land, so a dev commit is no
 * ancestor of staging or main, only of a dev tip a land names. That is how the wiki's landed-claims check reads lands (apps/wiki/scripts/wiki-health.mjs).
 */

/** The branch a wait's first clause waits on: main for a promote or prod, staging for a land. */
export type WaitBranch = "main" | "staging";
/** A clause that names a land or a promote; "staging" or "prod" alone names a box ("staging factsKept end, ... on 6356eb72db"), not a land. */
const LAND_OR_PROMOTE = /\b(?:lands?|landed|landing|promote[sd]?|promoting)\b/i;
const TO_MAIN = /\b(?:promote[sd]?|promoting|prod(?:uction)?|main)\b/i;
/** A deploy or redeploy run comes after the land it names ("staging-deploy run 42547308421 of land 716593c570"), so the land says nothing of it. */
const DEPLOY = /\b(?:re)?deploy/i;

/** The commits a wait's first clause names, with the branch that carries them once the wait is over; undefined for any other wait. */
export function waitOnCommits(waitFor: string | undefined): { branch: WaitBranch; commits: string[] } | undefined {
  const head = firstClause(waitFor ?? "");
  const commits = [...new Set(head.toLowerCase().match(WAIT_COMMIT) ?? [])];
  if (!commits.length || DEPLOY.test(head) || !LAND_OR_PROMOTE.test(head)) return undefined;
  return { branch: TO_MAIN.test(head) ? "main" : "staging", commits };
}

/** A land commit on a branch's first-parent history, with the dev tips it names. */
export interface Land { commit: string; at: string; tips: string[] }

/**
 * The lands in `git log --first-parent --format=%H%x1f%cI%x1f%s%x1f%(trailers:key=Land-From,valueonly,separator=%x20)%x1e`, oldest first: each
 * commit titled "land: <branch> <sha>[, <branch> <sha>]" or "land 52: <sha> tip ...", with the shas of its title and its Land-From trailers.
 */
export function parseLands(log: string): Land[] {
  const lands: Land[] = [];
  for (const row of log.split("\x1e")) {
    const [commit, at, subject, trailers] = row.replace(/^\n+/, "").split("\x1f");
    const title = /^land(?:\s+\d+[a-z]?)?:\s*([^(]*)/i.exec(subject ?? "")?.[1];
    if (!commit || !at || title === undefined) continue;
    const tips = [...new Set([...(trailers ?? "").match(/\b[0-9a-f]{40}\b/g) ?? [], ...title.toLowerCase().match(WAIT_COMMIT) ?? []])];
    if (tips.length) lands.push({ commit, at, tips });
  }
  return lands.reverse();
}

/** Where a branch carries a commit: the first land whose named tips hold it, or none when the branch's own history holds it. */
export interface Carry { branch: WaitBranch; land?: Land }
const GIT_ENV = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined };
const git = promisify(execFile);
const gitOut = (repo: string, args: readonly string[]): Promise<string | undefined> =>
  git("git", ["-C", repo, ...args], { env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 }).then(out => out.stdout, () => undefined);

/** The full name of each rev `repo` has as a commit, from one `git cat-file --batch-check`; a rev it lacks is left out. */
function commitNames(repo: string, revs: readonly string[]): Promise<Map<string, string>> {
  if (!revs.length) return Promise.resolve(new Map());
  return new Promise(resolve => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { env: GIT_ENV });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.on("error", () => resolve(new Map()));
    child.on("close", () => resolve(new Map(out.split("\n").slice(0, revs.length).flatMap((row, i) => {
      const [name, type] = row.split(" ");
      return type === "commit" && name ? [[revs[i]!, name] as const] : [];
    }))));
    child.stdin.end(revs.map(rev => `${rev}^{commit}`).join("\n") + "\n");
  });
}

/**
 * A reader of where `repo`'s `ref(branch)` carries a commit, each answer kept for the run. A commit is carried when it is in the branch's
 * history or an ancestor of a tip that a land up to the newest names, read as `git rev-list --count <sha> --not <tips>` being 0. The tips
 * only grow from one land to the next, so a bisection finds the first land that carried it.
 */
export function landCarry(repo: string, ref: (branch: WaitBranch) => string = branch => `origin/${branch}`): (commit: string, branch: WaitBranch) => Promise<Carry | undefined> {
  const lands = new Map<WaitBranch, Promise<Land[]>>();
  const answers = new Map<string, Promise<Carry | undefined>>();
  const read = (branch: WaitBranch): Promise<Land[]> => {
    let found = lands.get(branch);
    if (!found) {
      found = gitOut(repo, ["log", "--first-parent", "--format=%H%x1f%cI%x1f%s%x1f%(trailers:key=Land-From,valueonly,separator=%x20)%x1e", ref(branch)]).then(async log => {
        const parsed = parseLands(log ?? "");
        const names = await commitNames(repo, [...new Set(parsed.flatMap(land => land.tips))]);
        return parsed.flatMap(land => { const tips = land.tips.flatMap(tip => names.get(tip) ?? []); return tips.length ? [{ ...land, tips }] : []; });
      });
      lands.set(branch, found);
    }
    return found;
  };
  const answer = async (commit: string, branch: WaitBranch): Promise<Carry | undefined> => {
    const sha = (await gitOut(repo, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]))?.trim();
    if (!sha) return undefined;
    if (await gitOut(repo, ["merge-base", "--is-ancestor", sha, ref(branch)]) !== undefined) return { branch };
    const all = await read(branch);
    const upTo = (i: number): string[] => [...new Set(all.slice(0, i + 1).flatMap(land => land.tips))];
    const carriedBy = async (i: number): Promise<boolean> => (await gitOut(repo, ["rev-list", "--count", sha, "--not", ...upTo(i)]))?.trim() === "0";
    if (!all.length || !await carriedBy(all.length - 1)) return undefined;
    let [lo, hi] = [0, all.length - 1];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await carriedBy(mid)) hi = mid; else lo = mid + 1;
    }
    return { branch, land: all[lo]! };
  };
  return (commit, branch) => {
    const key = `${commit}\0${branch}`;
    let found = answers.get(key);
    if (!found) answers.set(key, found = answer(commit, branch));
    return found;
  };
}

/** An open step whose wait on a land or promote came true: the branch carries every commit the wait names, by `land` when a land carried the last one. */
export interface DueWait { chat: string; id: string; text: string; waitFor: string; branch: WaitBranch; commits: string[]; land?: Land }

/**
 * The open leaf steps of each board whose wait on a land or promote (`waitOnCommits`) came true. A step an open For you todo holds
 * (`heldByTodo`, or a todo's step field) or an owner correction parks (`parkedBy`) waits on the owner, not the land, and is left out.
 * A commit in staging's own history is a land commit, which exists only once it landed, so a staging wait that names one names the build its
 * work runs on and waits on no land: product guy's p170 on 11-09 waited for "16 re-walkers ... recheck every first-walk defect on staging
 * 10a9ac9 (land 10a9ac9deb holds all 24 fixes)". The wait's time cannot tell this apart, since metal-management's p232 wrote its promote wait
 * at 11-02 18:19Z, after promote 22 at 17:35Z had carried 6c413ea27, and that wait was still the one to clear.
 */
export async function dueWaits(boards: ReadonlyMap<string, ChatBoard | null | undefined>, carry: (commit: string, branch: WaitBranch) => Promise<Carry | undefined>): Promise<DueWait[]> {
  const out: DueWait[] = [];
  for (const [chat, board] of boards) {
    const todos = board?.todos ?? [];
    const asked = new Set(todos.filter(todo => !todo.done && todo.step).map(todo => todo.step));
    const steps: { id: string; text: string; waitFor: string; on: NonNullable<ReturnType<typeof waitOnCommits>> }[] = [];
    walk(board?.plan ?? [], item => {
      const on = waitOnCommits(item.waitFor);
      if (!on || !OPEN.has(item.status) || item.children.some(child => OPEN.has(child.status))) return;
      if (asked.has(item.id) || heldByTodo(item, todos) || parkedBy(item) !== undefined) return;
      steps.push({ id: item.id, text: item.text, waitFor: item.waitFor!, on });
    });
    for (const step of steps) {
      const named = await Promise.all(step.on.commits.map(async commit => ({ commit, found: await carry(commit, step.on.branch) })));
      const waited = step.on.branch === "staging" ? named.filter(({ found }) => !found || found.land) : named;
      if (!waited.length || waited.some(({ found }) => !found)) continue;
      const lands = waited.flatMap(({ found }) => found!.land ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      out.push({ chat, id: step.id, text: step.text, waitFor: step.waitFor, branch: step.on.branch, commits: waited.map(({ commit }) => commit),
        ...lands.length ? { land: lands.at(-1)! } : {} });
    }
  }
  return out;
}

/** Why a due wait is over, in the push and the detail file: "main carries 6c413ea27 since land 91dbcb0907 (2026-10-30)". */
export const dueWords = (due: Pick<DueWait, "branch" | "commits" | "land">): string =>
  `${due.branch} carries ${due.commits.join(", ")}${due.land ? ` since land ${due.land.commit.slice(0, 10)} (${new Date(due.land.at).toISOString().slice(0, 10)})` : ""}`;
