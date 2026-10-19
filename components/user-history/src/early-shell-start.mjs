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
    take(handler, upgrade) {
      server.on("request", handler);
      server.on("upgrade", upgrade);
      server.once("error", error => log(`listen: ${error.message}`));
      server.listen({ fd: 3 }, () => { if (child.connected) { child.send("ready"); child.disconnect(); } });
    },
  };
}
