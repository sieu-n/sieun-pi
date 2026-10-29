/**
 * The chat opens its port and serves the sidebar and For you from the last run's thread list and boards while pi-host is still starting.
 * After a restart on 2026-10-28, pi-host took 8 to 13 s to listen, and the chat waited for it before it opened its port.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Sidebar } from "../../web/src/lib/api/types.ts";
import { App } from "../../server/app.ts";
import { readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { PiHost } from "../../server/host/pi-host.ts";
import { serve } from "../../server/http.ts";
import { seedFixture } from "../../server/fixture/seed.ts";

const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-cold-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

async function run(host: FixtureHost | PiHost, use: (base: string, startMs: number) => Promise<void>): Promise<void> {
  const app = new App({ ...readConfig([]), dataDir, port: 0, fixture: host instanceof FixtureHost, box: "test-box" }, host, () => {});
  const started = performance.now();
  await app.start();
  const startMs = performance.now() - started;
  const server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, startMs);
  } finally {
    server.closeAllConnections();
    server.close();
    await app.stop();
  }
}

const get = async <T>(url: string): Promise<{ ms: number; body: T }> => {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  return { ms: performance.now() - started, body: (await response.json()) as T };
};

test("while pi-host is down, the sidebar and For you answer in under a second from the last run's copy", async () => {
  const fixture = new FixtureHost();
  seedFixture(fixture, dataDir);
  let sidebar!: Sidebar;
  let asks = 0;
  await run(fixture, async base => {
    sidebar = (await get<Sidebar>(`${base}/api/sidebar`)).body;
    asks = (await get<{ items: unknown[] }>(`${base}/api/for-you`)).body.items.length;
  });
  assert.ok(sidebar.dms.length > 0 && asks > 0);

  await run(new PiHost(join(dataDir, "no-pi-host.sock")), async (base, startMs) => {
    assert.ok(startMs < 1000, `the server took ${startMs.toFixed(0)} ms to start`);
    const cold = await get<Sidebar>(`${base}/api/sidebar`);
    assert.ok(cold.ms < 1000, `the sidebar took ${cold.ms.toFixed(0)} ms`);
    assert.deepEqual(cold.body.dms.map(c => c.id), sidebar.dms.map(c => c.id));
    assert.equal(cold.body.forYou, sidebar.forYou);
    const forYou = await get<{ items: unknown[] }>(`${base}/api/for-you`);
    assert.equal(forYou.body.items.length, asks);
    assert.ok(forYou.ms < 1000, `For you took ${forYou.ms.toFixed(0)} ms`);
  });
});
