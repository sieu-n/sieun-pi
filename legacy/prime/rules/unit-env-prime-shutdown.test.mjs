import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// On 10-27 the live daemon on us-metal02 stopped twice with every agent on it (~/work/d7-supervisor-exits/TRACE.md). At 16:55:07Z a kernel
// bash ran `HOME=<scratch> TMPDIR=<scratch> prime-agent shutdown --force` by name. At 17:07:48Z the unit svh-teardown-r01 ran
// `<release>/prime-agent shutdown --force --json` by full path. Both carried the kernel's PRIME_AGENT_CODING_AGENT_DIR, so Prime found the live
// supervisor through the live workers' descriptors. Here a scratch daemon with one worker plays the live one, on its own socket and agent dir.
const rules = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/sieun-rules/src");
const unitEnv = join(rules, "unit-env");
const root = realpathSync(mkdtempSync(join(tmpdir(), "gr-shutdown-")));
const release = process.env.PRIME_AGENT_BIN || join(homedir(), ".local/share/prime-agent/bin/prime-agent");
const haveRelease = existsSync(release);
const uid = process.getuid();
const dir = (...parts) => { const path = join(root, ...parts); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };

const live = { home: dir("live/home"), agent: dir("live/agent"), tmp: dir("live/tmp") };
live.sock = join(dir("live/tmp", `prime-agent-${uid}`), "daemon.sock");
const scratch = { home: dir("scratch/home"), agent: dir("scratch/agent"), tmp: dir("scratch/tmp") };
scratch.sock = join(dir("scratch/tmp", `prime-agent-${uid}`), "daemon.sock");
const probe = { home: dir("probe/home"), tmp: dir("probe/tmp") };

const realBin = dir("real-bin");
if (haveRelease) symlinkSync(release, join(realBin, "prime-agent"));
// A unit starts from the user manager's environment: its PATH, its TMPDIR (here the live one, as /tmp is on a box) and only the -E names.
const fakeBin = dir("fake-bin");
writeFileSync(join(fakeBin, "systemd-run"), `#!/usr/bin/env python3
import os, sys
args, env = sys.argv[1:], {"HOME": ${JSON.stringify(live.home)}, "TMPDIR": ${JSON.stringify(live.tmp)}, "PATH": "/usr/bin:/bin"}
while args and args[0].startswith("-"):
    option = args.pop(0)
    if option == "-E":
        name = args.pop(0)
        if "=" in name:
            env[name.split("=", 1)[0]] = name.split("=", 1)[1]
        elif name in os.environ:
            env[name] = os.environ[name]
os.execve(args[0] if "/" in args[0] else "/usr/bin/" + args[0], args, env)
`, { mode: 0o755 });

// What a kernel's bash and its children see: unit-env first on PATH, the live agent dir and a session folder under it.
const kernelEnv = () => ({
  HOME: live.home, TMPDIR: live.tmp, NO_COLOR: "1", PATH: `${unitEnv}:${fakeBin}:${realBin}:/usr/bin:/bin`,
  PRIME_AGENT_CODING_AGENT_DIR: live.agent, RLM_SESSION_DIR: dir("live/agent/session-artifacts/s1"),
  PYTHONPATH: join(rules, "python-child"), GLOBAL_RULES_PRIME_LIVE_SOCKET: live.sock,
});
const kernelPython = (command) => spawnSync("python3", ["-c", "import subprocess, sys; sys.exit(subprocess.run(['bash', '-c', sys.argv[1]]).returncode)", command],
  { encoding: "utf8", env: kernelEnv(), timeout: 120000 });
const kernelShell = (command) => spawnSync("bash", ["-c", command], { encoding: "utf8", env: kernelEnv(), timeout: 120000 });

const daemons = [];
function startDaemon(d) {
  const child = spawn(release, ["--mode", "daemon", "--daemon-socket", d.sock, "--offline"], {
    detached: true, stdio: "ignore", cwd: root,
    env: { HOME: d.home, TMPDIR: d.tmp, PATH: "/usr/bin:/bin", NO_COLOR: "1", PRIME_AGENT_CODING_AGENT_DIR: d.agent },
  });
  daemons.push(child);
  return child;
}

/** The supervisor generation in the hello of the daemon on this socket, or "" when none answers. */
function hello(sock) {
  return new Promise((resolve) => {
    const socket = connect(sock);
    let buffer = "";
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.on("data", (data) => {
      buffer += data;
      const line = buffer.split("\n")[0];
      if (buffer.includes("\n")) done(JSON.parse(line).supervisorGeneration || "");
    });
    socket.on("error", () => done(""));
    setTimeout(() => done(""), 5000);
  });
}

async function waitFor(sock) {
  for (let i = 0; i < 120; i++) {
    const generation = await hello(sock);
    if (generation) return generation;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no daemon on ${sock}`);
}

/** A resident agent, so the daemon has a worker whose descriptor in <agent dir>/daemon-workers names its socket, as the live workers did. */
function createAgent(sock) {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "command", id: "c1", protocol: { name: "prime-agent.daemon", version: 7 },
      clientId: "gr-shutdown", command: { type: "create", lifecycle: "resident", id: "c1" } })}\n`));
    socket.on("data", (data) => {
      buffer += data;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id === "c1") { socket.destroy(); message.success ? resolve(message.data.id) : reject(new Error(message.error)); }
      }
    });
    socket.on("error", reject);
  });
}

let liveGeneration = "";
test.before(async () => {
  if (!haveRelease) return;
  startDaemon(live);
  startDaemon(scratch);
  liveGeneration = await waitFor(live.sock);
  await waitFor(scratch.sock);
  await createAgent(live.sock);
});

test.after(() => {
  // Each environment here names only its own daemon's dirs, so this stops the two daemons of this test and their workers.
  for (const d of [live, scratch]) {
    if (haveRelease) spawnSync(release, ["shutdown", "--force", "--json"], { env: { HOME: d.home, TMPDIR: d.tmp, PATH: "/usr/bin:/bin", PRIME_AGENT_CODING_AGENT_DIR: d.agent }, timeout: 60000 });
  }
  for (const child of daemons) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  rmSync(root, { recursive: true, force: true });
});

const assertLiveUp = async () => assert.equal(await hello(live.sock), liveGeneration, "the live daemon stopped");
const probeVars = `HOME=${probe.home} TMPDIR=${probe.tmp} NO_COLOR=1`;

test("the probe environment finds the live daemon through the agent dir, as in the trace", { skip: !haveRelease }, () => {
  const ran = spawnSync("sh", ["-c", `${probeVars} ${release} status --json`], { encoding: "utf8", env: kernelEnv() });
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(JSON.parse(ran.stdout).some((d) => d.socketPath === live.sock), ran.stdout);
});

test("exit 1: a kernel bash running prime-agent shutdown --force by name with a probe HOME and TMPDIR is refused", { skip: !haveRelease }, async () => {
  const ran = kernelPython(`${probeVars} prime-agent shutdown --force`);
  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /refused: 'prime-agent shutdown'.*would stop the live daemon/);
  await assertLiveUp();
});

test("exit 2: svh-teardown-r01's unit, the release binary by full path, is refused in the kernel and in systemd-run", { skip: !haveRelease }, async () => {
  const teardown = `systemd-run --user --unit=svh-teardown-r01 /usr/bin/sh -c "${probeVars} ${release} shutdown --force --json"`;
  const fromPython = kernelPython(teardown);
  assert.notEqual(fromPython.status, 0, fromPython.stdout);
  assert.match(fromPython.stderr, /prime-agent shutdown refused: .*names prime-agent by its path/);
  await assertLiveUp();
  const fromShell = kernelShell(teardown);
  assert.equal(fromShell.status, 2, fromShell.stdout + fromShell.stderr);
  assert.match(fromShell.stderr, /systemd-run: prime-agent shutdown refused/);
  await assertLiveUp();
});

test("the same teardown inside a script file or a bare-name unit without -E PATH is refused", { skip: !haveRelease }, async () => {
  const script = join(dir("scripts"), "teardown.sh");
  writeFileSync(script, `#!/bin/sh\n${probeVars} ${release} shutdown --force --json\n`, { mode: 0o755 });
  for (const command of [`sh ${script}`, `cd ${dirname(script)} && ./teardown.sh`, `bash -c "timeout 60 sh ${script}"`]) {
    const ran = kernelPython(command);
    assert.notEqual(ran.status, 0, command);
    assert.match(ran.stderr, /prime-agent shutdown refused/, command);
  }
  const unit = kernelShell(`systemd-run --user --unit=t sh -c '${probeVars} prime-agent shutdown --force'`);
  assert.equal(unit.status, 2, unit.stderr);
  await assertLiveUp();
});

test("a teardown whose environment names only scratch dirs stops only the scratch daemon", { skip: !haveRelease }, async () => {
  const vars = `HOME=${scratch.home} TMPDIR=${scratch.tmp} PRIME_AGENT_CODING_AGENT_DIR=${scratch.agent}`;
  const ran = kernelPython(`${vars} prime-agent shutdown --force --json`);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout).stopped.map((s) => s.socketPath), [scratch.sock]);
  assert.equal(await hello(scratch.sock), "");
  await assertLiveUp();
});

// The shim's other paths, with a fake CLI in place of Prime.
const fake = dir("fake-cli");
writeFileSync(join(fake, "prime-agent"), `#!/bin/sh
if [ "$1" = status ]; then [ -n "$FAKE_STATUS_FAIL" ] && exit 1; printf '[{"socketPath": "%s"}]\\n' "$FAKE_SOCKET"; exit 0; fi
printf 'ran %s\\n' "$*"
`, { mode: 0o755 });
const shim = (args, extra = {}) => spawnSync("prime-agent", args, {
  encoding: "utf8", env: { HOME: root, PATH: `${unitEnv}:${fake}:/usr/bin:/bin`, GLOBAL_RULES_PRIME_LIVE_SOCKET: "/tmp/gr-live/daemon.sock", ...extra },
});

test("the shim runs stop, send and every other command, and a shutdown that reaches no live daemon", () => {
  for (const args of [["stop", "abc123"], ["list", "--json"], ["send", "x", "shutdown"], ["--model", "shutdown", "stop", "a"]]) {
    const ran = shim(args, { FAKE_SOCKET: "/tmp/gr-live/daemon.sock" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), `ran ${args.join(" ")}`);
  }
  const ran = shim(["shutdown", "--force"], { FAKE_SOCKET: "/tmp/gr-scratch/daemon.sock" });
  assert.equal(ran.stdout.trim(), "ran shutdown --force");
});

test("the shim refuses a shutdown that lists the live socket or whose status fails", () => {
  for (const extra of [{ FAKE_SOCKET: "/tmp/gr-live/daemon.sock" }, { FAKE_STATUS_FAIL: "1" }]) {
    const ran = shim(["shutdown", "--force", "--json"], extra);
    assert.equal(ran.status, 2);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /refused: 'prime-agent shutdown'/);
  }
});

test("systemd-run passes a unit with no prime-agent shutdown, and a bare-name one that gets the kernel's PATH", () => {
  const real = dir("real-systemd-run");
  writeFileSync(join(real, "systemd-run"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  for (const command of [["sh", "-c", "python3 scan.py"], ["-E", "PATH", "sh", "-c", "prime-agent shutdown --force"], ["prime-agent", "stop", "abc"]]) {
    const ran = spawnSync("sh", [join(unitEnv, "systemd-run"), "--user", "--unit=t", ...command], { encoding: "utf8", env: { HOME: root, PATH: `${unitEnv}:${real}:/usr/bin:/bin` } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim().split("\n").at(-1), command.at(-1));
  }
});
