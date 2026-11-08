import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// heavy (deploy/linux/memory/heavy) runs CMD as a transient service, so systemd kills what CMD leaves once it exits: on 11-08 33 run-p scopes
// still held 36 Prime test daemons from 11-04, and the shell that heavy ran in its scope could not clean up once it was SIGKILLed.
const heavy = process.env.HEAVY ?? join(dirname(fileURLToPath(import.meta.url)), "../deploy/linux/memory/heavy");
const systemd = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout?.trim();
const skip = !existsSync("/run/systemd/system") || !systemd || systemd === "offline" ? "needs a systemd user manager" : false;

// A killed leftover can stay a zombie until systemd reaps it, so a zombie counts as gone.
const alive = (pid) => {
  try { return !/^\d+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};
const gone = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(done => setTimeout(done, 100));
  const left = alive(pid);
  if (left) process.kill(pid, "SIGKILL");
  return !left;
};
// setsid takes the leftover out of the caller's process group and session, as the 11-04 test daemons were.
const leave = (file) => `setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${file}`;

test("heavy keeps CMD's exit code, stdin, stdout, stderr, cwd and env, and kills what CMD left once it exits", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "heavy-scope-"));
  try {
    const run = spawnSync(heavy, ["1G", "--", "sh", "-c", `${leave(join(dir, "left"))}; read line; echo "$line $(pwd -P) [$ODD] $VITEST_MAX_WORKERS"; echo err >&2; exit 7`],
      { cwd: dir, input: "hello\n", encoding: "utf8", env: { ...process.env, ODD: "a $HOME %n" } });
    assert.equal(run.status, 7);
    assert.equal(run.stdout, `hello ${realpathSync(dir)} [a $HOME %n] 1\n`);
    assert.equal(run.stderr, "err\n");
    assert.equal(await gone(Number(readFileSync(join(dir, "left"), "utf8"))), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a SIGKILL of heavy's whole process group still ends what CMD left, once CMD exits", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "heavy-scope-"));
  try {
    const child = spawn(heavy, ["1G", "--", "sh", "-c", `${leave(join(dir, "left"))}; sleep 3`], { detached: true, stdio: "ignore" });
    while (!existsSync(join(dir, "left")) || !readFileSync(join(dir, "left"), "utf8").trim()) await new Promise(done => setTimeout(done, 100));
    process.kill(-child.pid, "SIGKILL");
    const left = Number(readFileSync(join(dir, "left"), "utf8"));
    assert.equal(alive(left), true);
    await new Promise(done => setTimeout(done, 3000));
    assert.equal(await gone(left), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [signal, code] of [["SIGTERM", 9], ["SIGINT", 5], ["SIGHUP", 3]]) {
  test(`a ${signal} to heavy reaches CMD and heavy exits with CMD's code`, { skip }, async () => {
    const child = spawn(heavy, ["1G", "--", "sh", "-c", `trap 'echo got; exit ${code}' ${signal.slice(3)}; echo up; while :; do sleep 0.1; done`], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; if (out === "up\n") child.kill(signal); });
    assert.equal(await new Promise(done => child.on("exit", done)), code);
    assert.equal(out, "up\ngot\n");
  });
}
