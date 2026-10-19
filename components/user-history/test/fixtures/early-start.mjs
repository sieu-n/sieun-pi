// A stand-in for chat-service-cli.mjs on systemd's socket: starts the early shell's process, and on "take" from stdin listens with a real server.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { startEarlyChild } from "../../src/early-shell-start.mjs";

const early = startEarlyChild(["serve", "--data-dir", process.argv[2]]);
early.server.on("listening", () => process.stdout.write("taken\n"));
createInterface({ input: process.stdin }).on("line", line => {
  if (line !== "take" && line !== "take-busy") return;
  early.take((req, res) => { res.writeHead(200); res.end(`real ${req.url}`); }, (_req, socket, head) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    const echo = data => socket.write("echo:" + data.toString());
    if (head.length) echo(head); else socket.once("data", echo);
  });
  // The rest of the start after the real server is ready: this thread stands still again.
  if (line === "take-busy") setTimeout(() => { process.stdout.write("busy\n"); const until = Date.now() + 1500; while (Date.now() < until) { /* catalog */ } process.stdout.write("free\n"); }, 30);
});
// The service import: this thread stands still for argv[3] ms, or until the file argv[4] names exists.
const until = Date.now() + Number(process.argv[3] ?? 0);
const gate = process.argv[4];
while (gate ? !existsSync(gate) : Date.now() < until) { /* importing */ }
process.stdout.write("imported\n");
