/**
 * The spec guard (test/live-guard.ts) refuses the live chat by URL and by what the server answers, and lets a fixture through.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/live-guard.test.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { liveRefusal, servedRefusal } from "../live-guard.ts";

async function serve(me: object): Promise<{ url: string; close: () => void }> {
  const server = createServer((_, res) => res.end(JSON.stringify(me)));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe("spec live guard", () => {
  test("the live port and the box's names are refused, a fixture port is not", () => {
    assert.match(String(liveRefusal("http://127.0.0.1:5184")), /live chat on :5184.*5186/);
    assert.match(String(liveRefusal("https://us-metal02-dev.tail0c093d.ts.net:5184")), /live/);
    assert.match(String(liveRefusal("http://us-metal02:5690")), /live box/);
    assert.equal(liveRefusal("http://127.0.0.1:5186"), undefined);
    assert.equal(liveRefusal("http://127.0.0.1:5690"), undefined);
  });

  test("a server that answers as the live chat is refused, a fixture passes", async () => {
    const live = await serve({ fixture: false });
    const fixture = await serve({ fixture: true });
    try {
      assert.match(String(await servedRefusal(live.url)), /not a fixture/);
      assert.equal(await servedRefusal(fixture.url), undefined);
    } finally {
      live.close();
      fixture.close();
    }
  });
});
