/**
 * A run that keeps retrying a transient error shows "retrying since HH:MM: <error kind>" (KST) on its thread and its conversation node
 * once it has retried past 5 minutes, and keeps retrying (`retrying.ts`).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings } from "@sieun-pi/pi-pool/durable";
import { retryingText, retryKind, RETRY_FLAG_MS } from "../../src/durable/retrying.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-retrying-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

test("retryKind names the transient errors, and the flag shows only past 5 minutes, in KST", () => {
  assert.equal(retryKind("pi-pool: the token hook gave no token (lock_wait_timeout); the service is temporarily unavailable and the retry runs the hook again."), "pi-pool token hook lock_wait_timeout");
  assert.equal(retryKind(OVERLOADED), "529 overloaded");
  assert.equal(retryKind("429 rate limit. pi-pool: a is limited"), "429 rate limit");
  assert.equal(retryKind("502 Bad Gateway"), "502 server error");
  assert.equal(retryKind("fetch failed"), "network error");
  const since = Date.UTC(2026, 10, 21, 23, 22);
  assert.equal(retryingText(since, OVERLOADED, since + RETRY_FLAG_MS), undefined);
  assert.equal(retryingText(since, OVERLOADED, since + RETRY_FLAG_MS + 1), "retrying since 08:22: 529 overloaded");
});

test("a thread whose run retries a 529 past 5 minutes reads retrying since its first error, and the run keeps retrying", async () => {
  let shift = 0;
  let sent = 0;
  const threads = new DurableThreads({
    dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    now: () => Date.now() + shift,
    models: () => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 200 }, () => () => { sent++; return fauxAssistantMessage([], { stopReason: "error", errorMessage: OVERLOADED }); }));
      models.setProvider(faux.provider);
      return models;
    },
    // The faux provider defers when asked to, and only pi-pool needs deferred waits.
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
  });
  try {
    const thread = await threads.create({ name: "relay page job" });
    const started = Date.now();
    await threads.submit(thread.id, { text: "Build the relay page." });
    for (let i = 0; i < 200 && sent < 5; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(sent >= 5, "the run retries past pi-durable's old budget of 3");
    assert.equal(threads.info(thread.id).retrying, undefined, "under 5 minutes there is no flag");
    shift = RETRY_FLAG_MS + 1000;
    const flag = threads.info(thread.id).retrying;
    assert.match(flag ?? "", /^retrying since \d\d:\d\d: 529 overloaded$/);
    const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    assert.ok([hhmm.format(started), hhmm.format(started + 60_000)].some(at => flag?.includes(at)), `${flag} starts at the first error`);
    assert.match(threads.list().find(row => row.id === thread.id)?.retrying ?? "", /^retrying since/);
    const node = (await threads.tree(thread.id)).find(n => n.id === 1);
    assert.match(node?.retrying ?? "", /^retrying since \d\d:\d\d: 529 overloaded$/);
    const before = sent;
    for (let i = 0; i < 200 && sent === before; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(sent > before, "the flag stops nothing");
    await threads.abort(thread.id);
  } finally {
    await threads.shutdown();
  }
});
