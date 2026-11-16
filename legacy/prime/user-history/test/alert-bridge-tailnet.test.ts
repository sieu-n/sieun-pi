import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { GrafanaError, readGrafanaAlerts } from "../src/alert-bridge.ts";
import { networkFailure } from "../src/alert-bridge-health.ts";

const alert = { fingerprint: "abc", startsAt: "2026-11-16T07:00:00Z", status: { state: "active" }, labels: { alertname: "metal02-dev-silent" }, annotations: {} };
let dir: string;
let tailnet: Server, refusing: Server;
let tailnetUrl: string, deadUrl: string, deniedUrl: string;
const hits: string[] = [];

const listen = (server: Server) => new Promise<string>(done => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "alert-tailnet-"));
  tailnet = createServer((req, res) => { hits.push(`tailnet ${req.headers.authorization}`); res.end(JSON.stringify([alert])); });
  refusing = createServer((_req, res) => { hits.push("denied"); res.statusCode = 401; res.end("{}"); });
  tailnetUrl = await listen(tailnet);
  deniedUrl = await listen(refusing);
  const closed = createServer();
  deadUrl = await listen(closed);
  await new Promise(done => closed.close(done));
});
after(async () => { tailnet.close(); refusing.close(); await rm(dir, { recursive: true, force: true }); });

async function config(value: Record<string, string>): Promise<string> {
  const file = join(dir, `${Object.values(value).join("-").replace(/\W/g, "")}.json`);
  await writeFile(file, JSON.stringify({ token: "tok", ...value }));
  return file;
}

test("a read that gets no answer from url goes to tailnetUrl with the same token", async () => {
  hits.length = 0;
  const alerts = await readGrafanaAlerts(await config({ url: deadUrl, tailnetUrl }));
  assert.deepEqual(alerts?.map(a => a.alertname), ["metal02-dev-silent"]);
  assert.deepEqual(hits, ["tailnet Bearer tok"]);
});

test("an HTTP answer from url stands, so a refused token never reads through the tailnet", async () => {
  hits.length = 0;
  await assert.rejects(readGrafanaAlerts(await config({ url: deniedUrl, tailnetUrl })), (error: unknown) => error instanceof GrafanaError && error.status === 401);
  assert.deepEqual(hits, ["denied"]);
});

test("when both paths get no answer the error names both and still reads as a network failure", async () => {
  const error = await readGrafanaAlerts(await config({ url: deadUrl, tailnetUrl: deadUrl.replace("127.0.0.1", "127.0.0.2") })).then(() => null, (e: unknown) => e as Error);
  assert.ok(error);
  assert.match(error.message, /ECONNREFUSED.*; through http:\/\/127\.0\.0\.2:\d+: .*ECONNREFUSED/);
  assert.ok(networkFailure({ at: 0, status: null, message: error.message }));
});

test("without tailnetUrl the url's own error comes back", async () => {
  await assert.rejects(readGrafanaAlerts(await config({ url: deadUrl })), (error: unknown) => error instanceof TypeError);
});
