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

// 10-28 at 23:37Z: inside Prime's compiled binary argv[1] is "/$bunfs/root/prime-agent", which realpathSync refuses, so the realpath check
// of 04b5dc19 threw at import and the whole user-history extension failed to load in every session started or reloaded after it.
test("a module the extension imports loads when argv[1] is no disk path", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "-e", [
    "process.argv[1] = '/$bunfs/root/prime-agent';",
    "const { isMain } = await import('./src/main-module.ts');",
    "for (const file of ['message-limit-check', 'cross-host-message', 'send-once', 'job-leftovers']) await import(`./src/${file}.ts`);",
    "console.log(JSON.stringify({ main: isMain(import.meta.url) }));",
  ].join("\n"), "--input-type=module"], { cwd: APP, encoding: "utf8", input: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null"), { main: false });
});

test("no module in src runs realpathSync on argv[1] outside isMain", () => {
  const raw = readdirSync(join(APP, "src"), { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.(ts|mts)$/.test(entry.name) && entry.name !== "main-module.ts")
    .map(entry => join(entry.parentPath, entry.name)).filter(file => readFileSync(file, "utf8").includes("realpathSync(process.argv[1]"));
  assert.deepEqual(raw, []);
});
