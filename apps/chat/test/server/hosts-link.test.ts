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
  const self = ((await (await fetch(`${base}/api/hosts`)).json()) as HostsReport).hosts[0]!;
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
