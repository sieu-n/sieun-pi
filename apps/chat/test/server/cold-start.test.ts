/**
 * The chat opens its port and serves the sidebar and For you from the last run's thread list and boards while pi-host is still starting.
 * After a restart on 2026-10-28, pi-host took 8 to 13 s to listen, and the chat waited for it before it opened its port.
 * The test counts pi-host answers instead of timing the start: a wait on a pi-host that is down lasts its 30 s restart wait (pi-host.ts
 * `call`), while the start's own work, 20 to 100 ms alone, took 1,203 ms of wall time in a full parallel server run at load 150 on 11-23
 * (~/work/chat-specs-red/specs-red-srv-cold-start).
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

async function run(host: FixtureHost | PiHost, use: (base: string, start: string) => Promise<void>): Promise<void> {
  const app = new App({ ...readConfig([]), dataDir, port: 0, fixture: host instanceof FixtureHost, box: "test-box" }, host, () => {});
  const started = performance.now();
  const steps = await app.start();
  const start = `${(performance.now() - started).toFixed(0)} ms (${steps})`;
  const server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, start);
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

test("while pi-host is down, the server starts and the sidebar and For you answer from the last run's copy before pi-host answers anything", async () => {
  const fixture = new FixtureHost();
  seedFixture(fixture, dataDir);
  let sidebar!: Sidebar;
  let asks = 0;
  await run(fixture, async base => {
    sidebar = (await get<Sidebar>(`${base}/api/sidebar`)).body;
    asks = (await get<{ items: unknown[] }>(`${base}/api/for-you`)).body.items.length;
  });
  assert.ok(sidebar.dms.length > 0 && asks > 0);

  const piHost = new PiHost(join(dataDir, "no-pi-host.sock"));
  const call = piHost.call.bind(piHost);
  let ended = 0;
  piHost.call = (...args) => call(...args).finally(() => { ended += 1; });
  await run(piHost, async (base, start) => {
    assert.equal(ended, 0, `the server started in ${start} after a pi-host call ended, so it waited for pi-host`);
    const cold = await get<Sidebar>(`${base}/api/sidebar`);
    assert.equal(ended, 0, `the sidebar answered in ${cold.ms.toFixed(0)} ms after a pi-host call ended`);
    assert.deepEqual(cold.body.dms.map(c => c.id), sidebar.dms.map(c => c.id));
    assert.equal(cold.body.forYou, sidebar.forYou);
    const forYou = await get<{ items: unknown[] }>(`${base}/api/for-you`);
    assert.equal(ended, 0, `For you answered in ${forYou.ms.toFixed(0)} ms after a pi-host call ended`);
    assert.equal(forYou.body.items.length, asks);
  });
});
