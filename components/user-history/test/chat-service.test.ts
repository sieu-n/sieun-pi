import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const execute = promisify(execFile);
async function unusedChatPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("standalone CLI converges concurrent starts, preserves its URL, and stops only its own listener", { timeout: 60000 }, async () => {
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
    assert.equal((await fetch(url)).status, 200, "page renders without native daemon");
    const unavailable = await fetch(url + "api/sessions");
    assert.equal(unavailable.status, 502);
    assert.match((await unavailable.json()).error, /Native daemon disconnected/);
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
