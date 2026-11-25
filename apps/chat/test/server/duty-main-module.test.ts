/**
 * Duty prechecks run through the `current` symlink of an apps/chat release, and node resolves the main module to the release's real path,
 * so a main guard of `import.meta.url === \`file://${process.argv[1]}\`` never matched and the script exited 0 with no output (every agent's
 * Area review on 11-26). Each script now uses `isMain` (scripts/duties/main-module.ts); these tests run scripts through a symlink.
 * Run: cd apps/chat && node --test --test-force-exit --test-isolation=none test/server/duty-main-module.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const duties = fileURLToPath(new URL("../../scripts/duties/", import.meta.url));

test("isMain is true for a script started through a symlinked folder and false for an imported one", () => {
  const dir = mkdtempSync(join(tmpdir(), "is-main-"));
  const real = join(dir, "release");
  spawnSync("mkdir", ["-p", real]);
  writeFileSync(join(real, "probe.ts"), `import { isMain } from ${JSON.stringify(join(duties, "main-module.ts"))};\nconsole.log(isMain(import.meta.url) ? "main" : "imported");\n`);
  writeFileSync(join(real, "outer.ts"), `import "./probe.ts";\n`);
  symlinkSync(real, join(dir, "current"));
  const run = (script: string) => spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run(join(dir, "current", "probe.ts")).stdout.trim(), "main");
  assert.equal(run(join(real, "probe.ts")).stdout.trim(), "main");
  assert.equal(run(join(dir, "current", "outer.ts")).stdout.trim(), "imported");
});

test("area-review.ts run through a symlinked release writes OUTPUT_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "area-review-"));
  symlinkSync(duties, join(dir, "current"));
  const db = new DatabaseSync(join(dir, "chat.sqlite"));
  db.exec("CREATE TABLE agents_agents (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE posts (room TEXT, ord INTEGER, body TEXT)");
  db.prepare("INSERT INTO agents_agents VALUES (?, ?)").run("ag_probe", JSON.stringify({ id: "ag_probe", slug: "probe", name: "probe", room: "dm_probe" }));
  db.prepare("INSERT INTO posts VALUES (?, ?, ?)").run("dm_probe", 1, JSON.stringify({ id: "p1", author: "owner", text: "hi", at: Date.now() }));
  db.close();
  const output = join(dir, "out.json");
  const run = spawnSync(process.execPath, [join(dir, "current", "area-review.ts"), "--agent", "ag_probe", "--db", join(dir, "chat.sqlite"), "--agents-dir", join(dir, "agents"), "--ledger", join(dir, "none.json")], {
    encoding: "utf8", env: { ...process.env, OUTPUT_FILE: output },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(output), `no OUTPUT_FILE; stderr: ${run.stderr}`);
  const json = JSON.parse(readFileSync(output, "utf8")) as { metrics?: Record<string, number> };
  assert.equal(typeof json.metrics?.wiki_pages_touched_24h, "number");
});

test("no duty script keeps the old main guard", () => {
  for (const name of readdirSync(duties).filter(file => file.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(duties, name), "utf8"), /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/, name);
  }
});
