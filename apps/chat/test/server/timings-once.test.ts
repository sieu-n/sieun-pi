/**
 * A client timing batch posted again, as the page does when the answer to a stored batch is lost (client.ts `sendTimings`), stores none of
 * its lines a second time. On 11-25 at 21:24Z and 21:35Z the owner's page posted 11 and 5 stored lines again, and the speed duty counted
 * their waits twice.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/timings-once.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

let marks = 0;
/**
 * The client lines stored today for paths under `prefix`. The log writes lines in the order the server took them, so once a marker line
 * posted after the batches is in the file, every line of those batches is too.
 */
async function stored(prefix: string): Promise<{ p: string; ms: number }[]> {
  const mark = `/api/mark/${++marks}`;
  await s.send("POST", "/api/timings", { samples: [{ id: `mark.${marks}`, m: "GET", p: mark, s: 200, ms: 1 }] });
  const file = join(s.app.config.dataDir, "requests", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  for (;;) {
    const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    if (lines.some(line => line.p === mark)) return lines.filter(line => line.src === "client" && line.p.startsWith(prefix));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("a batch posted again stores only its new lines", async () => {
  const first = [
    { id: "pg1.1", m: "GET", p: "/api/c/once-a/items", s: 200, ms: 12556 },
    { id: "pg1.2", m: "GET", p: "/api/c/once-b/items", s: 200, ms: 8292 },
  ];
  assert.equal((await s.send("POST", "/api/timings", { samples: first })).status, 200);
  const again = await s.send<{ taken: number; again: number }>("POST", "/api/timings", { samples: [...first, { id: "pg1.3", m: "GET", p: "/api/c/once-c/items", s: 200, ms: 40 }] });
  assert.deepEqual(again.body, { taken: 1, again: 2 });
  assert.deepEqual((await stored("/api/c/once-")).map(line => [line.p, line.ms]), [
    ["/api/c/once-a/items", 12556], ["/api/c/once-b/items", 8292], ["/api/c/once-c/items", 40],
  ]);
});

test("the same line number from another page and a line without an id are stored", async () => {
  await s.send("POST", "/api/timings", { samples: [{ id: "pg2.1", m: "GET", p: "/api/c/other-a", s: 200, ms: 5 }] });
  await s.send("POST", "/api/timings", { samples: [{ id: "pg3.1", m: "GET", p: "/api/c/other-a", s: 200, ms: 5 }, { m: "GET", p: "/api/c/other-b", s: 200, ms: 6 }] });
  await s.send("POST", "/api/timings", { samples: [{ m: "GET", p: "/api/c/other-b", s: 200, ms: 6 }] });
  assert.deepEqual((await stored("/api/c/other-")).map(line => line.p), ["/api/c/other-a", "/api/c/other-a", "/api/c/other-b", "/api/c/other-b"]);
});
