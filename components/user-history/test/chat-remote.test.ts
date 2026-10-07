import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccess, type CommandResult, type RemoteControl, type Runner } from "../src/chat-remote.ts";
import { AUTOSTART_LABEL, KeepRunning, launchAgentPlist } from "../src/chat-autostart.ts";
import { parseRemoteFlag } from "../src/chat-origin.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { RemoteAccessInput, RemoteAccessView } from "../src/shared/types.ts";

const DNS = "mac.tail0000.ts.net";
/** fetch drops a custom Host header, so requests that arrive through the tailnet name go through node:http. */
function viaHost(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      let text = ""; res.setEncoding("utf8").on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr, timedOut: false });

/** A fake `tailscale` CLI that keeps a serve config in memory and records every call. */
function fakeTailscale(state: { backend?: string; certs?: boolean; handlers?: Record<string, unknown>; tcpForward?: boolean; serveError?: string } = {}) {
  const calls: string[][] = [];
  let handlers: Record<string, unknown> = { ...(state.handlers ?? {}) };
  const run: Runner = async (_file, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "status --json") return ok(JSON.stringify({ BackendState: state.backend ?? "Running", Self: { DNSName: DNS + "." }, CertDomains: state.certs === false ? [] : [DNS] }));
    if (key === "serve status --json") {
      if (state.tcpForward) return ok(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }));
      return ok(Object.keys(handlers).length ? JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: handlers } } }) : "{}");
    }
    if (args[0] === "serve" && args.includes("--bg")) {
      if (state.serveError) return fail(state.serveError);
      handlers = { ...handlers, "/": { Proxy: args.at(-1) } }; return ok("Serve started");
    }
    if (key === "serve --https=443 --set-path=/ off") { const { "/": _removed, ...rest } = handlers; handlers = rest; return ok(); }
    return fail("unexpected " + key);
  };
  return { run, calls, handlers: () => handlers };
}

function remoteFor(fake: ReturnType<typeof fakeTailscale>, options: { mode?: "tailscale" | "off" | "custom"; origin?: string | null; answers?: boolean } = {}) {
  const saved: { mode: string; origin: string | null }[] = [];
  const fetchStub = (async (url: string | URL) => {
    assert.equal(String(url), `${options.origin && options.mode === "custom" ? options.origin : "https://" + DNS}/cap/api/identity`);
    if (options.answers === false) throw new Error("connect ETIMEDOUT");
    return new Response(JSON.stringify({ service: "sieun-pi-chat", instanceId: "me" }));
  }) as typeof fetch;
  const remote = new RemoteAccess({ port: 5182, capability: "cap", mode: options.mode ?? "tailscale", origin: options.origin ?? null,
    save: async value => { saved.push(value); }, identity: async () => ({ instanceId: "me" }), run: fake.run, tailscale: async () => "/usr/local/bin/tailscale", fetch: fetchStub });
  return { remote, saved };
}

test("tailscale mode adds the root Serve handler once, learns the tailnet origin and proves it end to end", async () => {
  const fake = fakeTailscale();
  const { remote, saved } = remoteFor(fake);
  assert.equal(remote.allowedOrigin(), null);
  const first = await remote.check();
  assert.equal(first.state, "on", first.message);
  assert.equal(first.reachable, true);
  assert.equal(remote.allowedOrigin(), "https://" + DNS);
  assert.deepEqual(saved, [{ mode: "tailscale", origin: "https://" + DNS }]);
  assert.deepEqual(fake.calls.filter(args => args.includes("--bg")), [["serve", "--bg", "--https=443", "http://127.0.0.1:5182"]]);
  await remote.check();
  assert.equal(fake.calls.filter(args => args.includes("--bg")).length, 1, "an existing handler that points here is left alone");
  assert.equal(saved.length, 1, "an unchanged origin is not saved again");
});

test("tailscale mode never replaces a Serve handler that belongs to another app", async () => {
  const fake = fakeTailscale({ handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } });
  const { remote } = remoteFor(fake);
  const result = await remote.check();
  assert.equal(result.state, "problem");
  assert.match(result.message, /already sends https:\/\/mac\.tail0000\.ts\.net\/ to http:\/\/127\.0\.0\.1:3000/);
  assert.equal(fake.calls.some(args => args.includes("--bg")), false);
  assert.equal((await remoteFor(fakeTailscale({ tcpForward: true })).remote.check()).state, "problem", "a raw TCP forwarder on 443 also blocks");
});

test("tailscale mode reports each setup gap in one sentence", async () => {
  assert.match((await remoteFor(fakeTailscale({ backend: "Stopped" })).remote.check()).message, /Tailscale is Stopped on this Mac/);
  assert.match((await remoteFor(fakeTailscale({ certs: false })).remote.check()).message, /HTTPS Certificates/);
  assert.match((await remoteFor(fakeTailscale({ serveError: "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve" })).remote.check()).message,
    /login\.tailscale\.com\/f\/serve/);
  const missing = new RemoteAccess({ port: 5182, capability: "cap", mode: "tailscale", origin: null, save: async () => {}, identity: async () => ({ instanceId: "me" }), tailscale: async () => null });
  assert.match((await missing.check()).message, /not installed/);
  const silent = await remoteFor(fakeTailscale(), { answers: false }).remote.check();
  assert.equal(silent.state, "problem");
  assert.equal(silent.reachable, false);
});

test("turning phone access off removes only this chat's root handler and stops accepting the remote host", async () => {
  const fake = fakeTailscale({ handlers: { "/other": { Proxy: "http://127.0.0.1:4000" } } });
  const { remote, saved } = remoteFor(fake);
  await remote.check();
  const off = await remote.setMode("off");
  assert.equal(off.state, "off");
  assert.equal(remote.allowedOrigin(), null);
  assert.deepEqual(fake.handlers(), { "/other": { Proxy: "http://127.0.0.1:4000" } });
  assert.deepEqual(saved.at(-1), { mode: "off", origin: null });
  const before = fake.calls.length;
  await remote.check();
  assert.equal(fake.calls.length, before, "off never calls tailscale");
  assert.equal((await remote.setMode("tailscale")).state, "on");
  assert.equal(remote.allowedOrigin(), "https://" + DNS);
});

test("custom origins stay fixed and do not call tailscale", async () => {
  const fake = fakeTailscale();
  const { remote } = remoteFor(fake, { mode: "custom", origin: "https://proxy.example" });
  assert.equal(remote.allowedOrigin(), "https://proxy.example");
  assert.equal((await remote.check()).state, "on");
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(parseRemoteFlag("tailscale"), { mode: "tailscale", origin: null });
  assert.deepEqual(parseRemoteFlag("none"), { mode: "off", origin: null });
  assert.deepEqual(parseRemoteFlag("https://proxy.example/"), { mode: "custom", origin: "https://proxy.example" });
  assert.throws(() => parseRemoteFlag("http://proxy.example"));
});

test("the login item plist starts chat at login and restarts it only after a crash", () => {
  const plist = launchAgentPlist({ node: "/opt/node/bin/node", cli: "/src/chat-service-cli.mjs", dataDir: "/Users/me/.prime/agent/browser-chat", port: 5182,
    socketPath: "/tmp/daemon & co.sock", logPath: "/Users/me/.prime/agent/browser-chat/service.log" });
  assert.match(plist, new RegExp(`<string>${AUTOSTART_LABEL.replaceAll(".", "\\.")}</string>`));
  assert.match(plist, /<string>serve<\/string>\s*<string>--supervised<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<string>\/opt\/node\/bin:/);
  assert.match(plist, /daemon &amp; co\.sock/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/, "launchd's background limits made a restart take 10-40 s");
});

test("keep running installs, loads and removes the login item without booting out the server it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-keep-"));
  const plistPath = join(dir, "LaunchAgents", AUTOSTART_LABEL + ".plist");
  let loaded = false;
  const calls: string[][] = [];
  const run: Runner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? ok() : fail("not found");
    if (args[0] === "bootstrap") { loaded = true; return ok(); }
    if (args[0] === "bootout") { loaded = false; return ok(); }
    return ok();
  };
  const saved: boolean[] = [];
  const job = { node: "/opt/node/bin/node", cli: "/src/cli.mjs", dataDir: dir, port: 5182, socketPath: "/tmp/d.sock", logPath: join(dir, "service.log") };
  const keep = (supervised: boolean) => new KeepRunning({ job, enabled: true, save: async value => { saved.push(value); }, run, plistPath, uid: 501, platform: "darwin", supervised });
  const first = await keep(false).reconcile();
  assert.equal(first.state, "on", first.message);
  assert.equal(readFileSync(plistPath, "utf8"), launchAgentPlist(job));
  assert.deepEqual(calls.find(args => args[0] === "bootstrap"), ["bootstrap", "gui/501", plistPath]);
  calls.length = 0;
  await keep(false).reconcile();
  assert.equal(calls.some(args => args[0] === "bootstrap"), false, "a loaded job is not loaded twice");
  const supervised = keep(true);
  assert.equal((await supervised.setEnabled(false)).state, "off");
  assert.deepEqual(saved, [false]);
  assert.equal(existsSync(plistPath), false);
  assert.equal(calls.some(args => args[0] === "bootout"), false, "the job that runs this server is not booted out");
  await keep(false).setEnabled(false);
  assert.equal(loaded, false, "a job that only waits is booted out");
  assert.equal((await new KeepRunning({ job, enabled: true, save: async () => {}, run, plistPath, platform: "linux" }).reconcile()).available, false);
});

test("api/remote shows the phone link, follows origin changes at once, and changes only from loopback", async () => {
  let origin: string | null = "https://" + DNS;
  const inputs: RemoteAccessInput[] = [];
  const view = (editable: boolean): RemoteAccessView => ({ mode: origin ? "tailscale" : "off", state: origin ? "on" : "off", message: "", origin, phoneUrl: origin ? `${origin}/cap/` : null,
    checkedAt: null, reachable: null, editable, keepRunning: { available: true, enabled: true, state: "on", message: "" },
    openAppAtLogin: { available: true, enabled: true, appName: "Prime Agent chat", message: "" } });
  const remote: RemoteControl = { origin: () => origin, view, check: async () => {},
    set: async input => { inputs.push(input); if (input.tailscale === false) origin = null; } };
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap",
    csrfToken: "token", stopToken: "stop", identity: { pid: 1, instanceId: "i", socketPath: "/tmp/s" }, onStop: async () => {}, remote });
  const local = new URL(server.url).origin;
  const remoteHeaders = { Host: DNS, Origin: "https://" + DNS };
  const write = (headers: Record<string, string>, body: unknown) => fetch(server.url + "api/remote", { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Chat-Token": "token", ...headers } });
  try {
    assert.deepEqual(await (await fetch(server.url + "api/remote")).json(), view(true));
    assert.equal((await viaHost(server.url + "api/remote", "GET", remoteHeaders)).json.editable, false);
    const refused = await viaHost(server.url + "api/remote", "POST", { ...remoteHeaders, "Content-Type": "application/json", "X-Chat-Token": "token" }, { tailscale: false });
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /on the Mac/);
    assert.equal((await write({ Origin: local }, { tailscale: "yes" })).status, 400);
    assert.equal((await write({ Origin: local }, {})).status, 400);
    assert.equal((await write({ Origin: local }, { keepRunning: false })).status, 200);
    assert.equal((await write({ Origin: local }, { openAppAtLogin: "no" })).status, 400);
    assert.equal((await write({ Origin: local }, { openAppAtLogin: false })).status, 200);
    assert.equal((await write({ Origin: local }, { tailscale: false })).status, 200);
    assert.deepEqual(inputs, [{ keepRunning: false }, { openAppAtLogin: false }, { tailscale: false }]);
    assert.equal((await viaHost(server.url + "api/remote", "GET", remoteHeaders)).status, 421, "the tailnet host stops working as soon as access is off");
  } finally { await server.close(); }
});
