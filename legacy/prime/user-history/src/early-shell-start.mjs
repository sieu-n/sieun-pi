import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A serve on systemd's socket answers page shells from disk while it loads the rest of the service (src/early-shell.ts), so a release restart
 * leaves the shell waiting only while node starts: at 12:42Z on 10-18 the import of chat-service.ts, the backend and the bundle compile held
 * the shell's first byte for 12.1 s while systemd queued the requests on the port's socket. The early shell runs in a process of its own
 * (src/early-shell-child.mjs), started before anything else loads here, since the import holds this thread for seconds. The server returned
 * here listens on the socket once the real server takes it (`take`), and then tells that process to hand over what it held.
 */
/**
 * Resolves once this thread answers timers on time again: three 20 ms timers in a row each late by under 15 ms, or after 15 s. The real server
 * is ready before the rest of the start is done, and on 10-18 at 23:31:38Z, 3.8 s after a restart, a shell it took waited 2.55 s behind that
 * work while shells at 7.9 s and later went out in one round trip; until then the early shell's process keeps answering them.
 */
async function quiet() {
  const until = Date.now() + 15_000;
  let calm = 0;
  while (calm < 3 && Date.now() < until) {
    const at = Date.now();
    await new Promise(resolve => setTimeout(resolve, 20));
    calm = Date.now() - at - 20 < 15 ? calm + 1 : 0;
  }
}

export function startEarlyChild(argv) {
  if (argv[0] !== "serve") return null;
  // Only on the socket systemd holds (deploy/linux/sieun-pi-chat.socket): a serve that binds its own port checks first that no other chat runs there.
  if (!(Number(process.env.LISTEN_FDS) >= 1 && Number(process.env.LISTEN_PID) === process.pid)) return null;
  const at = argv.indexOf("--data-dir");
  const dataDir = resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : join(homedir(), ".prime", "agent", "browser-chat"));
  const log = text => process.stderr.write(`${new Date().toISOString()} early shell: ${text}\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./early-shell-child.mjs", import.meta.url)), JSON.stringify({ dataDir })],
    { stdio: ["ignore", "inherit", "inherit", 3, "ipc"] });
  child.on("error", error => log(error.message));
  const server = createServer();
  return {
    server,
    async settled() {},
    /** Resolves once this process listens on the socket, so the caller reads the server's address only after that (10-19 01:14Z crash loop). */
    take(handler, upgrade) {
      server.on("request", handler);
      server.on("upgrade", upgrade);
      const began = Date.now();
      return quiet().then(() => new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ fd: 3 }, () => {
          server.removeListener("error", reject);
          server.on("error", error => log(`server: ${error.message}`));
          log(`handed over ${Date.now() - began} ms after the server was ready`);
          if (child.connected) { child.send("ready"); child.disconnect(); }
          resolve();
        });
      }));
    },
  };
}
