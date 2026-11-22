// node --test --test-force-exit --test-isolation=none scripts/restart-walk-count.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countRestartHits, parseOwnerLines, parseStarts } from "./restart-walk-count.mjs";

const journal = [
  "1795305679.068402 us-metal02 systemd[8987]: Stopping sieun-pi-apps-chat.service - apps/chat...",
  "1795305679.162261 us-metal02 systemd[8987]: Started sieun-pi-apps-chat.service - apps/chat.",
  "1795305730.351344 us-metal02 systemd[8987]: Started sieun-pi-apps-chat.service - apps/chat.",
  "1795305799.000000 us-metal02 systemd[8987]: Reloading sieun-pi-apps-chat.service - apps/chat...",
  "1795305799.010000 us-metal02 systemd[8987]: Reloaded sieun-pi-apps-chat.service - apps/chat.",
].join("\n");
const line = row => JSON.stringify({ src: "client", via: "tailnet", m: "GET", r: "/api/later", p: "/api/later", s: 200, ms: 20, ...row });

test("parseStarts keeps the Started and Reloading lines, in ms", () => {
  assert.deepEqual(parseStarts(journal), [1795305679162, 1795305730351, 1795305799000]);
});

test("parseOwnerLines keeps his page lines and drops local, server and timings lines", () => {
  const text = [
    line({ at: 1 }),
    line({ at: 2, via: "local" }),
    JSON.stringify({ src: "server", via: "tailnet", at: 3, m: "GET", r: "/api/later", s: 200, ms: 5 }),
    line({ at: 4, r: "/api/timings" }),
    "not json \"tailnet\" \"client\"",
  ].join("\n");
  assert.deepEqual(parseOwnerLines(text).map(row => row.at), [1]);
});

test("countRestartHits counts failed and slow calls within the window of the latest start", () => {
  const starts = parseStarts(journal);
  const rows = parseOwnerLines([
    line({ at: starts[0] + 7_000, s: 0, err: "TypeError: Load failed" }),
    line({ at: starts[0] + 12_000, s: 502, err: "GET /api/later failed with 502" }),
    line({ at: starts[0] + 15_000, ms: 1500 }),
    line({ at: starts[0] + 16_000, ms: 1500, bg: "shown" }),
    line({ at: starts[0] + 30_000, s: 0, err: "TypeError: Load failed" }),
    line({ at: starts[1] + 1_000, ms: 30 }),
  ].join("\n"));
  const day = countRestartHits(starts, rows)["2026-11-22"];
  assert.equal(day.restarts, 3);
  assert.equal(day.restartsHit, 1);
  assert.equal(day.failed, 2);
  assert.equal(day.slow, 1);
  assert.equal(day.outsideFailed, 1);
  assert.deepEqual(day.routes, [["GET /api/later", 3]]);
});
