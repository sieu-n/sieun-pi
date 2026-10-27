// On 10-20 d2's precheck cwd named the pruned release-b8c6bba after a job ran add.ts from the release path its duty brief gave it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { liveFolder } from "../src/chat-duty-job.ts";

test("a duty brief names a release folder through the current link, and any other folder as it is", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "duty-brief-live-")), "sieun-pi-chat");
  try {
    await mkdir(join(root, "release-a", "components", "user-history"), { recursive: true });
    assert.equal(liveFolder(join(root, "release-a", "components", "user-history")), join(root, "release-a", "components", "user-history"));
    await symlink("release-a", join(root, "current"));
    assert.equal(liveFolder(join(root, "release-a", "components", "user-history")), join(root, "current", "components", "user-history"));
    assert.equal(liveFolder("/home/u/src/sieun-pi/legacy/prime/user-history"), "/home/u/src/sieun-pi/legacy/prime/user-history");
  } finally { await rm(join(root, ".."), { recursive: true, force: true }); }
});


const run = promisify(execFile);
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const TSX = import.meta.resolve("tsx");
const STUB = `import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(new URL("../release.txt", import.meta.url), "utf8"));`;

async function release(root: string, id: string): Promise<string> {
  const dir = join(root, `release-${id}`, "components", "user-history");
  await cp(SRC, join(dir, "src"), { recursive: true });
  await symlink(MODULES, join(dir, "node_modules"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(dir, "scripts"));
  for (const script of ["board-apply.ts", "job-steer.ts"]) await writeFile(join(dir, "scripts", script), STUB);
  await writeFile(join(dir, "release.txt"), id);
  return dir;
}

test("a check-in and a duty brief written on one release run board-apply and job-steer after a later release pruned it", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "brief-after-release-")), "sieun-pi-chat");
  try {
    const a = await release(root, "a");
    await symlink("release-a", join(root, "current"));
    const chat = { id: "01a14210-4e7d-72c3-aa67-e3d476f4e728", name: "Fixture", board: join(root, "data", "boards", "chat.json") };
    const write = `const m = await import(${JSON.stringify(join(a, "src", "chat-duty-job.ts"))}); const chat = ${JSON.stringify(chat)};
      const duty = { name: "d", ownerWords: "w", goal: "g", metrics: [{ key: "ok", label: "ok", op: ">=", target: 1 }] };
      process.stdout.write(m.checkInJobBrief({ chat, job: "j", at: 0, prompt: "p" }) + m.dutyJobBrief({ duty, chat, job: "j", at: 0, measure: "m", findings: "f" }));`;
    const { stdout: briefs } = await run(process.execPath, ["--import", TSX, "--input-type=module", "-e", write], { cwd: a });

    await release(root, "b");
    await symlink("release-b", join(root, ".current-next"));
    await rename(join(root, ".current-next"), join(root, "current"));
    await rm(join(root, "release-a"), { recursive: true });

    const calls = [...briefs.matchAll(/cd (\S+) && node --import tsx (scripts\/(?:board-apply|job-steer)\.ts)/g)];
    assert.equal(calls.length, 4);
    for (const [, dir, script] of calls) {
      const { stdout } = await run("/bin/sh", ["-c", 'cd "$1" && exec "$0" --import "$2" "$3"', process.execPath, dir!, TSX, script!]);
      assert.equal(stdout, "b");
    }
  } finally { await rm(join(root, ".."), { recursive: true, force: true }); }
});
