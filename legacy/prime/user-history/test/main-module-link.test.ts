// 10-28: after the layout move, kernels started before it ran src/cross-host-message.ts through the components/user-history link. tsx
// loads the module from its real path, so a main-module check against the raw argv path was false, the helper printed nothing and exited 0,
// and every cross-host agent_message.send failed with an empty "cross-host message helper failed:".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const APP = join(import.meta.dirname, "..");

test("a helper run through a linked path still runs its CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "main-module-link-"));
  const linked = join(dir, "user-history");
  symlinkSync(APP, linked);
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ version: 1, hosts: [] }));
  const run = spawnSync(process.execPath, ["--import", "tsx", join(linked, "src/cross-host-message.ts"), "siblings"], {
    cwd: APP, input: JSON.stringify({ dataDir: join(dir, "no-chat"), session: "x" }), encoding: "utf8",
    env: { ...process.env, SIEUN_PI_HOSTS: join(dir, "hosts.json"), HOME: dir },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok("error" in JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null"), run.stdout);
});

test("every main-module check compares against the real path of argv[1]", () => {
  const files = (dir: string): string[] => readdirSync(join(APP, dir), { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.(ts|mts|mjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
  const raw = [...files("src"), ...files("scripts")].filter(file => readFileSync(file, "utf8").includes("pathToFileURL(process.argv[1]"));
  assert.deepEqual(raw, []);
});
