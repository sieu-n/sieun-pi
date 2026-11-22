// The HTTP/2 over TLS front of the restart walk (restart-walk.mjs), as tailscale serve is for the owner's page. It forwards to a chat
// server through a unix socket (the walk's bridge to the server's port) and pipes /api/live upgrades as raw bytes.
// An upstream failure ends the call the way Go's httputil.ReverseProxy in tailscale serve does: a 502 before any answer header came, and
// a reset stream after.
// It guards live data: every write but one to the walk's test rooms is refused, and POST /api/timings is answered here and written to
// <timings.jsonl> with its arrival time and user agent, so the walk's calls stay out of the owner's request log.
// Each forwarded call also goes to front-calls.jsonl beside it: when it came in, when the server's answer headers came, and when the
// answer's last byte left for the browser, so a slow page call can be split into the path before the front and the path behind it.
// Each /api/live upgrade adds a {kind: "ws"} line there when it closes, with its bytes each way.
// Usage: node restart-walk-front.mjs <listen port> <socket path> <key.pem> <cert.pem> <timings.jsonl> <room id>...
import http2 from "node:http2";
import http from "node:http";
import net from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [listen, socketPath, key, cert, timingsFile, ...rooms] = process.argv.slice(2);
if (!rooms.length) throw new Error("usage: node restart-walk-front.mjs <port> <socket> <key> <cert> <timings.jsonl> <room id>...");
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const hop = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "http2-settings", "te", "host"]);
const callsFile = join(dirname(timingsFile), "front-calls.jsonl");
const writable = path => rooms.some(room => path === `/api/c/${room}` || path.startsWith(`/api/c/${room}/`)) || path.startsWith("/api/uploads");

const server = http2.createSecureServer({ key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true, settings: { maxConcurrentStreams: 250 } }, (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/api/timings" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      appendFileSync(timingsFile, `${JSON.stringify({ at: Date.now(), ua: req.headers["user-agent"] ?? "", body: Buffer.concat(chunks).toString() })}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"taken":0}');
    });
    return;
  }
  if (!["GET", "HEAD"].includes(req.method) && !writable(path)) {
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `restart walk guard: ${req.method} ${path} refused` }));
    return;
  }
  const call = { m: req.method, p: path, ua: /Chrome\//.test(req.headers["user-agent"] ?? "") ? "chromium" : "webkit", in: Date.now() };
  res.on("close", () => {
    call.out = Date.now();
    appendFileSync(callsFile, `${JSON.stringify(call)}\n`);
  });
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!name.startsWith(":") && !hop.has(name)) headers[name] = value;
  headers.host = "127.0.0.1:5184";
  const up = http.request({ socketPath, method: req.method, path: req.url, headers, agent }, answer => {
    call.head = Date.now();
    call.s = answer.statusCode;
    const out = {};
    for (const [name, value] of Object.entries(answer.headers)) if (!hop.has(name)) out[name] = value;
    res.writeHead(answer.statusCode, out);
    answer.on("aborted", () => reset(res));
    answer.on("error", () => reset(res));
    answer.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) {
      // Go's ReverseProxy answers a failed dial with a bare 502: no body and no content type.
      res.writeHead(502);
      res.end();
    } else reset(res);
  });
  req.pipe(up);
});

function reset(res) {
  if (res.stream) res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  else res.destroy();
}

server.on("upgrade", (req, socket, head) => {
  const ws = { kind: "ws", p: (req.url ?? "/").split("?")[0], ua: /Chrome\//.test(req.headers["user-agent"] ?? "") ? "chromium" : "webkit", in: Date.now(), bytesUp: head?.length ?? 0, bytesDown: 0 };
  socket.once("close", () => {
    ws.out = Date.now();
    appendFileSync(callsFile, `${JSON.stringify(ws)}\n`);
  });
  const up = net.connect(socketPath, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).map(([name, value]) => `${name}: ${value}`), "", ""];
    up.write(lines.join("\r\n"));
    if (head?.length) up.write(head);
    up.on("data", chunk => { ws.bytesDown += chunk.length; });
    up.pipe(socket);
    // Counted here, not before the dial, because a data listener starts the flow and bytes sent before the pipe would be lost.
    socket.on("data", chunk => { ws.bytesUp += chunk.length; });
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  up.on("close", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(Number(listen), "127.0.0.1", () => console.log(`restart walk front https://127.0.0.1:${listen} -> ${socketPath}`));
