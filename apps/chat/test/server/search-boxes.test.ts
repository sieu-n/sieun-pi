/**
 * Every box's rows live in the one search index: another box's rows come through its relay's `durable_index_read`, so a search never asks
 * that box, counts its threads exactly, and still finds them while it is offline.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/search-boxes.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { App } from "../../server/app.ts";
import { fixtureFolders, readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { MultiHost } from "../../server/host/multi-host.ts";
import { RelayHost } from "../../server/host/relay-host.ts";
import type { EntryRecord } from "../../server/host/types.ts";
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

const search = async (q: string): Promise<SearchResult> => (await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=100`)).json()) as SearchResult;

/** An owner message on the Mac's thread, as its pi-host would index it. */
function said(id: number, text: string, at: number): EntryRecord {
  return { id, conversationId: 1, kind: "pi.user", data: {}, model: [{ role: "user", content: text, timestamp: at }] } as unknown as EntryRecord;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "apps-chat-search-boxes-"));
  const config = { ...readConfig([]), dataDir, port: 0, fixture: true, box: "test-box", ...fixtureFolders(dataDir), hostsFile: join(dataDir, "hosts.json") };
  const local = new FixtureHost();
  local.wordMs = 0;
  seedFixture(local, dataDir);
  relay = new FakeRelay("mac", TOKEN);
  await relay.listening;
  const thread = relay.host.addThread({ name: "Mac quokka job", createdAt: Date.now() - 60_000 });
  thread.entries.push(said(1, "the quokka census starts on the Mac", Date.now() - 50_000), said(2, "count every quokka twice", Date.now() - 40_000));
  remote = new RelayHost({ box: "mac", url: relay.url, token: TOKEN, dataDir, redialWait: () => 20, livenessMs: 100 });
  const host = new MultiHost("test-box", [{ box: "test-box", label: "metal", host: local }, { box: "mac", label: "Mac", host: remote }], dataDir,
    { box: "test-box", platform: "linux", home: config.home, projects: config.projects, agentsDir: config.agentsDir });
  app = new App(config, host, () => {});
  await app.start();
  server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await until(() => Promise.resolve(app.routing!.link("mac").state), state => state === "up");
  await app.searchEngine.settled();
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await app.stop();
  await relay.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the Mac's threads are found and counted from the one index, and a search sends the Mac no call", async () => {
  const calls = relay.calls.length;
  const found = await search("quokka");
  assert.equal(found.total, 2);
  assert.deepEqual(found.hits.map(hit => hit.conversation.name).sort(), ["Mac quokka job", "Mac quokka job"]);
  assert.equal(found.missing, undefined);
  assert.equal(relay.calls.length - calls, 0, "a search asks the index only");
  assert.ok(relay.calls.some(call => call.op === "durable_index_read"));
});

test("a row the Mac adds is found after its next read, and an offline Mac's threads stay found with a note", async () => {
  relay.host.threadsById.get([...relay.host.threadsById.keys()].find(id => relay.host.threadsById.get(id)!.row.name === "Mac quokka job")!)!
    .entries.push(said(3, "the quokka census is done", Date.now()));
  await app.searchEngine.settled();
  assert.equal((await search("quokka")).total, 3);

  relay.drop(true);
  await until(() => Promise.resolve(app.routing!.link("mac").state), state => state === "away");
  const away = await search("quokka");
  assert.equal(away.total, 3);
  assert.equal(away.missing?.length, 1);
  assert.match(away.missing![0]!.note, /^mac is offline since \d\d:\d\dZ, so its threads show what it wrote until then\.$/);
});
