import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reapServeOnExit } from "./serve-reaper.mjs";

const reaperPath = fileURLToPath(new URL("./serve-reaper.mjs", import.meta.url));

/** A stand-in serve: a node process whose command line reads like `chat-service-cli.mjs serve --data-dir <directory>/chat`. */
function fakeServe(directory: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "chat-service-cli.mjs", "serve", "--data-dir", join(directory, "chat")],
    { detached: true, stdio: "ignore" });
  child.unref();
  assert(child.pid);
  return child.pid;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise(done => setTimeout(done, 100));
  return !alive(pid);
}

test("stop() kills a serve under the directory and leaves one outside it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-reaper-"));
  const other = await mkdtemp(join(tmpdir(), "serve-reaper-"));
  const inside = fakeServe(directory), outside = fakeServe(other);
  try {
    assert.deepEqual(await reapServeOnExit(directory).stop(), [inside]);
    assert(await gone(inside));
    assert(alive(outside), "a serve under another directory keeps running");
  } finally {
    for (const pid of [inside, outside]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    await Promise.all([directory, other].map(path => rm(path, { recursive: true, force: true })));
  }
});

for (const ending of ["SIGKILL", "SIGINT", "throw"] as const) {
  test(`a test process that ends by ${ending} takes its serve with it`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-reaper-"));
    const serve = fakeServe(directory);
    try {
      const script = `import { reapServeOnExit } from ${JSON.stringify(reaperPath)};
reapServeOnExit(${JSON.stringify(directory)}); process.stdout.write("watching\\n");
${ending === "throw" ? "setTimeout(() => { throw new Error('test failed'); }, 50);" : "setInterval(() => {}, 1000);"}`;
      const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
      await new Promise<void>(done => parent.stdout.once("data", () => done()));
      if (ending !== "throw") parent.kill(ending);
      await new Promise(done => parent.once("exit", done));
      assert(await gone(serve), `serve ${serve} outlived a parent that ended by ${ending}`);
    } finally {
      try { process.kill(serve, "SIGKILL"); } catch { /* gone */ }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
