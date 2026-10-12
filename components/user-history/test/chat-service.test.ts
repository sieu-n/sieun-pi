import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { reapServeOnExit } from "./serve-reaper.mjs";

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
  const reaper = reapServeOnExit(directory);
  const data = join(directory, "browser-chat");
  const socket = join(directory, "absent.sock");
  const port = await unusedChatPort();
  // Every chat instance starts a usage worker that ingests the transcripts under HOME (src/usage/sources.ts); with the owner's HOME each start
  // re-read ~/.codex, ~/.claude and ~/.prime/agent, tens of GB, and a full test run starved for CPU.
  const home = join(directory, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, PRIME_AGENT_CODING_AGENT_DIR: join(directory, "profile") };
  const run = async (command: string, extra: string[] = []) => (await execute(process.execPath,
    [join(root, "scripts/cli.mjs"), "chat", command, "--data-dir", data, ...extra], { env, timeout: 25000 })).stdout.trim();
  const flags = ["--port", String(port), "--socket", socket, "--no-adopt"];
  try {
    const urls = await Promise.all([run("start", flags), run("start", flags)]);
    assert.equal(urls[0], urls[1]);
    const url = urls[0]; assert(url);
    assert.equal(new URL(url).port, String(port));
    assert.equal(await run("url"), url);
    assert.match(await run("status"), /Chat is running/);
    assert.match(await readFile(join(data, "service.log"), "utf8"), /acts only on the chats it created/, "a test serve never adopts live chats");
    await assert.rejects(run("status", ["--no-adopt"]), /with chat start or serve/);
    await assert.rejects(run("start", [...flags, "--adopt-live"]), /--no-adopt or --adopt-live, not both/);
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
    assert.equal(configuration.daemonGateChat, undefined, "a new configuration names no daemon gate chat");
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
    await writeFile(join(data, "configuration.json"), JSON.stringify({ ...configuration, daemonGateChat: 7 }));
    await assert.rejects(run("start", flags), /daemonGateChat is a chat id or null/);
    await writeFile(join(data, "configuration.json"), JSON.stringify({ ...configuration, daemonGateChat: "chat-vp" }));
    const publicOrigin = "https://chat.example.ts.net";
    assert.equal(await run("start", [...flags, "--public-origin", publicOrigin + "/"]), url);
    const saved = JSON.parse(await readFile(join(data, "configuration.json"), "utf8"));
    assert.deepEqual([saved.publicOrigin, saved.daemonGateChat], [publicOrigin, "chat-vp"], "a settings save keeps the hand-set daemon gate chat");
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
  } finally {
    try { await run("stop"); } finally { await reaper.stop(); }
  }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a failed or hung chat start leaves no serve behind, and chat stop ends a serve that never answered", { timeout: 400000 }, async () => {
  const artifacts = process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(root, "components/user-history/.test-artifacts");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "service-silent-"));
  const reaper = reapServeOnExit(directory);
  const data = join(directory, "browser-chat");
  const home = join(directory, "home");
  await mkdir(home);
  const pidFile = join(directory, "serve.pid");
  const fixture = pathToFileURL(join(root, "components/user-history/test/fixtures/silent-serve.mjs")).href;
  const env = (mode: "hang" | "fail") => ({ ...process.env, HOME: home, PRIME_AGENT_CODING_AGENT_DIR: join(directory, "profile"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${fixture}`.trim(), SILENT_SERVE_MODE: mode, SILENT_SERVE_PID_FILE: pidFile,
    // The failing serve must reach its listen call before chat start gives up; a hung one is given up on after 8 s.
    SIEUN_PI_CHAT_START_TIMEOUT_MS: mode === "hang" ? "8000" : "120000" });
  const flags = ["--port", String(await unusedChatPort()), "--socket", join(directory, "absent.sock"), "--no-adopt"];
  const run = async (mode: "hang" | "fail", command: string, extra: string[] = []) => (await execute(process.execPath,
    [join(root, "scripts/cli.mjs"), "chat", command, "--data-dir", data, ...extra], { env: env(mode), timeout: 150000 })).stdout.trim();
  const servePid = async () => Number(await readFile(pidFile, "utf8"));
  const recorded = async () => (await readdir(join(data, "serves")).catch(() => [])).map(Number);
  try {
    await assert.rejects(run("fail", "start", flags), /EACCES/);
    const failed = await servePid();
    assert.equal(alive(failed), false, "a serve that reported an error is gone when chat start returns");
    assert.deepEqual(await recorded(), [], "the failed serve removed its record");

    await rm(pidFile);
    await assert.rejects(run("hang", "start", flags), /timed out after 8 s/);
    const hung = await servePid();
    assert.equal(alive(hung), false, "a serve that never answered is ended when chat start times out");

    // A serve whose starter died with it (a killed terminal, a crashed start): nothing waits on it, and it never wrote instance.json.
    await rm(pidFile);
    const orphan = spawn(process.execPath, [join(root, "components/user-history/src/chat-service-cli.mjs"), "serve", "--data-dir", data, ...flags],
      { env: env("hang"), detached: true, stdio: "ignore" });
    orphan.unref();
    assert(orphan.pid);
    for (let waited = 0; !(await recorded()).includes(orphan.pid); waited += 200) {
      assert(waited < 60000, "the orphan serve recorded itself");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await assert.rejects(access(join(data, "instance.json")));
    assert.match(await run("hang", "status"), new RegExp(`Chat is stopped\\.[\\s\\S]*never answered runs as PID ${orphan.pid}\\.`));
    assert.equal(await run("hang", "stop"), `Chat is stopped. Ended a chat process that never answered (PID ${orphan.pid}).`);
    assert.equal(alive(orphan.pid), false);
    assert.doesNotMatch(await run("hang", "status"), /never answered/);
    assert.equal(await run("hang", "stop"), "Chat is stopped.");
  } finally {
    assert.deepEqual(await reaper.stop(), [], "no serve was left for the reaper");
  }
});

test("extension has no browser executor or session-owned server", async () => {
  const source = await readFile(join(root, "components/user-history/extension/index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.exec|session_shutdown|startChatServer|Aside|asideExecutable/);
  assert.match(source, /ctx\.ui\.notify\(service\.url/);
});
