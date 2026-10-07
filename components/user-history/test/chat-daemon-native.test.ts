import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DaemonClient, SessionManager } from "prime-agent";
import { stopChatNativeDaemon } from "./chat-native-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const primeRoot = resolve(dirname(fileURLToPath(import.meta.resolve("prime-agent"))), "..");
const node = process.execPath;
const run = promisify(execFile);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const address = probe.address(); assert(address && typeof address !== "string");
  await new Promise<void>(done => probe.close(() => done()));
  return address.port;
}

/** Daemon processes listening for this socket, by command line. */
async function daemons(socket: string): Promise<number> {
  const { stdout } = await run("/bin/ps", ["-axo", "command"]);
  return stdout.split("\n").filter(line => line.includes("--mode daemon") && line.includes(`--daemon-socket ${socket}`)).length;
}

async function sessionsFrame(url: string, timeout = 30000): Promise<{ daemon: string; sessions: { id: string }[] }> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url + "api/sessions/stream", { signal: controller.signal });
      const reader = response.body!.getReader();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("utf8");
        const frames = [...text.matchAll(/event: sessions\ndata: (.*)\n\n/g)].map(match => JSON.parse(match[1]!) as { daemon: string; sessions: { id: string }[] });
        const up = frames.find(frame => frame.daemon === "up");
        if (up) { controller.abort(); return up; }
      }
    } catch { /* aborted: try again */ } finally { clearTimeout(timer); }
    if (Date.now() > deadline) throw new Error("The sessions stream never reported the daemon up.");
  }
}

test("a chat that finds no daemon starts one through the installed launcher, once", { timeout: 180000 }, async context => {
  const id = randomBytes(5).toString("hex");
  const root = join(process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(packageRoot, ".test-artifacts"), `chat-daemon-${id}`);
  const home = join(root, "home"), config = join(home, ".prime/agent"), sessions = join(root, "sessions"), cwd = join(root, "project");
  const install = join(root, "install"), nativeTemp = join(root, "native-temp");
  const temporary = `/tmp/wdt-${id}`, socket = `${temporary}/d.sock`;
  await Promise.all([config, sessions, cwd, join(install, "bin"), nativeTemp].map(path => mkdir(path, { recursive: true })));
  await symlink(nativeTemp, temporary);
  // The official install layout, `<PRIME_AGENT_INSTALL_DIR>/bin/prime-agent`, here running the locked prime-agent package with this node.
  await writeFile(join(install, "bin", "prime-agent"), `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(join(primeRoot, "dist/bundle/cli.js"))} "$@"\n`);
  await chmod(join(install, "bin", "prime-agent"), 0o755);
  await writeFile(join(config, "settings.json"), JSON.stringify({ onboardingShown: true, onboardingCompleted: true, telemetry: { enabled: false, noticeShown: true },
    mcpServers: {}, packages: [], extensions: [], skills: [] }));
  process.env.RLM_DEPTH = "0";
  const manager = SessionManager.create(cwd, sessions);
  manager.appendSessionInfo(`daemon-start-${id}`);
  manager.appendMessage({ role: "user", content: "SAVED", timestamp: 1000 });
  manager.flushNow();
  const env = { HOME: home, SHELL: "/bin/sh", PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: temporary + "/", LANG: "en_US.UTF-8", TERM: "dumb",
    PRIME_AGENT_CODING_AGENT_DIR: config, PRIME_AGENT_SESSION_DIR: sessions, PRIME_AGENT_TELEMETRY: "0", PI_OFFLINE: "1",
    PRIME_AGENT_INSTALL_DIR: install, SIEUN_PI_CHAT_START_DAEMON: "1" };
  const [portA, portB] = [await freePort(), await freePort()];
  const chatCli = async (command: string, port: number, dataDir: string) => (await run(node,
    [join(packageRoot, "../../scripts/cli.mjs"), "chat", command, "--port", String(port), "--socket", socket, "--data-dir", dataDir], { env, timeout: 60000 })).stdout.trim();
  const dataA = join(root, "chat-a"), dataB = join(root, "chat-b");
  context.after(async () => {
    await chatCli("stop", portA, dataA).catch(() => {});
    await chatCli("stop", portB, dataB).catch(() => {});
    const daemon = new DaemonClient(socket);
    await stopChatNativeDaemon(daemon, socket).catch(() => {});
    daemon.close();
    // Last: a chat still running finds its daemon socket gone once the link is removed, and its keeper starts a daemon in a new /tmp folder.
    await unlink(temporary).catch(() => {});
  });

  assert.equal(await daemons(socket), 0, "no daemon before the chat starts");
  const url = await chatCli("start", portA, dataA);
  const up = await sessionsFrame(url, 60000);
  assert.deepEqual(up.sessions.map(row => row.id), [manager.getSessionId()], "the daemon the chat started lists the isolated sessions");
  assert.equal(await daemons(socket), 1);
  assert.match(await chatCli("status", portA, dataA), /Daemon: answering on /);

  assert.equal(await chatCli("start", portA, dataA), url, "a second start reuses the chat");
  const urlB = await chatCli("start", portB, dataB);
  await sessionsFrame(urlB);
  await new Promise(done => setTimeout(done, 1000));
  assert.equal(await daemons(socket), 1, "a second chat on the same socket starts no second daemon");
});
