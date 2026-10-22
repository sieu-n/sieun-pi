// Guards d7's loop stalls on us-metal02 on 10-20: each spawn from the chat service's multi-GB process held its event loop 39 ms at the median,
// and a pass that started several held it up to 0.44 s (the live chat's CPU profile from 04:36Z to 05:47Z).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { hostExecFile, type HostExecError, stopSpawnHost } from "../src/spawn-host.ts";

type Result = { error: HostExecError | null; stdout: string; stderr: string };
const viaHost = (file: string, args: string[], options: Parameters<typeof hostExecFile>[2] = {}, input?: string): Promise<Result> => new Promise(resolve => {
  const child = hostExecFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  if (input !== undefined) child.stdin.end(input);
});
const direct = (file: string, args: string[], options: Parameters<typeof hostExecFile>[2] = {}): Promise<Result> => new Promise(resolve => {
  execFile(file, args, options, (error, stdout, stderr) => resolve({ error: error as HostExecError | null, stdout: String(stdout), stderr: String(stderr) }));
});

test("the spawn host answers as execFile does: output, exit code, a timeout's kill, a missing file and stdin input", async t => {
  t.after(stopSpawnHost);
  assert.deepEqual(await viaHost("sh", ["-c", "echo out; echo err >&2"]), { error: null, stdout: "out\n", stderr: "err\n" });
  for (const [args, options] of [[["-c", "echo a; exit 3"], {}], [["-c", "sleep 5"], { timeout: 200 }]] as const) {
    const [host, own] = [await viaHost("sh", [...args], options), await direct("sh", [...args], options)];
    assert.deepEqual({ code: host.error?.code, signal: host.error?.signal, killed: host.error?.killed, stdout: host.stdout },
      { code: own.error?.code, signal: own.error?.signal, killed: own.error?.killed, stdout: own.stdout });
  }
  assert.equal((await viaHost("/no/such/command", [])).error?.code, "ENOENT");
  assert.equal((await viaHost("cat", [], {}, "piped in")).stdout, "piped in");
  assert.equal((await viaHost("sh", ["-c", "echo $SPAWN_HOST_PROBE; pwd"], { env: { ...process.env, SPAWN_HOST_PROBE: "set" }, cwd: "/tmp" })).stdout, "set\n/tmp\n");
});

test("commands run through the spawn host fork from one small helper process, never from this process", async t => {
  t.after(stopSpawnHost);
  const parent = (exec: typeof direct) => exec("sh", ["-c", "echo $PPID"]).then(result => result.stdout.trim());
  assert.equal(await parent(direct), String(process.pid), "the probe names the process that forked it");
  const parents = new Set(await Promise.all(Array.from({ length: 8 }, () => parent(viaHost))));
  assert.equal(parents.size, 1, `one helper forks every command: ${[...parents].join(", ")}`);
  assert.notEqual([...parents][0], String(process.pid));
});
