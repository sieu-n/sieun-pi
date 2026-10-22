// Guards d1's demo_worlds and heap_used_mb run detail: on 10-19 5180 grew about 2.3 MB per demo world until restarts (auto-sns-agent 2033e09cf),
// and no d1 number showed the growth before the server went down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_HEALTH_URL, measureSandbox } from "../scripts/duties/demo-sandbox.ts";

const run = (health: (url: string) => Response) => measureSandbox({
  fetch: (async (url: string) => String(url) === DEMO_HEALTH_URL ? health(String(url)) : new Response("ok")) as unknown as typeof fetch,
  exec: async file => file === "ps" ? "" : "[]",
  now: () => Date.parse("2026-10-19T17:20:00Z"),
  read: async path => { if (path.endsWith(".log")) return ""; throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); },
  mtime: async () => 0,
  repo: "/repo",
  platform: "darwin",
  pm2: { bin: "pm2", home: "/pm2", zone: "UTC" },
  startWalk: () => 4242,
});

test("the run detail carries the live worlds and the heap from /__demo/health", async () => {
  const body = { ok: true, pin: "8643d0d", commit: null, worlds: 55, memory: { rssMb: 969, heapUsedMb: 951, heapTotalMb: 1088, externalMb: 47 }, uptimeMs: 11961881 };
  const result = await run(() => Response.json(body));
  assert.equal(result.metrics.demo_worlds, 55);
  assert.equal(result.metrics.heap_used_mb, 951);
  assert.match((result.flagged ?? []).find(slice => slice.kind === "demo_memory")!.excerpt, /55 worlds, heap 951 of 1088 MB, rss 969 MB/);
});

test("a /__demo/health that is down or has no memory is a source error, not a zero", async () => {
  for (const health of [() => new Response("no", { status: 502 }), () => Response.json({ ok: true })]) {
    const result = await run(health);
    const errors = (result.flagged ?? []).filter(slice => slice.kind === "source" && slice.excerpt.startsWith(DEMO_HEALTH_URL));
    assert.equal(errors.length, 1, JSON.stringify(result.flagged));
  }
});
