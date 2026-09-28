import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const execute = promisify(execFile);
function getStatus(url: string, headers: Record<string, string>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
}
/** fetch drops a custom Host header, so requests that arrive through the remote name go through node:http. */
function viaHost(url: string, { method = "GET", headers, body, until }: { method?: string; headers: Record<string, string>; body?: string; until?: RegExp }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; if (until?.test(text)) { req.destroy(); resolve({ status: res.statusCode ?? 0, text }); } });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.setTimeout(10000, () => req.destroy(new Error("No response within 10 s.")));
    req.on("error", error => { if (!until?.test("")) reject(error); });
    req.end(body);
  });
}
async function unusedChatPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("standalone CLI converges concurrent starts, preserves its URL, and stops only its own listener", { timeout: 120000 }, async () => {
  const artifacts = process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(root, "components/user-history/.test-artifacts");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "service-"));
  const data = join(directory, "browser-chat");
  const socket = join(directory, "absent.sock");
  const port = await unusedChatPort();
  const env = { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: join(directory, "profile") };
  const run = async (command: string, extra: string[] = []) => (await execute(process.execPath,
    [join(root, "scripts/cli.mjs"), "chat", command, "--data-dir", data, ...extra], { env, timeout: 25000 })).stdout.trim();
  const flags = ["--port", String(port), "--socket", socket];
  try {
    const urls = await Promise.all([run("start", flags), run("start", flags)]);
    assert.equal(urls[0], urls[1]);
    const url = urls[0]; assert(url);
    assert.equal(new URL(url).port, String(port));
    assert.equal(await run("url"), url);
    assert.match(await run("status"), /Chat is running/);
    const first = await (await fetch(url + "api/identity")).json();
    assert.equal(await run("start", flags), url);
    assert.deepEqual(await (await fetch(url + "api/identity")).json(), first);
    assert.equal((await fetch(new URL("/", url), { redirect: "manual" })).status, 404);
    const typed = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    // fetch sets its own Sec-Fetch-Mode, so these two go through node:http like a browser navigation.
    const rootGet = (headers: Record<string, string>) => new Promise<{ status: number; location?: string | undefined }>((done, fail) => {
      request(new URL("/", url), { headers }, response => { response.resume(); done({ status: response.statusCode ?? 0, location: response.headers.location }); }).on("error", fail).end();
    });
    const opened = await rootGet(typed);
    assert.equal(opened.status, 302, "a typed or bookmarked root URL opens the chat");
    assert.equal(new URL(opened.location ?? "", url).href, url);
    assert.equal((await rootGet({ ...typed, "Sec-Fetch-Site": "cross-site" })).status, 404, "another site never learns the path");
    assert.equal((await fetch(url)).status, 200, "page renders without native daemon");
    const extra = await (await fetch(url + "api/remote")).json();
    assert.equal(extra.mode, "off", "an instance outside ~/.prime/agent/browser-chat never turns on Tailscale by itself");
    assert.equal(extra.keepRunning.available, false, "only the main instance installs a login item");
    assert.equal((await fetch(url + "api/sessions")).status, 404, "the polling list route is gone; the list is a stream");
    assert.equal((await fetch(url + "app.js")).status, 200, "the bundle is served without native daemon");
    const unavailable = await fetch(url + "api/models");
    assert.equal(unavailable.status, 502, "routes that need the daemon report it as unreachable");
    assert.match((await unavailable.json()).error, /daemon is not reachable/);
    for (const file of ["configuration.json", "instance.json", "service.log"]) assert.equal((await stat(join(data, file))).mode & 0o777, 0o600);
    const configuration = JSON.parse(await readFile(join(data, "configuration.json"), "utf8"));
    const headers = { "Content-Type": "application/json", Origin: new URL(url).origin };
    assert.equal((await fetch(url + "api/service-stop", { method: "POST", headers, body: "{}" })).status, 403);
    assert.equal((await fetch(url + "api/service-stop", { method: "POST", headers: { ...headers, "X-Chat-Stop-Token": configuration.csrfToken }, body: "{}" })).status, 403);
    assert.equal((await fetch(url + "api/service-stop", { method: "POST", headers: { ...headers, "X-Chat-Stop-Token": configuration.stopToken }, body: JSON.stringify({ instanceId: "wrong" }) })).status, 409);
    assert.equal((await fetch(url + "api/service-stop", { method: "POST", headers: { ...headers, Origin: "https://evil.example", "X-Chat-Stop-Token": configuration.stopToken }, body: JSON.stringify({ instanceId: first.instanceId }) })).status, 403);
    await assert.rejects(run("start", ["--port", String(port === 65535 ? port - 1 : port + 1), "--socket", socket]), /Chat configuration uses/);
    await assert.rejects(run("start", ["--socket", socket + ".other"]), /Chat configuration uses/);
    assert.equal((await fetch(url + "api/identity")).status, 200);
    await writeFile(join(data, "instance.json"), JSON.stringify({ ...first, url, pid: process.pid }));
    await assert.rejects(run("stop"), /does not match the private chat instance/);
    assert.equal((await fetch(url + "api/identity")).status, 200);
    await writeFile(join(data, "instance.json"), JSON.stringify({ ...first, url }));
    await run("stop");
    await assert.rejects(fetch(url));
    assert.match(await run("status"), /Chat is stopped/);
    assert.equal(await run("url"), url);
    assert.equal(await run("start", flags), url);
    const restarted = await (await fetch(url + "api/identity")).json();
    assert.notEqual(restarted.instanceId, first.instanceId);
    assert.equal((await (await fetch(url + "api/identity")).json()).pid, restarted.pid);
    process.kill(restarted.pid, "SIGKILL");
    assert.match(await run("status"), /Chat is stopped/);
    assert.equal(await run("start", flags), url, "a stale instance record never blocks a new listener");
    assert.notEqual((await (await fetch(url + "api/identity")).json()).instanceId, restarted.instanceId);
    await run("stop");
    const publicOrigin = "https://chat.example.ts.net";
    assert.equal(await run("start", [...flags, "--public-origin", publicOrigin + "/"]), url);
    const remote = { Host: new URL(publicOrigin).host, Origin: publicOrigin };
    assert.equal((await (await fetch(url + "api/remote")).json()).mode, "custom", "an explicit origin on an extra instance stays fixed");
    const page = await viaHost(url, { headers: remote });
    assert.equal(page.status, 200);
    assert.match(page.text, /Prime Agent chat/);
    assert.equal((await viaHost(url + "app.js", { headers: remote })).status, 200);
    assert.equal((await viaHost(new URL("/", url).href, { headers: remote })).status, 404);
    assert.equal((await viaHost(url, { headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await viaHost(url, { headers: { Host: "evil.example", "X-Forwarded-Host": remote.Host, "X-Forwarded-Proto": "https" } })).status, 421);
    assert.equal((await viaHost(url, { headers: { ...remote, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await viaHost(url, { headers: { ...remote, Origin: publicOrigin.replace("https:", "http:") } })).status, 403);
    assert.equal((await viaHost(url, { headers: { ...remote, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url, { headers: { Origin: publicOrigin } })).status, 403);
    const navigation = { Host: remote.Host, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    assert.equal(await getStatus(url, navigation), 200, "a link from another site can open the private chat page");
    assert.equal(await getStatus(url + "api/labels", navigation), 403);
    const writeHeaders = { ...remote, "Content-Type": "application/json", "X-Chat-Token": configuration.csrfToken };
    const createLabel = () => viaHost(url + "api/labels", { method: "POST", headers: writeHeaders, body: JSON.stringify({ op: "create", name: "Remote test", ids: [] }) });
    assert.equal((await createLabel()).status, 200, "remote writes accept the configured HTTPS origin and page token");
    assert.equal((await viaHost(url + "api/labels", { method: "POST", headers: { ...remote, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await viaHost(url + "api/labels", { method: "POST", headers: { Host: remote.Host, "Content-Type": "application/json", "X-Chat-Token": configuration.csrfToken }, body: "{}" })).status, 403);
    assert.equal((await viaHost(url + "api/service-stop", { method: "POST", headers: { ...writeHeaders, "X-Chat-Stop-Token": configuration.stopToken }, body: "{}" })).status, 403);
    assert.equal((await viaHost(url + "api/remote", { method: "POST", headers: writeHeaders, body: JSON.stringify({ tailscale: false }) })).status, 403, "phone access changes only on the Mac");
    const stream = await viaHost(url + "api/sessions/stream", { headers: remote, until: /event: build/ });
    assert.equal(stream.status, 200);
    assert.match(stream.text, /event: build/);
    await assert.rejects(run("start", [...flags, "--public-origin", "https://different.example"]), /Stop chat before changing/);
    await run("stop");
    assert.equal(await run("start", flags), url);
    assert.equal((await viaHost(url, { headers: remote })).status, 200, "the external origin persists across restart");
    await run("stop");
    assert.equal(await run("start", [...flags, "--public-origin", "none"]), url);
    assert.equal((await viaHost(url, { headers: remote })).status, 421);
    assert.equal((await fetch(url)).status, 200);
    await run("stop");
    const foreground = spawn(process.execPath, [join(root, "scripts/cli.mjs"), "chat", "serve", "--data-dir", data, ...flags], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>(resolve => foreground.once("exit", resolve));
    try {
      const printed = await new Promise<string>((resolve, reject) => {
        let output = ""; let errors = "";
        const timer = setTimeout(() => reject(new Error("Foreground URL was not printed. " + errors)), 10000);
        foreground.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
        foreground.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("\n")) { clearTimeout(timer); resolve(output.trim()); }
        });
        foreground.once("error", error => { clearTimeout(timer); reject(error); });
        foreground.once("exit", () => { clearTimeout(timer); reject(new Error(errors)); });
      });
      assert.equal(printed, url);
      assert.equal(await run("start", flags), url);
      await run("stop");
      assert.equal(await exited, 0);
    } finally { if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill(); }
    const occupant = createServer((_req, response) => { response.writeHead(404); response.end("unrelated"); });
    await new Promise<void>(resolve => occupant.listen(port, "127.0.0.1", resolve));
    try {
      await assert.rejects(run("start", flags), /occupied by an unverified service/);
      assert.equal(await (await fetch(url)).text(), "unrelated");
    } finally { await new Promise<void>(resolve => occupant.close(() => resolve())); }
    await writeFile(join(directory, "result.json"), JSON.stringify({ passed: true, port, url, first, restarted }));
  } finally { await run("stop"); }
});

test("extension has no browser executor or session-owned server", async () => {
  const source = await readFile(join(root, "components/user-history/extension/index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.exec|session_shutdown|startChatServer|Aside|asideExecutable/);
  assert.match(source, /ctx\.ui\.notify\(service\.url/);
});
