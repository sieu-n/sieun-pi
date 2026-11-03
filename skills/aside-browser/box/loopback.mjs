// The tunnel a box runner opens when a kernel on the owner's Mac starts it over ssh (BOX_LOOPBACK_VIA=<the Mac's ssh host>).
// `ssh -D` opens a SOCKS5 port whose connections open on the Mac, so localhost:5180 and cc.localhost:5180 in a box tab are the
// Mac's own dev servers while the page renders here. Chrome reaches that port through an HTTPS proxy in this process that speaks
// HTTP/2, because Chrome keeps 6 HTTP/1.1 connections per host and a SOCKS proxy gets no more. 5180's /app/inbox loads about 875
// Vite modules in import waves at a 190 ms round trip: on 11-03 a box Chrome on plain SOCKS hydrated it 25 to 40 s after a reload,
// and through this proxy, where one HTTP/2 connection carries every request at once, 8 to 10 s.
// The ssh uses its own compressed connection, never a ControlMaster's. A runner's ssh that became a master forked into the
// background, where --pdeathsig no longer reached it, and on 11-03 one such master sat orphaned for 2 h holding its -D port, and a
// later ssh -D to the Mac handed its forward to that master instead of opening its own. Compression took a curl of the page's 698
// modules over SOCKS from 11.9 s to 3.7 s at 80 parallel requests, since one ssh connection to the Mac moved about 1.8 MB/s.
// The ssh client dies with the runner (setpriv --pdeathsig).
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const accepts = (port) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.once("connect", () => { c.destroy(); resolve(true); });
  c.once("error", () => resolve(false));
});

async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function startSsh(host) {
  const port = await freePort();
  const proc = spawn("setpriv", ["--pdeathsig", "KILL", "--", "ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "Compression=yes", "-D", `127.0.0.1:${port}`, host], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  proc.stderr.on("data", (d) => { log += d; });
  // ssh binds the port only after it has logged in, so the wait ends at the first accepted connect or when ssh exits.
  while (!(await accepts(port))) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`ssh -D to ${host} exited (${proc.exitCode ?? proc.signalCode}): ${log.slice(-500)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proc.stderr.unref();
  return { port, proc };
}

/** Opens a TCP connection to host:port on the Mac through the SOCKS5 port; calls back with the connected socket. */
function socksConnect(socksPort, host, port, callback) {
  const sock = net.connect(socksPort, "127.0.0.1");
  const name = Buffer.from(host);
  let buf = Buffer.alloc(0);
  let step = 0;
  const fail = (err) => { sock.destroy(); callback(err); };
  sock.once("connect", () => sock.write(Buffer.from([5, 1, 0])));
  sock.on("error", (err) => { if (step < 2) fail(err); });
  sock.on("data", function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (step === 0 && buf.length >= 2) {
      if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error("SOCKS5 refused the no-auth method"));
      buf = buf.subarray(2);
      step = 1;
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    }
    if (step === 1 && buf.length >= 5) {
      if (buf[1] !== 0) return fail(new Error(`SOCKS5 connect to ${host}:${port} failed (${buf[1]})`));
      const size = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
      if (buf.length < size) return;
      sock.off("data", onData);
      step = 2;
      if (buf.length > size) sock.unshift(buf.subarray(size));
      callback(null, sock);
    }
  });
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "host", "http2-settings"]);
const plain = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(":") && !HOP.has(k)));
const hostPort = (authority, fallback) => {
  const u = new URL(`http://${authority}`);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || fallback) };
};

// Vite closes a keep-alive socket after 5 s idle, and that close takes a round trip to reach this side, so a request sent on a
// socket the Mac already closed gets ECONNRESET. Chrome resends such a request itself; this proxy does the same for a GET or HEAD,
// because a failed module fetch stops the whole SvelteKit start and the page never hydrates.
function forward(stream, headers, agent, attempt) {
  const authority = headers[":authority"];
  const { host, port } = hostPort(authority, 80);
  const method = headers[":method"];
  const req = http.request({ host, port, method, path: headers[":path"], headers: { ...plain(headers), host: authority }, agent }, (res) => {
    if (stream.destroyed) { res.destroy(); return; }
    stream.respond({ ":status": res.statusCode, ...plain(res.headers) });
    res.pipe(stream);
  });
  req.on("error", () => {
    if (stream.destroyed) return;
    if (req.reusedSocket && attempt === 0 && (method === "GET" || method === "HEAD")) { forward(stream, headers, agent, 1); return; }
    if (!stream.headersSent) stream.respond({ ":status": 502 });
    stream.end();
  });
  stream.once("close", () => req.destroy());
  if (method === "GET" || method === "HEAD") req.end();
  else stream.pipe(req);
}

function startProxy(socksPort) {
  const agent = new http.Agent({ keepAlive: true });
  agent.createConnection = (options, callback) => { socksConnect(socksPort, options.host, options.port, callback); };
  const { key, cert, spkiHash } = selfSigned();
  // Chrome resets every open stream of a page it reloads or leaves, and nghttp2 ends a session whose client resets more streams than its
  // rapid-reset bucket allows (burst 1000, then 33/s). measured: on 11-03 one box Chrome sent 2,010 RST_STREAM frames in 5 reloads of
  // 5180's /app/inbox, nghttp2 ended the session, and every module fetch in flight failed, so the page never hydrated. This proxy
  // listens on 127.0.0.1 for its own Chrome only, so the bucket is set to the largest value Node takes, which turns it off.
  const server = http2.createSecureServer({ key, cert, streamResetBurst: 2 ** 32 - 1, streamResetRate: 2 ** 32 - 1 });
  server.on("sessionError", () => {});
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    const authority = headers[":authority"];
    if (headers[":method"] === "CONNECT") {
      const { host, port } = hostPort(authority, 443);
      socksConnect(socksPort, host, port, (err, sock) => {
        if (err) { if (!stream.destroyed) { stream.respond({ ":status": 502 }); stream.end(); } return; }
        if (stream.destroyed) { sock.destroy(); return; }
        stream.respond({ ":status": 200 });
        sock.on("error", () => stream.destroy());
        stream.on("close", () => sock.destroy());
        stream.pipe(sock).pipe(stream);
      });
      return;
    }
    forward(stream, headers, agent, 0);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, agent, spkiHash, port: server.address().port })));
}

// A throwaway certificate per runner. Chrome trusts it through --ignore-certificate-errors-spki-list with its key's hash, which
// trusts this one key and no other bad certificate.
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopback-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30", "-subj", "/CN=127.0.0.1",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    const cert = fs.readFileSync(path.join(dir, "cert.pem"));
    const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
    return { key: fs.readFileSync(path.join(dir, "key.pem")), cert, spkiHash: createHash("sha256").update(spki).digest("base64") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Starts `ssh -D` to `host` and the HTTP/2 proxy in front of it; resolves with Playwright's proxy option and Chrome's args once both take connections. */
export async function startLoopbackTunnel(host) {
  const ssh = await startSsh(host);
  const proxy = await startProxy(ssh.port);
  return {
    proxy: { server: `https://127.0.0.1:${proxy.port}`, bypass: "<-loopback>" },
    args: [`--ignore-certificate-errors-spki-list=${proxy.spkiHash}`],
    close: () => { proxy.server.close(); proxy.agent.destroy(); ssh.proc.kill("SIGKILL"); },
  };
}
