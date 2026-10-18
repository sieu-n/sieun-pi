import { register } from "tsx/esm/api";

register();

/**
 * A serve on systemd's socket answers page shells from disk before it loads the rest of the service (src/early-shell.ts), so a release restart
 * leaves the shell waiting only while node starts: at 12:42Z on 10-18 the import of chat-service.ts, the backend and the bundle compile held
 * the shell's first byte for 12.1 s while systemd queued the requests on the port's socket.
 */
async function earlyShell(argv) {
  if (argv[0] !== "serve") return null;
  const flag = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const { homedir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const dataDir = resolve(flag("--data-dir") ?? join(homedir(), ".prime", "agent", "browser-chat"));
  let config;
  try { config = JSON.parse(await readFile(join(dataDir, "configuration.json"), "utf8")); } catch { return null; }
  // Only on the socket systemd holds (deploy/linux/sieun-pi-chat.socket): a serve that binds its own port checks first that no other chat runs there.
  if (!(Number(process.env.LISTEN_FDS) >= 1 && Number(process.env.LISTEN_PID) === process.pid)) return null;
  if (typeof config.capability !== "string" || typeof config.csrfToken !== "string") return null;
  const { startEarlyShell } = await import("./early-shell.ts");
  return startEarlyShell({ listenFd: 3, port: 0, capability: config.capability, csrfToken: config.csrfToken, dataDir })
    .catch(error => { process.stderr.write(`${new Date().toISOString()} early shell: ${error instanceof Error ? error.message : String(error)}\n`); return null; });
}

try {
  globalThis.__chatEarlyShell = await earlyShell(process.argv.slice(2));
  await globalThis.__chatEarlyShell?.settled();
  const { runChatCommand } = await import("./chat-service.ts");
  await runChatCommand(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  const written = new Promise(resolve => process.stderr.write("sieun-pi chat: " + message + "\n", resolve));
  const sent = process.connected ? new Promise(resolve => process.send({ error: message }, resolve)) : null;
  // A failed serve may already hold the usage database lock, a daemon keeper and the page build worker, which keep it running unseen.
  // It exits once the error reached its log and its starter.
  if (process.argv[2] === "serve") { await Promise.all([written, sent]); process.exit(1); }
} finally {
  if (process.connected) process.disconnect();
}
