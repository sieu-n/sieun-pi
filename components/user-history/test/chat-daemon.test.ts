import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { daemonAnswers, daemonEnvironment, DaemonKeeper, launcherCandidates, loginEnvironment, officialLaunch, parseEnvOutput } from "../src/chat-daemon.ts";

const MARK = "\0__SIEUN_PI_CHAT_ENV__\0";

test("the login-shell variables are read after the marker, so startup-file output is ignored", () => {
  assert.deepEqual(parseEnvOutput(`Welcome!\n${MARK}PATH=/a:/b\0TOKEN=x=y\0`), { PATH: "/a:/b", TOKEN: "x=y" });
  assert.equal(parseEnvOutput("no marker"), null);
});

test("the daemon gets the shell's variables over the chat's, without worker-internal and per-process ones", () => {
  const env = daemonEnvironment({ PATH: "/usr/bin", HOME: "/h", TMPDIR: "/t/", PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1", XPC_SERVICE_NAME: "com.sieun.agent-chat" },
    { PATH: "/opt/homebrew/bin:/usr/bin", LINEAR_API_KEY: "k", SHLVL: "2", PWD: "/h", _: "/usr/bin/env" });
  assert.deepEqual(env, { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/h", TMPDIR: "/t/", LINEAR_API_KEY: "k" });
});

test("the launcher is the official install link, then prime-agent on PATH", () => {
  assert.deepEqual(launcherCandidates({ HOME: "/h", PATH: "/x/bin:relative" }), ["/h/.local/share/prime-agent/bin/prime-agent", "/x/bin/prime-agent"]);
  assert.equal(launcherCandidates({ HOME: "/h", XDG_DATA_HOME: "/d" })[0], "/d/prime-agent/bin/prime-agent");
  assert.equal(launcherCandidates({ HOME: "/h", XDG_DATA_HOME: "/d", PRIME_AGENT_INSTALL_DIR: "/i" })[0], "/i/bin/prime-agent");
});

test("loginEnvironment runs the shell as an interactive login shell and keeps what it exports", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "chat-shell-"));
  try {
    const shell = join(dir, "fake-shell");
    // Prints noise like a chatty .zshrc, then runs the command with a variable only the "startup files" set.
    await writeFile(shell, `#!/bin/sh\necho "[$1 $2 $3]"\nFROM_SHELL=yes exec /bin/sh -c "$4"\n`);
    await chmod(shell, 0o755);
    const { env, error } = await loginEnvironment({ SHELL: shell, HOME: dir, PATH: "/usr/bin:/bin", PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1" });
    assert.equal(error, undefined);
    assert.equal(env.FROM_SHELL, "yes");
    assert.equal(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER, undefined);
    const broken = join(dir, "broken-shell");
    await writeFile(broken, "#!/bin/sh\nexit 3\n");
    await chmod(broken, 0o755);
    const fallback = await loginEnvironment({ SHELL: broken, HOME: dir, PATH: "/usr/bin:/bin" });
    assert.match(fallback.error ?? "", /exited 3/);
    assert.equal(fallback.env.PATH, "/usr/bin:/bin", "a failed shell falls back to the chat's own variables");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** A stand-in daemon: a Unix socket server the test opens and closes. */
async function fakeDaemon(path: string) {
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  return {
    async up() {
      server = createServer(socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      await new Promise<void>(resolve => server!.listen(path, resolve));
    },
    async down() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      server = undefined;
    },
  };
}

test("the keeper starts a missing daemon with backoff, never while it answers, and again after it exits", async () => {
  const dir = await mkdtemp(join("/tmp", "ck-"));
  const socketPath = join(dir, "d.sock");
  const daemon = await fakeDaemon(socketPath);
  const lines: string[] = [];
  let launches = 0;
  const keeper = new DaemonKeeper({ socketPath, log: line => lines.push(line), backoffMs: [20, 40], restartDelayMs: 20,
    launch: async () => {
      launches++;
      if (launches <= 2) return { ok: false, message: `launcher missing ${launches}` };
      await daemon.up();
      return { ok: true, message: "Daemon started" };
    } });
  try {
    void keeper.start();
    const until = async (check: () => boolean, label: string) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(check(), label);
    };
    await until(() => keeper.status().state === "up", "the third attempt brings the daemon up");
    assert.equal(launches, 3);
    assert.match(lines[0]!, /attempt 1 failed .*launcher missing 1\. Next attempt in 0s/);
    assert.match(lines[1]!, /attempt 2 failed/);
    assert.match(lines[2]!, /attempt 3 started the daemon/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(launches, 3, "no launch while the daemon answers");
    await daemon.down();
    await until(() => launches === 4 && keeper.status().state === "up", "a daemon that exits is started again");
    assert(lines.some(line => /closed the connection/.test(line)));
  } finally {
    keeper.close();
    await daemon.down();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a keeper that finds the daemon running only watches it", async () => {
  const dir = await mkdtemp(join("/tmp", "ck-"));
  const socketPath = join(dir, "d.sock");
  const daemon = await fakeDaemon(socketPath);
  await daemon.up();
  let launches = 0;
  const keeper = new DaemonKeeper({ socketPath, log: () => {}, launch: async () => { launches++; return { ok: true, message: "" }; } });
  try {
    void keeper.start();
    for (let i = 0; i < 100 && keeper.status().state !== "up"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(keeper.status().state, "up");
    assert.equal(launches, 0);
    assert.equal(await daemonAnswers(socketPath), true);
  } finally {
    keeper.close();
    await daemon.down();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(await daemonAnswers(socketPath), false);
});


const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(check(), label);
};

test("the keeper says whether a closed daemon left its socket file, which tells a SIGKILL or crash from a shutdown", async () => {
  // 10-15: kill -9 of the supervisor at 14:46, 16:07 and 17:43Z left daemon.sock; prime-agent shutdown --force at 18:25Z and 10-16 00:19Z removed it.
  const dir = await mkdtemp(join("/tmp", "ck-"));
  const socketPath = join(dir, "d.sock");
  const daemon = await fakeDaemon(socketPath);
  await daemon.up();
  const lines: string[] = [];
  const keeper = new DaemonKeeper({ socketPath, log: line => lines.push(line), restartDelayMs: 20, launch: async () => ({ ok: false, message: "held" }) });
  try {
    void keeper.start();
    await until(() => keeper.status().state === "up", "the keeper watches the running daemon");
    await daemon.down();
    await until(() => lines.some(line => /closed the connection/.test(line)), "a shutdown is logged");
    assert.match(lines.find(line => /closed the connection/.test(line))!, /removed its socket file, so it shut down/);
    lines.length = 0;
    await daemon.up();
    await until(() => keeper.status().state === "up", "the keeper watches the daemon again");
    await daemon.down();
    await writeFile(socketPath, "");
    await until(() => lines.some(line => /closed the connection/.test(line)), "a kill is logged");
    assert.match(lines.find(line => /closed the connection/.test(line))!, /left its socket file, so it was killed \(SIGKILL\) or crashed/);
  } finally {
    keeper.close();
    await daemon.down();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a daemon the chat starts writes its output to the stdio file, and its exit is logged with code and signal", async () => {
  const dir = await mkdtemp(join("/tmp", "cl-"));
  try {
    const shell = join(dir, "fake-shell");
    await writeFile(shell, `#!/bin/sh\nexec /bin/sh -c "$4"\n`);
    await chmod(shell, 0o755);
    await mkdir(join(dir, "install", "bin"), { recursive: true });
    const launcher = join(dir, "install", "bin", "prime-agent");
    // Listens on the socket it is given, prints to stderr, and exits 7 after a moment, as a supervisor that dies after startup.
    await writeFile(launcher, `#!${process.execPath}
const net = require("node:net");
const server = net.createServer(() => {}).listen(process.argv[5], () => {
  process.stderr.write("fake daemon up\\n");
  setTimeout(() => { process.stderr.write("fake daemon dies\\n"); process.exit(7); }, 1500);
});
`);
    await chmod(launcher, 0o755);
    const stdioPath = join(dir, "logs", "daemon-stdio.log");
    const lines: string[] = [];
    const launch = officialLaunch({ HOME: dir, SHELL: shell, PATH: "/usr/bin:/bin", PRIME_AGENT_INSTALL_DIR: join(dir, "install") },
      { stdioPath, log: line => lines.push(line), startupMs: 10_000 });
    const result = await launch(join(dir, "d.sock"));
    assert.equal(result.ok, true, result.message);
    await until(() => lines.length > 0, "the exit is logged");
    assert.match(lines[0]!, /the daemon this chat started \(pid \d+\) exited with code 7; its output is in .*daemon-stdio\.log/);
    assert.match(await readFile(stdioPath, "utf8"), /fake daemon up\nfake daemon dies\n/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
