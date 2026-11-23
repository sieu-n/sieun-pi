/**
 * GET /api/hosts shows each box's agent relay link as the chat server's `RelayHost` holds it (server/usage.ts), against a fake relay.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/hosts-link.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { HostsReport, HostView } from "../../web/src/lib/api/types.ts";
import { App } from "../../server/app.ts";
import { fixtureFolders, readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { MultiHost } from "../../server/host/multi-host.ts";
import { RelayHost } from "../../server/host/relay-host.ts";
import { serve } from "../../server/http.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { FakeRelay } from "./fake-relay.ts";
import { until } from "./helpers.ts";

const TOKEN = "test-token";
let dataDir: string;
let relay: FakeRelay;
let remote: RelayHost;
let app: App;
let server: ReturnType<typeof serve>;
let base: string;

const mac = async (): Promise<HostView> => {
  const report = (await (await fetch(`${base}/api/hosts`)).json()) as HostsReport;
  return report.hosts.find(h => h.name === "mac")!;
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "apps-chat-hosts-link-"));
  // No registry file, so the report reads no machine relay and the boxes come from the routing alone.
  const config = { ...readConfig([]), dataDir, port: 0, fixture: true, box: "test-box", ...fixtureFolders(dataDir), hostsFile: join(dataDir, "hosts.json") };
  const local = new FixtureHost();
  local.wordMs = 0;
  seedFixture(local, dataDir);
  relay = new FakeRelay("mac", TOKEN);
  await relay.listening;
  remote = new RelayHost({ box: "mac", url: relay.url, token: TOKEN, dataDir, redialWait: () => 20, livenessMs: 100 });
  const host = new MultiHost("test-box", [{ box: "test-box", label: "metal", host: local }, { box: "mac", label: "Mac", host: remote }], dataDir,
    { box: "test-box", platform: "linux", home: config.home, projects: config.projects, agentsDir: config.agentsDir });
  app = new App(config, host, () => {});
  await app.start();
  server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await app.stop();
  await relay.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the Mac reads up with its last pong, the hello's pi-host and the feed cursor; dropped it reads away, and back it reads up", async () => {
  const up = await until(mac, h => h?.agentRelay?.state === "up" && h.agentRelay.lastPongAt !== null);
  assert.equal(up.self, false);
  assert.equal(up.agentRelay!.version, "fake");
  assert.deepEqual(up.agentRelay!.piHost, { up: true, version: "fake-pi-host" });
  assert.equal(up.agentRelay!.feedCursor, 0);
  assert.deepEqual(up.piHost, { state: "answering", version: "fake-pi-host" });
  const self = ((await (await fetch(`${base}/api/hosts?threads=all`)).json()) as HostsReport).hosts[0]!;
  assert.equal(self.name, "test-box");
  assert.equal(self.agentRelay, null, "the chat's own box runs its local host here, so it has no relay link");
  assert.ok(self.threads.length > 0 && up.threads.length === 0, "each box lists only the threads its pi-host holds");

  relay.feed({ seq: 1, thread: "t-none", conversation: 1, entry: 1, toolCallId: "c1", toolName: "send_message", requestId: "m:t-none:c1", text: "x", at: Date.now() });
  await until(mac, h => h.agentRelay!.feedCursor === 1);

  const upSince = up.agentRelay!.since;
  relay.drop(true);
  const away = await until(mac, h => h.agentRelay!.state === "away");
  assert.ok(away.agentRelay!.since >= upSince);
  assert.ok(away.agentRelay!.lastPongAt !== null, "the last pong stays after the link drops");
  assert.deepEqual(away.agentRelay!.piHost, { up: true, version: "fake-pi-host" }, "the last hello stays too");
  assert.equal(away.piHost.state, "down");

  relay.down = false;
  const back = await until(mac, h => h.agentRelay!.state === "up");
  assert.ok(back.agentRelay!.since >= away.agentRelay!.since);
  assert.equal(back.agentRelay!.feedCursor, 1);
});

test("a walk's test agent's threads carry test, and other threads do not", async () => {
  const made = (await (await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "hosts walk", test: true }) })).json()) as { workThread?: string; thread?: string };
  const id = made.workThread ?? made.thread;
  assert.ok(id, "the new agent names its work thread");
  const self = await until(async () => ((await (await fetch(`${base}/api/hosts?threads=all&tests=1`)).json()) as HostsReport).hosts[0]!, h => h.threads.some(t => t.id === id));
  assert.equal(self.threads.find(t => t.id === id)!.test, true);
  assert.ok(self.threads.some(t => t.id !== id && t.test === undefined), "a thread of no test agent has no test flag");
});

test("each box counts every thread by status, test threads apart, and only the picked box lists the threads its filter shows", async () => {
  const report = async (query: string) => (await (await fetch(`${base}/api/hosts${query}`)).json()) as HostsReport;
  const every = (await report("?threads=all&tests=1")).hosts[0]!;
  const runs = ["working", "idle", "sleeping", "failed"] as const;
  for (const status of runs) {
    for (const kind of ["real", "test"] as const) {
      const listed = every.threads.filter(t => t.status === status && (kind === "test") === (t.test === true)).length;
      assert.equal(every.counts[kind][status], listed, `${kind} ${status} counts the threads ?threads=all&tests=1 lists`);
    }
  }
  const plain = await report("");
  assert.deepEqual(plain.hosts[0]!.counts, every.counts, "the counts do not depend on what the page lists (c191)");
  assert.ok(plain.hosts[0]!.threads.every(t => t.status === "working" && !t.test), "with no query this box lists its working threads, test threads left out");
  assert.equal(plain.hosts[0]!.threads.length, every.counts.real.working);
  assert.deepEqual(plain.hosts.find(h => h.name === "mac")!.threads, [], "another box lists no threads unless picked");
  const idle = (await report("?threads=idle")).hosts[0]!;
  assert.equal(idle.threads.length, every.counts.real.idle);
  assert.ok(idle.threads.every((t, i, all) => t.status === "idle" && (i === 0 || all[i - 1]!.updatedAt >= t.updatedAt)), "newest first");
  assert.deepEqual((await report("?box=mac&threads=all")).hosts[0]!.threads, [], "a pick of another box lists none of this box's threads");
  const bytes = async (query: string) => (await (await fetch(`${base}/api/hosts${query}`)).text()).length;
  assert.ok(await bytes("") < await bytes("?threads=all&tests=1"), "the 2 s poll of the default view carries only the threads it shows");
});
