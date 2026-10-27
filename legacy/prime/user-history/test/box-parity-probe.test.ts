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
  git("init", "-q", "-b", "dev/sieun");
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

test("the box tip probe sends the hash of every commit dev/sieun holds, past its last 2000", () => {
  const home = mkdtempSync(join(tmpdir(), "box-parity-ids-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "dev/sieun"]);
  const stream = Array.from({ length: 2002 }, (_, n) =>
    `commit refs/heads/dev/sieun\nmark :${n + 1}\ncommitter t <t@t> ${1_700_000_000 + n} +0000\ndata 2\nc${n % 10}\n${n ? `from :${n}\n` : ""}`).join("\n");
  execFileSync("git", ["-C", repo, "fast-import", "--quiet"], { input: stream });
  const oldest = execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "dev/sieun"], { encoding: "utf8" }).trim();
  const arg = Buffer.from(JSON.stringify({ host: "box", rows: [{ id: "tip", tool: "checkout tip", probes: [{ tip: true }] }], known: {} })).toString("base64");
  const tip = (JSON.parse(execFileSync("python3", [PROBE, arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as { values: { tip: string[] } }).values.tip[0]!;
  const ids = (JSON.parse(tip.slice(8)) as { ids: string[] }).ids;
  assert.equal(ids.length, 2002);
  assert.ok(ids.includes(oldest.slice(0, 10)), "a commit 2001 back is on the box by hash");
});

test("the Playwright browsers row skips the __dirlock folder playwright install holds, so a Mac install in progress asks nothing of the box", async () => {
  const { shortfall } = await import("../scripts/duties/box-parity.ts");
  const row = (JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/box-parity.rows.json"), "utf8")) as { id: string }[])
    .find(entry => entry.id === "playwright-browsers")!;
  const read = (host: "mac" | "box", folder: string, names: string[]) => {
    const home = mkdtempSync(join(tmpdir(), "box-parity-pw-"));
    for (const name of names) mkdirSync(join(home, folder, name), { recursive: true });
    const arg = Buffer.from(JSON.stringify({ host, rows: [row], known: {} })).toString("base64");
    return (JSON.parse(execFileSync("python3", [PROBE, arg], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as { values: Record<string, string[]> }).values["playwright-browsers"]![0]!;
  };
  const mac = read("mac", "Library/Caches/ms-playwright", ["__dirlock", ".links", "chromium-1243", "ffmpeg-1011"]);
  assert.equal(mac, 'set:["chromium-1243", "ffmpeg-1011"]');
  assert.equal(shortfall(mac, read("box", ".cache/ms-playwright", [".links", "chromium-1243", "ffmpeg-1011"])), null);
  assert.match(shortfall(mac, read("box", ".cache/ms-playwright", ["__dirlock", "chromium-1243"]))!, /box lacks 1 of the Mac's 2: ffmpeg-1011/);
});
