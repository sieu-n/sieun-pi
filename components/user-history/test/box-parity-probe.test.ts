// Owner 10-18 (goal p1): the Box tools parity probe keeps each commit's patch-id by hash on the box, so its tip row stops timing out under load.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PROBE = join(import.meta.dirname, "../scripts/duties/box-parity-probe.py");

test("the box tip probe gives the same patch-ids from its cache, computes only new commits, and the Mac side writes no cache", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-cache-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const commit = (file: string, text: string) => { writeFileSync(join(repo, file), text); git("add", file); git("commit", "-q", "-m", file); return git("rev-parse", "HEAD"); };
  const tip = (host: "mac" | "box") => {
    const arg = Buffer.from(JSON.stringify({ host, rows: [{ id: "tip", tool: "checkout tip", probes: [{ tip: true }] }], known: {} })).toString("base64");
    return (JSON.parse(execFileSync("python3", [PROBE, arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as { values: { tip: string[] } }).values.tip[0]!;
  };
  const cacheFile = join(home, ".cache/box-parity/patch-ids.json");
  const cache = () => JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, string>;
  git("init", "-q", "-b", "sieun/dev");
  const first = commit("a.txt", "a");
  git("commit", "-q", "--allow-empty", "-m", "empty");
  const empty = git("rev-parse", "HEAD");

  tip("mac");
  assert.equal(existsSync(cacheFile), false);
  const cold = tip("box");
  assert.deepEqual(Object.keys(cache()).sort(), [first, empty].sort());
  assert.equal(cache()[empty], "");
  const uncached = JSON.parse(tip("mac").slice(8)) as [string, string][];
  assert.deepEqual((JSON.parse(cold.slice(8)) as { patches: string[] }).patches, uncached.map(([, patch]) => patch).filter(Boolean));
  assert.equal(tip("box"), cold);

  writeFileSync(cacheFile, JSON.stringify({ ...cache(), [first]: "cachedpatchid000aaaa" }));
  const second = commit("b.txt", "b");
  const warm = JSON.parse(tip("box").slice(8)) as { ids: string[]; patches: string[] };
  assert.deepEqual(warm.ids, [second, empty, first].map(sha => sha.slice(0, 10)));
  assert.ok(warm.patches.includes("cachedpatchid000"), "a cached commit is read, not recomputed");
  assert.match(cache()[second]!, /^[0-9a-f]{40}$/);
});
