// pi-host's compose healthcheck: healthy only when the host answers `durable_threads` on its socket, the boot check of
// scripts/install-pi-host-box.mjs. Usage: node pi-host-health.mjs <socket>
import { createConnection } from "node:net";

const socket = process.argv[2];
const conn = createConnection(socket);
let buffer = "";
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1); };
conn.setEncoding("utf8");
conn.on("error", error => fail(`${socket}: ${error.message}`));
conn.on("data", chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (line.type === "daemon_hello") conn.write(`${JSON.stringify({ type: "durable_threads", id: "health" })}\n`);
    else if (line.type === "response" && line.id === "health") {
      if (!line.success) fail(`durable_threads failed: ${line.error}`);
      process.stdout.write(`${line.data.threads.length} threads\n`);
      process.exit(0);
    }
  }
});
