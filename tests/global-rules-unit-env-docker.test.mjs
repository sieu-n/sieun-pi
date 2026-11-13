import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// On 11-13 at 14:55Z the ClickHouse rig fh-ch-test still ran on us-metal02, 3 days after the follower-history job 01a1c526 started it with
// `docker run -d --rm`, because a container's processes name no session and the d2 orphan reaper had no owner to read for it.
const shim = join(dirname(fileURLToPath(import.meta.url)), "../packages/sieun-rules/src/unit-env/docker");
const root = mkdtempSync(join(tmpdir(), "unit-env-docker-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "real-bin");
mkdirSync(bin);
writeFileSync(join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
const SESSION = "01a1c526-6baa-71bd-bef7-cb61aa719c82@us-metal02";

const run = (args, env = { LC_PRIME_SESSION: SESSION }) => {
  const ran = spawnSync("sh", [shim, ...args], { encoding: "utf8", env: { PATH: `${dirname(shim)}:${bin}:/usr/bin:/bin`, ...env } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim().split("\n");
};

test("docker run and create get the owner label right after the run or create word", () => {
  const label = ["--label", `ai.virev.owner=${SESSION}`];
  assert.deepEqual(run(["run", "-d", "--rm", "--name", "fh-ch-test", "clickhouse/clickhouse-server:26.3.9.8"]),
    ["run", ...label, "-d", "--rm", "--name", "fh-ch-test", "clickhouse/clickhouse-server:26.3.9.8"]);
  assert.deepEqual(run(["--context", "default", "container", "create", "img", "sh", "-c", "echo run"]),
    ["--context", "default", "container", "create", ...label, "img", "sh", "-c", "echo run"]);
});

test("a kernel without LC_PRIME_SESSION labels with its RLM_SESSION_DIR", () => {
  const dir = "/home/sieun/.prime/agent/session-artifacts/x/sub-1";
  assert.deepEqual(run(["run", "img"], { RLM_SESSION_DIR: dir }), ["run", "--label", `ai.virev.owner=${dir}`, "img"]);
});

test("other commands, compose and a shell with no session pass through unchanged", () => {
  for (const args of [["ps", "-q"], ["compose", "run", "web"], ["container", "ls"], ["inspect", "run"], ["-H", "run", "ps"]]) assert.deepEqual(run(args), args);
  assert.deepEqual(run(["run", "img"], {}), ["run", "img"]);
});
