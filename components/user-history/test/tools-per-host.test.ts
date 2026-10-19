import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, type CheckReport, type Deps, hostChecks } from "../scripts/duties/skills-and-tools.ts";
import { sshChecks, toolChecks } from "../src/chat-tools.ts";
import { parseHosts, type Host, type HostsRegistry } from "../src/hosts.ts";

const host = (name: string, hostname: string, address: string, tools?: string[]) => ({
  name, hostname, address, relayPort: 7790, token: `file:relay-tokens/${name}`, daemonSocket: "/tmp/daemon.sock", ssh: `me@${address}`, roles: {},
  ...(tools ? { tools } : {}),
});
const registry = (self: string): HostsRegistry => parseHosts({ version: 1, hosts: [
  host("box", self, "100.0.0.1", ["websearch", "headless-browser", "aside", "cua-driver"]),
  host("mac", "Sieuns-MacBook-Pro", "100.0.0.2", ["aside", "cua-driver", "websearch"]),
] });

/** Deps whose every program answers nothing, so each local check fails fast; the tests read which checks ran, not their verdicts. */
const deps = (): Deps => ({
  exec: async () => ({ code: 1, stdout: "", stderr: "fake", ms: 0 }),
  mcp: async () => ({ tools: [], error: "fake" }),
  readFile: async () => "{}",
  writeFile: async () => {},
  rm: async () => {},
  exists: async () => false,
  realpath: async path => path,
  list: async () => [],
  loadResolver: async () => async () => undefined,
  home: "/home/me",
  repo: "/repo",
  scratchDir: "/tmp",
  now: () => 0,
  platform: "linux",
});

test("hosts.json takes a host's tools list and refuses a tool it does not know", () => {
  assert.deepEqual(registry("box").hosts[1]!.tools, ["aside", "cua-driver", "websearch"]);
  assert.equal(parseHosts({ version: 1, hosts: [host("box", "box", "100.0.0.1")] }).hosts[0]!.tools, undefined);
  assert.throws(() => parseHosts({ version: 1, hosts: [host("box", "box", "100.0.0.1", ["paper"])] }), /tools: needs a list of websearch, headless-browser, aside, cua-driver/);
});

test("the daily run leaves out the checks for tools this box is not meant to have", async () => {
  const mac = await hostChecks(async () => ({ version: 1, hosts: [{ ...registry("x").hosts[1]!, hostname: (await import("node:os")).hostname() }] }));
  assert.ok(!mac.some(check => check.id === "box_browser"));
  assert.ok(mac.some(check => check.id === "aside_tabs") && mac.some(check => check.id === "prime_daemon"));
  const missing = await hostChecks(async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  assert.equal(missing.length, CHECKS.length);
});

test("each box gets its own tools: this box's run here, the others over the remote call, and a tool a box does not use is never checked", async () => {
  const self = (await import("node:os")).hostname();
  const asked: { host: string; ids: readonly string[] }[] = [];
  const remote = async (target: Host, ids: readonly string[]): Promise<CheckReport[]> => {
    asked.push({ host: target.name, ids });
    return ids.map(id => ({ id, group: "browser", tool: id, status: "pass", detail: `${id} on ${target.name}`, ms: 5 }));
  };
  const view = await toolChecks({ deps: deps(), load: async () => registry(self), remote, tailscale: async () => null }).view(true);
  assert.deepEqual(view.hosts.map(card => [card.name, card.self, card.state]), [["box", true, "checked"], ["mac", false, "checked"]]);
  assert.deepEqual(asked, [{ host: "mac", ids: ["cua_permissions", "cua_mcp", "websearch_kernel", "websearch_query", "aside_tabs", "aside_account"] }]);
  const mac = view.hosts[1]!;
  assert.deepEqual(mac.tools.map(row => [row.tool, row.used]), [["websearch", true], ["headless-browser", false], ["aside", true], ["cua-driver", true]]);
  const aside = mac.tools.find(row => row.tool === "aside")!;
  assert.ok(aside.used && aside.checks.map(check => check.detail).join() === "aside_tabs on mac,aside_account on mac", JSON.stringify(aside));
  const box = view.hosts[0]!;
  assert.ok(box.tools.every(row => row.used));
  const browser = box.tools.find(row => row.tool === "headless-browser")!;
  assert.ok(browser.used && browser.checks.length === 1 && browser.checks[0]!.id === "box_browser" && browser.checks[0]!.status === "fail");
});

test("a box Tailscale reads offline is not dialed, and a remote run that breaks marks only that box unreachable", async () => {
  const self = (await import("node:os")).hostname();
  const status = JSON.stringify({ Peer: { a: { TailscaleIPs: ["100.0.0.2"], Online: false, LastSeen: new Date(-3_600_000).toISOString() } } });
  let dialed = 0;
  const offline = await toolChecks({ deps: deps(), load: async () => registry(self), remote: async () => { dialed++; return []; }, tailscale: async () => status, now: () => 0 }).view(true);
  const mac = offline.hosts[1]!;
  assert.equal(dialed, 0);
  assert.ok(mac.state === "unreachable" && /offline \(Tailscale last seen 1h ago\)/.test(mac.error), JSON.stringify(mac));
  assert.ok(mac.tools.every(row => !row.used || row.checks.length === 0));
  const broken = await toolChecks({ deps: deps(), load: async () => registry(self), remote: async () => { throw new Error("ssh mac exit 255"); }, tailscale: async () => null }).view(true);
  assert.equal(broken.hosts[0]!.state, "checked");
  assert.ok(broken.hosts[1]!.state === "unreachable" && broken.hosts[1]!.error === "ssh mac exit 255");
});

test("without hosts.json the list is this box alone with every tool", async () => {
  const view = await toolChecks({ deps: deps(), load: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, remote: async () => [] }).view(true);
  assert.equal(view.hosts.length, 1);
  assert.equal(view.registryError, null);
  assert.ok(view.hosts[0]!.self && view.hosts[0]!.tools.every(row => row.used));
});

test("sshChecks runs the box's own checkout with --results and reads its JSON line", async () => {
  const calls: string[][] = [];
  const report: CheckReport = { id: "aside_tabs", group: "browser", tool: "Aside browser MCP", status: "pass", detail: "4 tabs", ms: 900 };
  const run = sshChecks(async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: `warning\n${JSON.stringify([report])}\n`, stderr: "", ms: 1 }; });
  const target = registry("box").hosts[1]!;
  assert.deepEqual(await run(target, ["aside_tabs"]), [report]);
  assert.equal(calls[0]![0], "ssh");
  assert.ok(calls[0]!.includes("me@100.0.0.2"));
  assert.match(calls[0]!.at(-1)!, /\$\(sieun-pi source\)\/components\/user-history.*skills-and-tools\.ts --results --only aside_tabs$/);
  const failed = sshChecks(async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host 100.0.0.2 port 22: Connection timed out", ms: 1 }));
  await assert.rejects(failed(target, ["aside_tabs"]), /ssh mac exit 255: ssh: connect to host/);
});
