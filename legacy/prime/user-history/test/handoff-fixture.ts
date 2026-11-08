// A chat stand-in for test/chat-handoff.test.ts: the running chat ("old") and, started by its hand-over, the successor, which holds its main
// thread busy for START_MS as a chat start under CI load does before it may serve.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { drainServer, handOver, handoffParent } from "../src/chat-handoff.ts";
import { forwardRequest } from "../src/early-shell.ts";

const START_MS = Number(process.env.FIXTURE_START_MS ?? 3000);
const busy = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* the start's own work */ } };
const answer = (who: string) => (req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => { res.end(JSON.stringify({ who, pid: process.pid, method: req.method })); });
};

const parent = handoffParent();
if (parent) {
  await parent.quiet();
  let ready!: () => void;
  const firstPass = new Promise<void>(resolve => { ready = resolve; });
  const shell = parent.shell(firstPass, line => process.stderr.write(line + "\n"), async () => true);
  const taking = shell.take(answer("new"), () => {});
  // The start: seconds of main-thread work in slices, then the first pass ends.
  for (let done = 0; done < START_MS; done += 250) { busy(250); await new Promise(resolve => setImmediate(resolve)); }
  ready();
  await taking;
  process.stderr.write(`new ${process.pid} serves\n`);
  // A successor the test could not stop ends on its own.
  setTimeout(() => process.exit(0), 30_000).unref();
} else {
  let writesTo: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const own = answer("old");
  const server = createServer((req, res) => { if (writesTo && req.method !== "GET") writesTo(req, res); else own(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
  process.send!({ port: (server.address() as { port: number }).port });
  process.on("message", () => {
    void handOver({ listenFd: fd, log: line => process.stderr.write(line + "\n"), args: [...process.execArgv, process.argv[1]!],
      quiesce: async () => {}, fence: async () => {},
      forwardWrites: port => { writesTo = (req, res) => { void port.then(at => forwardRequest(at)(req, res)); }; },
      latency: () => ({ readMs: 1234, read: "api/old-read", loopMs: 5 }),
      finish: () => drainServer(server),
      fail: reason => { process.stderr.write(`fail: ${reason}\n`); process.exit(1); } }).then(() => { process.disconnect?.(); });
  });
}
