import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// On 10-20 at 03:40Z 22 of the 23 biggest trees under ~/scratch on us-metal02 had no owned.json record, because jobs had to call board.own by
// hand, so a job's end never deleted them and ~/scratch grew from 61 to 76 GB in 5 h. kernel-own.py records what the kernel makes (c130).
const { PRELUDE } = await import("../packages/sieun-rules/src/kernel-guard.ts");
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

test("a recursive delete below ~/scratch of a tree another job owns, or one no record of this job holds, is refused, and the tree stays", () => {
  rmSync(join(session, "owned.json"), { force: true });
  const other = join(home, ".prime/agent/session-artifacts/01a10000-0000-7000-8000-0000000000aa/sub-5678abcd");
  mkdirSync(other, { recursive: true });
  for (const name of ["crawler-lab/build-b12", "crawler-lab/build-b13", "legacy-tree", "01a10000-0000-7000-8000-0000000000bb/rig"]) mkdirSync(join(scratch, name), { recursive: true });
  writeFileSync(join(other, "owned.json"), JSON.stringify({ paths: [join(scratch, "crawler-lab")], units: [] }));
  const run = kernel(`
import os, shutil, subprocess
def attempt(label, call):
    try:
        call()
        print(label, "ran")
    except PermissionError as error:
        print(label, "refused", type(error).__name__, "c130" in str(error), "sub-5678abcd" in str(error) if label in ("sh", "cd", "rmtree") else "")
b12 = os.path.expanduser("~/scratch/crawler-lab/build-b12")
attempt("sh", lambda: subprocess.run(["sh", "-c", "exec 7>&0\\n{\\nrm -rf " + b12 + " 2>/dev/null\\n}"]))
attempt("cd", lambda: subprocess.run("cd ~/scratch/crawler-lab && rm -fr build-b13", shell=True))
attempt("rmtree", lambda: shutil.rmtree(b12))
attempt("system", lambda: os.system("rm -r -f ~/scratch/legacy-tree"))
attempt("find", lambda: subprocess.run(["find", os.path.expanduser("~/scratch/legacy-tree"), "-delete"]))
attempt("glob", lambda: subprocess.run("rm -rf $HOME/scratch/*", shell=True))
attempt("folder", lambda: subprocess.run(["rm", "-rf", "--", os.path.expanduser("~/scratch/01a10000-0000-7000-8000-0000000000bb")]))
`);
  assert.deepEqual(run.stdout.trim().split("\n").map((line) => line.trim()), [
    "sh refused TreeRefused True True", "cd refused TreeRefused True True", "rmtree refused TreeRefused True True",
    "system refused TreeRefused True", "find refused TreeRefused True", "glob refused TreeRefused True", "folder refused TreeRefused True"]);
  for (const name of ["crawler-lab/build-b12", "crawler-lab/build-b13", "legacy-tree", "01a10000-0000-7000-8000-0000000000bb/rig"]) assert.ok(existsSync(join(scratch, name)), name);
});

test("the job deletes the trees it made, its subagents' records and its sessions' own folders, and a path outside ~/scratch is not judged", () => {
  rmSync(join(session, "owned.json"), { force: true });
  const child = join(session, "sub-9abcdef0");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, "01a10000-0000-7000-8000-0000000000cc.jsonl"), "");
  for (const name of ["child-rig/tree", "01a10000-0000-7000-8000-0000000000cc/tree", "01a10000-0000-7000-8000-000000000000/tree"]) mkdirSync(join(scratch, name), { recursive: true });
  writeFileSync(join(child, "owned.json"), JSON.stringify({ paths: [join(scratch, "child-rig")], units: [] }));
  const outside = mkdtempSync(join(root, "outside-"));
  const run = kernel(`
import os, shutil, subprocess, tempfile
made = os.path.expanduser("~/scratch/made-here/tree")
os.makedirs(made)
subprocess.run(["sh", "-c", "rm -rf ~/scratch/made-here/tree"], check=True)
shutil.rmtree(os.path.expanduser("~/scratch/made-here"))
subprocess.run("rm -rf ~/scratch/child-rig/tree ~/scratch/01a10000-0000-7000-8000-0000000000cc ~/scratch/never-made", shell=True, check=True)
os.system("rm -rf ~/scratch/01a10000-0000-7000-8000-000000000000/tree")
with tempfile.TemporaryDirectory(dir=os.path.expanduser("~/scratch")) as rig:
    open(os.path.join(rig, "f"), "w").write("x")
subprocess.run(["rm", "-rf", ${JSON.stringify(outside)}], check=True)
print("ok")
`);
  assert.equal(run.stdout.trim(), "ok");
  for (const name of ["made-here", "child-rig/tree", "01a10000-0000-7000-8000-0000000000cc", "01a10000-0000-7000-8000-000000000000/tree"]) assert.ok(!existsSync(join(scratch, name)), name);
  assert.ok(!existsSync(outside));
});

test("a command over ssh to another box in hosts.json records the ~/scratch trees it made there for that box, and nothing that was there or it only named", () => {
  // 10-20: Mac jobs held 22.4 GB of trees on us-metal02 that they made over ssh, such as ~/scratch/flow-at-scale-convex-scale, and no record named.
  mkdirSync(session, { recursive: true });
  rmSync(join(session, "owned.json"), { force: true });
  const far = join(root, "far-home");
  const bin = join(root, "fake-ssh-bin");
  mkdirSync(join(far, "scratch", "old-far"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nif [ "$1" = "-G" ]; then echo "hostname $2"; exit 0; fi\nfor arg; do last="$arg"; done\nHOME=${far} exec sh -c "$last"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const hosts = join(root, "hosts.json");
  writeFileSync(hosts, JSON.stringify({ version: 1, hosts: [{ name: "far", hostname: "far-box", address: "10.9.9.9", ssh: "u@far" }] }));
  kernel(`
import os, subprocess, time
subprocess.run(["sh", "-c", "ssh -o BatchMode=yes u@far 'mkdir -p ~/scratch/far-job/tree && cd ~/scratch/far-job/tree'"], check=True)
subprocess.run("ssh far 'mkdir -p ~/scratch/old-far/x; ls ~/scratch/only-named 2>/dev/null; mkdir -p ~/scratch/01a10000-0000-7000-8000-0000000000dd/t'", shell=True, check=True)
os.system("ssh far 'mkdir -p $HOME/scratch/system-far'")
subprocess.run(["ssh", "elsewhere", "mkdir -p ~/scratch/unknown-box"], check=True)
bg = subprocess.Popen(["sh", "-c", "ssh far 'sleep 1; mkdir -p ~/scratch/bg-far'"])
bg.wait()
time.sleep(2.5)
`, { RLM_SESSION_DIR: session, SIEUN_PI_HOSTS: hosts, PATH: `${bin}:${process.env.PATH}` });
  assert.ok(existsSync(join(far, "scratch", "far-job", "tree")) && existsSync(join(far, "scratch", "unknown-box")));
  const record = JSON.parse(readFileSync(join(session, "owned.json"), "utf8"));
  assert.deepEqual(record.paths, []);
  assert.deepEqual(Object.keys(record.hosts), ["far"]);
  assert.deepEqual(record.hosts.far.sort(), ["~/scratch/bg-far", "~/scratch/far-job", "~/scratch/old-far/x", "~/scratch/system-far"]);
});
