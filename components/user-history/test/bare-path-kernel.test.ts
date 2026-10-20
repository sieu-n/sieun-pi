// Guards the Mac restart of 10-20 07:49:42Z: the supervisor started from an ssh command, so its 41 revived kernels had PATH
// /usr/bin:/bin:/usr/sbin:/sbin and every cross-host send failed with "No such file or directory: 'node'". The message check now gives
// such a kernel the login shell's PATH when it loads.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

async function kernel(withNode: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "bare-path-kernel-"));
  const bin = join(dir, "login-bin");
  const bare = join(dir, "bare-bin");
  await mkdir(bin);
  await mkdir(bare);
  await writeFile(join(bin, "node"), "#!/bin/sh\necho login-node\n");
  await chmod(join(bin, "node"), 0o755);
  if (withNode) {
    await writeFile(join(bare, "node"), "#!/bin/sh\necho bare-node\n");
    await chmod(join(bare, "node"), 0o755);
  }
  const shell = join(dir, "login-shell");
  await writeFile(shell, `#!/bin/sh\necho ran >> ${join(dir, "shell-runs")}\nprintf 'motd line\\n%s' "${bin}:/usr/bin:/bin"\n`);
  await chmod(shell, 0o755);
  const script = [
    messageCheckPrelude(null).trimEnd(),
    "import os, shutil, subprocess",
    "print(os.environ['PATH'])",
    "print(subprocess.run(['node'], capture_output=True, text=True).stdout.strip())",
  ].join("\n");
  const run = await promisify(execFile)("/usr/bin/python3", ["-c", script], { cwd: dir, encoding: "utf8",
    env: { HOME: dir, SHELL: shell, PATH: `${bare}:/usr/bin:/bin` } });
  const runs = await readFile(join(dir, "shell-runs"), "utf8").catch(() => "");
  return { lines: run.stdout.trim().split("\n"), shellRuns: runs.split("\n").filter(Boolean).length, bin, bare };
}

test("a kernel whose PATH finds no node takes the login shell's PATH in front of its own", async () => {
  const { lines, shellRuns, bin, bare } = await kernel(false);
  assert.equal(lines.at(-2), `${bin}:/usr/bin:/bin:${bare}`);
  assert.equal(lines.at(-1), "login-node");
  assert.equal(shellRuns, 1);
});

test("a kernel whose PATH finds node keeps it and starts no login shell", async () => {
  const { lines, shellRuns } = await kernel(true);
  assert.equal(lines.at(-1), "bare-node");
  assert.equal(shellRuns, 0);
});
