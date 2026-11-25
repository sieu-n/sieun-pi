/**
 * POST /api/threads/:id/agent-message (app.ts `agentMessageAsAgent`) submits a pi-host root's sibling send to a thread on another box through
 * that box's relay, against a fake Mac relay: by the thread's id or exact name, 404 for a name no box runs, 503 while the Mac is away.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-message-route.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { App } from "../../server/app.ts";
import { fixtureFolders, readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { MultiHost } from "../../server/host/multi-host.ts";
import { RelayHost } from "../../server/host/relay-host.ts";
import { serve } from "../../server/http.ts";
import { FakeRelay } from "./fake-relay.ts";
import { until } from "./helpers.ts";

const TOKEN = "test-token";
let dataDir: string;
let relay: FakeRelay;
let app: App;
let server: ReturnType<typeof serve>;
let base: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "apps-chat-agent-message-"));
  const config = { ...readConfig([]), dataDir, port: 0, fixture: true, box: "test-box", ...fixtureFolders(dataDir), hostsFile: join(dataDir, "hosts.json") };
  const local = new FixtureHost();
  local.wordMs = 0;
  relay = new FakeRelay("mac", TOKEN);
  await relay.listening;
  const remote = new RelayHost({ box: "mac", url: relay.url, token: TOKEN, dataDir, redialWait: () => 20, livenessMs: 100 });
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

const send = async (from: string, body: Record<string, unknown>) => {
  const response = await fetch(`${base}/api/threads/${from}/agent-message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("a sibling send reaches a Mac thread by id or name through its relay; an unknown name is 404 and an away Mac is 503", async () => {
  const designer = await relay.host.create({ name: "5180 designer" });
  const sender = await app.host.create({ name: "agent factory" });
  await until(async () => { await app.threads.refresh(); return app.threads.thread(designer.id); }, row => row?.box === "mac");

  const byId = await send(sender.id, { to: designer.id, text: "hello from metal", requestId: "agentmsg:m1" });
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.deepEqual({ ...byId.body, submission: typeof byId.body.submission }, { thread: designer.id, name: "5180 designer", box: "mac", submission: "number" });
  const submits = relay.calls.filter(call => call.op === "durable_submit");
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0]!.args, {
    thread: designer.id, text: "hello from metal", whenBusy: "steer", requestId: "agentmsg:m1",
    entry: { kind: "agent.message", data: { from: sender.id, via: "agent_message" } },
  });

  const byName = await send(sender.id, { to: "5180 designer", text: "again", whenBusy: "followUp" });
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  assert.equal(byName.body.box, "mac");
  assert.equal(relay.calls.filter(call => call.op === "durable_submit").at(-1)!.args.whenBusy, "followUp");

  const nobody = await send(sender.id, { to: "nobody", text: "x" });
  assert.equal(nobody.status, 404);
  assert.equal(nobody.body.error, 'No thread on any box has the id or name "nobody".');

  relay.drop(true);
  const away = await until(() => send(sender.id, { to: designer.id, text: "x" }), answer => answer.status === 503);
  assert.match(String(away.body.error), new RegExp(`5180 designer \\(${designer.id}\\) on mac is away now, so the message was not sent`));
});
