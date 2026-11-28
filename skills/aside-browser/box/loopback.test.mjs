// Drives loopback.mjs's HTTP/2 proxy with a fake SOCKS5 port that connects on this host, as `ssh -D` to the Mac does there.
// Run with: node --test --test-force-exit --test-isolation=none skills/aside-browser/box/loopback.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { startProxy } from "./loopback.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

function fakeSocks() {
  return net.createServer((client) => {
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      client.once("data", (req) => {
        const host = req.subarray(5, 5 + req[4]).toString();
        const port = req.readUInt16BE(5 + req[4]);
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(up).pipe(client);
        });
        up.on("error", () => client.destroy());
        client.on("error", () => up.destroy());
      });
    });
  });
}

// A SvelteKit production page sends one modulepreload link per chunk and a server-timing entry per step; each takes half of `kb`.
// Each stays under 64 KB, because nghttp2, which this test's client uses and Chrome does not, refuses a longer header field.
const linkOf = (kb) => Array.from({ length: Math.ceil((kb * 512) / 80) }, (_, i) => `</_app/immutable/chunks/c${String(i).padStart(6, "0")}.js>; rel="modulepreload"; nopush`).join(", ");
const timingOf = (kb) => Array.from({ length: Math.ceil((kb * 512) / 20) }, (_, i) => `step${String(i).padStart(6, "0")};dur=1.25`).join(", ");
const asked = [];
const upstream = http.createServer({ maxHeaderSize: 1 << 20 }, (req, res) => {
  asked.push(req.url);
  const kb = Number(new URL(req.url, "http://x").searchParams.get("kb"));
  res.writeHead(200, { "content-type": "text/plain", link: linkOf(kb), "server-timing": timingOf(kb) });
  res.end(`page ${kb}`);
});
const socks = fakeSocks();
const [upPort, socksPort] = await Promise.all([listen(upstream), listen(socks)]);
const proxy = await startProxy(socksPort);
const session = http2.connect(`https://127.0.0.1:${proxy.port}`, { rejectUnauthorized: false, maxHeaderListSize: 1 << 20 });
after(() => { session.close(); proxy.server.close(); proxy.agent.destroy(); upstream.close(); socks.close(); });

const get = (path) => new Promise((resolve, reject) => {
  const req = session.request({ ":method": "GET", ":scheme": "http", ":authority": `127.0.0.1:${upPort}`, ":path": path });
  let head;
  let body = "";
  req.on("response", (h) => { head = h; });
  req.on("data", (d) => { body += d; });
  req.on("end", () => resolve({ status: head?.[":status"], link: head?.link, timing: head?.["server-timing"], body }));
  req.on("error", reject);
  req.end();
});

test("an answer with 8, 16, 64 and 120 KB of link and server-timing headers passes whole, as Chrome takes up to 256 KB", async () => {
  for (const kb of [8, 16, 64, 120]) {
    const got = await get(`/?kb=${kb}`);
    assert.equal(got.status, 200, `${kb} KB`);
    assert.equal(got.link, linkOf(kb));
    assert.equal(got.timing, timingOf(kb));
    assert.equal(got.body, `page ${kb}`);
  }
});

test("an answer whose headers pass Chrome's 256 KB answers 502 once, with no resend on another pooled socket", async () => {
  await get("/?kb=1");
  asked.length = 0;
  const got = await get("/?kb=300");
  assert.equal(got.status, 502);
  assert.deepEqual(asked, ["/?kb=300"]);
});
