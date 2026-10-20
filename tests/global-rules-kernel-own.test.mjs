import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// On 10-20 at 03:40Z 22 of the 23 biggest trees under ~/scratch on us-metal02 had no owned.json record, because jobs had to call board.own by
// hand, so a job's end never deleted them and ~/scratch grew from 61 to 76 GB in 5 h. kernel-own.py records what the kernel makes (c130).
const { PRELUDE } = await import("../components/global-rules/kernel-guard.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-own-")));
const home = join(root, "home");
const scratch = join(home, "scratch");
const session = join(home, ".prime/agent/session-artifacts/01a10000-0000-7000-8000-000000000000/sub-1234abcd");
test.after(() => rmSync(root, { recursive: true, force: true }));

const env = (extra) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["RLM_SESSION_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PYTHONPATH", "OWNER_OK"].includes(key)));
  return { ...base, HOME: home, GLOBAL_RULES_LOG: join(root, "global-rules.log"), AGENT_CHAT_DATA_DIR: join(root, "chat"), ...extra };
};
const kernel = (code, extra = { RLM_SESSION_DIR: session }) => {
  const run = spawnSync("python3", ["-B", "-c", `${PRELUDE}${code}`], { env: env(extra), encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return run;
};
const owned = () => JSON.parse(readFileSync(join(session, "owned.json"), "utf8")).paths;

test("the kernel records the folders under ~/scratch it makes, by Python or by a command, and nothing it did not make or a job's own folder holds", () => {
  mkdirSync(session, { recursive: true });
  mkdirSync(join(scratch, "old-job"), { recursive: true });
  kernel(`
import os, subprocess, tempfile, time
from pathlib import Path
os.makedirs(os.path.expanduser("~/scratch/py-job/tree/a"))
tempfile.mkdtemp(dir=os.path.expanduser("~/scratch/py-job"))
Path.home().joinpath("scratch", "path-job").mkdir()
subprocess.run(["sh", "-c", "mkdir -p ~/scratch/sh-job/tree && git --version > ~/scratch/sh-job/tree/v"], check=True)
subprocess.run(["sh", "-c", 'mkdir -p "$HOME/scratch/old-job/export"'], check=True)
subprocess.run(["sh", "-c", "ls ~/scratch/later/x 2>/dev/null; true"])
bg = subprocess.Popen(["sh", "-c", "sleep 1; mkdir ${home}/scratch/bg-job"])
os.system("mkdir -p ~/scratch/system-job/tree")
os.makedirs(os.path.expanduser("~/scratch/01a15769-0000-7000-8000-000000000000/tree"))
subprocess.run(["sh", "-c", "mkdir -p ~/scratch/01a15769-0000-7000-8000-000000000001/rig"], check=True)
time.sleep(2.5)
bg.wait()
`);
  assert.deepEqual(owned(), ["py-job", "path-job", "sh-job", "old-job/export", "system-job", "bg-job"].map((name) => join(scratch, name)));
});

test("a path a finished command only named is not recorded when another process makes it later", () => {
  rmSync(join(session, "owned.json"), { force: true });
  kernel(`
import subprocess, os, time
subprocess.run(["sh", "-c", "ls ~/scratch/later-made 2>/dev/null; true"])
time.sleep(1.5)
subprocess.run(["/bin/mkdir", "-p", "--", os.path.expanduser("~") + "/scratch/argv-job"])
subprocess.run(["sh", "-c", 'd=later; mkdir -p ~/scratch/\${d}-made'])
time.sleep(2.5)
`);
  assert.ok(existsSync(join(scratch, "later-made")));
  assert.deepEqual(owned(), [join(scratch, "argv-job")]);
});

test("with no RLM_SESSION_DIR, as in CI or a person's shell, nothing is recorded", () => {
  rmSync(join(session, "owned.json"), { force: true });
  kernel(`
import os, subprocess
os.makedirs(os.path.expanduser("~/scratch/ci-job/tree"))
subprocess.run(["sh", "-c", "mkdir -p ~/scratch/ci-sh"], check=True)
`, {});
  assert.ok(existsSync(join(scratch, "ci-job/tree")));
  assert.ok(!existsSync(join(session, "owned.json")));
});
