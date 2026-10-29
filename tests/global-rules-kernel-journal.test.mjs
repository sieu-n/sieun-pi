import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// On 10-29 three auto-sns-agent commits (250b096c5, 7d5726a419, f856a11257) took other sessions' hunks, because the edit skill, open() in a cell
// and Mac jobs' scp into us-metal02's checkout left no record in the write journal commit.mjs reads. kernel-journal.py records those writes.
const { PRELUDE } = await import("../packages/sieun-rules/src/kernel-guard.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-journal-")));
const home = join(root, "home");
const checkout = join(root, "checkout");
const plain = join(root, "plain");
const session = "01a10000-0000-7000-8000-0000000000ee";
const harness = join(home, `.prime/agent/session-artifacts/01a10000-0000-7000-8000-000000000000/sub-1234abcd/session-artifacts/${session}/harness`);
test.after(() => rmSync(root, { recursive: true, force: true }));

for (const dir of [checkout, plain]) {
  mkdirSync(join(dir, "src"), { recursive: true });
  spawnSync("git", ["init", "-q", dir]);
}
writeFileSync(join(checkout, ".git/agent-shared-checkout"), `${checkout}\n`);

const env = (extra) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["RLM_SESSION_DIR", "RLM_HARNESS_STATE_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENT_WRITES_ROOT", "PRIME_AGENT_CODING_AGENT_DIR",
      "PI_CODING_AGENT_DIR", "PYTHONPATH", "OWNER_OK"].includes(key)));
  return { ...base, HOME: home, GLOBAL_RULES_LOG: join(root, "global-rules.log"), AGENT_CHAT_DATA_DIR: join(root, "chat"), RLM_HARNESS_STATE_DIR: harness, ...extra };
};
const kernel = (code, extra = {}) => {
  const run = spawnSync("python3", ["-B", "-c", `${PRELUDE}${code}`], { env: env(extra), encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return run;
};
const journal = () => {
  const folder = join(checkout, ".cache/agent-writes");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((day) => readdirSync(join(folder, day)).flatMap((name) =>
    readFileSync(join(folder, day, name), "utf8").trim().split("\n").filter(Boolean).map((line) => ({ file: `${day}/${name}`, ...JSON.parse(line) }))));
};
const hashObject = (file) => spawnSync("git", ["hash-object", file], { encoding: "utf8" }).stdout.trim();
const reset = () => rmSync(join(checkout, ".cache"), { recursive: true, force: true });

test("Path.write_text into a marked checkout writes one record with the session, path, tool and git's blob id", () => {
  reset();
  kernel(`
from pathlib import Path
Path(${JSON.stringify(join(checkout, "src/a.ts"))}).write_text("export const a = 1;\\n", encoding="utf-8")
`);
  const records = journal();
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.file, `${new Date().toISOString().slice(0, 10)}/${session}.jsonl`);
  assert.deepEqual({ ...record, file: undefined, ts: undefined }, {
    file: undefined, ts: undefined, session_id: session, path: "src/a.ts", tool: "prime-kernel", blob: hashObject(join(checkout, "src/a.ts")), tool_use_id: null });
  assert.ok(Math.abs(record.ts - Date.now()) < 60_000);
});

test("open() in each writable mode records at close, a dropped file still flushes, and reads, unchanged appends and skipped folders record nothing", () => {
  reset();
  kernel(`
import os
c = ${JSON.stringify(checkout)}
open(os.path.join(c, "src/b.txt"), "w").write("dropped")
assert open(os.path.join(c, "src/b.txt")).read() == "dropped"
with open(os.path.join(c, "src/c.bin"), "wb") as f:
    f.write(b"\\x00\\x01")
with open(os.path.join(c, "src/b.txt"), "a") as f:
    pass
with open(os.path.join(c, "src/b.txt"), "a") as f:
    f.write("+more")
with open(os.path.join(c, "src/c.bin"), "r+b") as f:
    f.read()
open(os.path.join(c, "src/b.txt")).read()
os.makedirs(os.path.join(c, "node_modules/x"))
open(os.path.join(c, "node_modules/x/i.js"), "w").write("x")
open(os.path.join(c, ".git/hooks-note"), "w").write("x")
`);
  const records = journal();
  assert.deepEqual(records.map((r) => r.path), ["src/b.txt", "src/c.bin", "src/b.txt"]);
  assert.equal(records[2].blob, hashObject(join(checkout, "src/b.txt")));
  assert.equal(readFileSync(join(checkout, "src/b.txt"), "utf8"), "dropped+more");
});

test("a write outside a marked checkout, or with no session id, records nothing", () => {
  reset();
  kernel(`
from pathlib import Path
Path(${JSON.stringify(join(plain, "src/a.ts"))}).write_text("x")
Path(${JSON.stringify(join(root, "loose.txt"))}).write_text("x")
`);
  kernel(`
from pathlib import Path
Path(${JSON.stringify(join(checkout, "src/anon.ts"))}).write_text("x")
`, { RLM_HARNESS_STATE_DIR: "" });
  assert.deepEqual(journal(), []);
  assert.ok(!existsSync(join(plain, ".cache")));
});

test("os.replace and os.rename into the checkout record the destination with its blob after the move", () => {
  reset();
  kernel(`
import os, tempfile
c = ${JSON.stringify(checkout)}
fd, tmp = tempfile.mkstemp(dir=${JSON.stringify(root)})
os.write(fd, b"atomic save\\n")
os.close(fd)
os.replace(tmp, os.path.join(c, "src/atomic.ts"))
with open(os.path.join(${JSON.stringify(root)}, "moved"), "w") as f:
    f.write("moved")
os.rename(os.path.join(${JSON.stringify(root)}, "moved"), os.path.join(c, "src/moved.ts"))
`);
  const records = journal();
  assert.deepEqual(records.map((r) => [r.path, r.blob]), [
    ["src/atomic.ts", hashObject(join(checkout, "src/atomic.ts"))], ["src/moved.ts", hashObject(join(checkout, "src/moved.ts"))]]);
});

test("AGENT_WRITES_ROOT moves the journal, CLAUDE_CODE_SESSION_ID names the session with no harness dir, and a Python a cell starts journals too", () => {
  reset();
  const writes = join(root, "writes");
  kernel(`
import subprocess, sys
subprocess.run([sys.executable, "-c", "open(%r, 'w').write('x = 1')" % ${JSON.stringify(join(checkout, "src/child.py"))}], check=True)
`, { RLM_HARNESS_STATE_DIR: "", CLAUDE_CODE_SESSION_ID: "claude-1", AGENT_WRITES_ROOT: writes });
  assert.deepEqual(journal(), []);
  const day = new Date().toISOString().slice(0, 10);
  const records = readFileSync(join(writes, day, "claude-1.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => [r.session_id, r.path, r.blob]), [["claude-1", "src/child.py", hashObject(join(checkout, "src/child.py"))]]);
});

test("a command that scp's or writes over ssh into a checkout on another box has that box record the paths, once it exits 0", () => {
  reset();
  const bin = join(root, "fake-ssh-bin");
  const calls = join(root, "ssh-calls.jsonl");
  mkdirSync(bin, { recursive: true });
  const stub = (name) => `#!/usr/bin/env python3\nimport json, sys\nopen(${JSON.stringify(calls)}, "a").write(json.dumps(["${name}", *sys.argv[1:]]) + "\\n")\nsys.exit(${name === "scp" ? "1 if 'fail' in sys.argv[-1] else 0" : "0"})\n`;
  for (const name of ["ssh", "scp"]) {
    writeFileSync(join(bin, name), stub(name));
    chmodSync(join(bin, name), 0o755);
  }
  const repo = "/home/sieun/Documents/Github/auto-sns-agent";
  rmSync(calls, { force: true });
  kernel(`
import os, subprocess
subprocess.run("scp -q -P 2222 /tmp/x.txt us-metal02:${repo}/apps/a.ts", shell=True, check=True)
subprocess.run(["scp", "/tmp/one", "/tmp/two", "far:${repo}/apps/"], check=True)
subprocess.run(["sh", "-c", "printf x | ssh -i key us-metal02 'cat > ${repo}/apps/b.ts' && ssh far \\"tee -a ~/Documents/Github/auto-sns-agent/c.md >/dev/null\\""], check=True)
os.system("scp /tmp/x far:${repo}/fail.ts")
subprocess.run(["scp", "us-metal02:${repo}/apps/a.ts", "/tmp/down"], check=True)
subprocess.run(["scp", "/tmp/x", "us-metal02:/home/sieun/scratch/notes.txt"], check=True)
`, { PATH: `${bin}:${process.env.PATH}` });
  const lines = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const records = lines.filter((argv) => argv[0] === "ssh" && argv.some((word) => word.includes("journal.mjs")));
  const script = (paths) => `r=$(git -C "$(dirname ${paths[0]})" rev-parse --show-toplevel) && node "$r/scripts/repo/agent/journal.mjs" record --session ${session} --tool prime-ssh ${paths.join(" ")}`;
  assert.deepEqual(records, [
    ["ssh", "-o", "BatchMode=yes", "-p", "2222", "us-metal02", script([`${repo}/apps/a.ts`])],
    ["ssh", "-o", "BatchMode=yes", "far", script([`${repo}/apps/one`, `${repo}/apps/two`])],
    ["ssh", "-o", "BatchMode=yes", "-i", "key", "us-metal02", script([`${repo}/apps/b.ts`])],
    ["ssh", "-o", "BatchMode=yes", "far", script([`"$HOME"/Documents/Github/auto-sns-agent/c.md`])],
  ]);
});
