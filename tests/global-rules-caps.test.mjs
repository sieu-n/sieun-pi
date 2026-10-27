import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The c107 cap guard (packages/sieun-rules/src/caps.ts). These strings are only fed to the handler; nothing here runs them.
const root = mkdtempSync(join(tmpdir(), "global-rules-caps-"));
const saved = process.env.GLOBAL_RULES_LOG;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
test.after(() => {
  if (saved === undefined) delete process.env.GLOBAL_RULES_LOG;
  else process.env.GLOBAL_RULES_LOG = saved;
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });

function refused(toolName, texts) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /cap guard/, `${toolName}: ${text}`);
    assert.match(result.reason, /c107/);
    assert.match(result.reason, /JOBS=N/);
  }
}

function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

test("the 10-24 commands that made resource_limits_set read 2 are refused", () => {
  refused("bash", [
    "systemd-run --user --unit=stub-audit-full --collect --same-dir -E PATH sh -c \"heavy 8G -- docker run --rm --cpus 8 -e JOBS=8 -v /s:/repo -w /repo python:3.12-slim bash apps/infra/metal/tests/deploy-sh-stubs.sh /repo > /s/run-full.txt 2>&1; echo EXIT=\\$? >> /s/run-full.txt\"",
    "heavy 8G -- docker run --rm --cap-add SYS_PTRACE --security-opt seccomp=unconfined --cpus 8 -e JOBS=8 -v /t:/repo -w /repo img strace -f bash x.sh",
  ]);
  refused("ipython", [
    "h = bash('systemd-run --user --unit=stub-audit --collect --same-dir -E PATH sh -c \"heavy 8G -- docker run --rm --cpus 8 img\"')",
    "import subprocess\nsubprocess.run(['docker', 'run', '--rm', '--cpus', '8', 'img'])",
  ]);
});

test("docker run, create and update cap flags are refused in every spelling", () => {
  refused("bash", [
    "docker run --cpus 8 img",
    "docker run --cpus=8 img",
    "docker run -m 4g img",
    "docker run -m4g img",
    "docker run --memory=4g img",
    "docker run --memory-swap 8g img",
    "docker run --cpu-quota 400000 img",
    "docker run --cpu-period 100000 img",
    "docker run -c 512 img",
    "docker run --cpu-shares 512 img",
    "docker run --pids-limit 100 img",
    "docker run --blkio-weight 300 img",
    "docker run --device-write-bps /dev/sda:1mb img",
    "docker run --device-read-iops /dev/sda:100 img",
    "docker run --cpuset-cpus 0-3 img",
    "docker create --memory 2g img",
    "docker container run -it --cpus 2 img sh",
    "docker update --cpus 2 web",
    "docker --context default run --rm --cpus 2 img",
    "sudo docker run --cpus 2 img",
    "podman run --memory 1g img",
    "/usr/bin/docker run --cpus 2 img",
    "cd /tmp && docker run --cpus 2 img",
    "x=$(docker run --cpus 2 img)",
  ]);
});

test("systemd-run and systemctl set-property cap properties are refused", () => {
  refused("bash", [
    "systemd-run --user --scope -p CPUQuota=800% make",
    "systemd-run --user -pMemoryMax=8G --unit=x make",
    "systemd-run --user --property=MemoryHigh=4G make",
    "systemd-run --user --property TasksMax=100 make",
    "systemd-run --user -p 'IOWriteBandwidthMax=/dev/nvme0n1 1M' make",
    "systemd-run --user -p CPUWeight=50 make",
    "systemd-run --user -p Nice=10 make",
    "systemd-run --user --nice=10 make",
    "systemd-run --user --unit=load-fakeprov -p CPUQuota=400% node load.mjs",
    "systemctl --user set-property app.slice MemoryMax=8G",
    "systemctl set-property --runtime ssh.service CPUWeight=1000",
  ]);
});

test("priority tools in front of a command are refused", () => {
  refused("bash", [
    "nice -n 19 pnpm test",
    "nice pnpm test",
    "nice -19 make",
    "renice -n 10 -p 1234",
    "ionice -c3 make",
    "ionice -c 2 -n 7 -p 1234",
    "ionice make",
    "cpulimit -l 50 -- make",
    "taskset -c 0-3 make",
    "systemd-run --user --unit=x --collect sh -c 'nice -n 10 make > out 2>&1'",
    "timeout 600 nice make",
    "ssh us-metal01 docker run --cpus 2 img",
  ]);
});

test("heavy, reads, prose and cap removals pass", () => {
  allowed("bash", [
    "heavy 8G -- pnpm svelte-check",
    "heavy 24G -- npx vitest run",
    "systemd-run --user --unit=suite --collect --same-dir -E PATH sh -c 'heavy 8G -- docker run --rm -e JOBS=8 img > out 2>&1'",
    "docker run --rm -e JOBS=8 -v /a:/repo -w /repo img bash x.sh",
    "docker run --rm -it img sh -c 'stress --cpus 8'",
    "docker run --rm img python -m pytest -c conf.ini",
    "docker inspect awesome_allen --format '{{.HostConfig.NanoCpus}}'",
    "docker stats --no-stream",
    "docker ps",
    "rg -n -- '--cpus' components",
    "grep -rn 'docker run --cpus' deploy/linux",
    "echo \"do not use docker run --cpus 8\"",
    "git commit -m 'refuse docker run --cpus 8 and nice -n 19' -- caps.ts",
    "cat > brief.md <<'EOF'\nDrop docker run --cpus 8, and never put nice -n 19 in front.\nsystemd-run -p CPUQuota=800% is refused.\nEOF",
    "systemctl --user show app.slice -p CPUQuotaPerSecUSec",
    "systemctl --user status stub-audit-full",
    "systemctl --user set-property app.slice MemoryMax=infinity",
    "systemctl --user set-property load-fakeprov.service CPUQuota=",
    "systemd-run --user --unit=x --collect --same-dir -E PATH sh -c 'node scripts/x.mjs > out 2>&1'",
    "nice",
    "ionice -p 1234",
    "taskset -p 1234",
    "journalctl --user | rg -- '--cpus 8'",
  ]);
  allowed("ipython", [
    "await rlm.spawn('Never run docker run --cpus 8 or nice -n 19 make; size by -e JOBS=N.', name='worker')",
    "brief = '''docker run --cpus 8 is refused'''\nprint(brief)",
    "h = bash('heavy 8G -- docker run --rm -e JOBS=8 img')",
  ]);
});
