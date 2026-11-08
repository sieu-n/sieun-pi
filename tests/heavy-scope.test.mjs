import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// heavy (deploy/linux/memory/heavy) kills what CMD leaves in its scope: on 11-08 33 run-p scopes held 36 Prime test daemons from 11-04.
const heavy = join(dirname(fileURLToPath(import.meta.url)), "../deploy/linux/memory/heavy");
const systemd = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout?.trim();
const skip = !existsSync("/run/systemd/system") || !systemd || systemd === "offline" ? "needs a systemd user manager" : false;

// A killed leftover can stay a zombie until systemd reaps it, so a zombie counts as gone.
const alive = (pid) => {
  try { return !/^\d+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};

test("heavy keeps CMD's exit code and stdin and kills the processes CMD left behind", { skip }, () => {
  const run = spawnSync(heavy, ["1G", "--", "sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!; read line; echo \"$line\"; exit 7"], { input: "hello\n", encoding: "utf8" });
  assert.equal(run.status, 7);
  const [pid, line] = run.stdout.trim().split("\n");
  assert.equal(line, "hello");
  assert.equal(alive(Number(pid)), false);
});
