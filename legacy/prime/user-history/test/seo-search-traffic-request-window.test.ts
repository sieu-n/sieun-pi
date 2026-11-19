// Guards the 11-18 stop: from 00:20Z the Request indexing window had no signed-in browser (the box Chrome had no Google user, and the Aside app
// on the Mac was closed), the timer exited 0 every minute, and the 11-19 d1 run showed nothing about it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { visitsOutput, WINDOW_DOWN_MS } from "../scripts/duties/seo-search-visits.ts";

const NOW = Date.parse("2026-11-19T00:00:21Z");
const DOWN = Date.parse("2026-11-18T00:19:43Z") / 1000;
const window = (down_since: number | null) => ({ down_since, last_accepted: "2026-11-16T23:59:16Z", pinned_left: 63 });
const errors = (read: Parameters<typeof visitsOutput>[0], at: number): number =>
  visitsOutput(read, at).metrics.source_errors! - visitsOutput({}, at).metrics.source_errors!;

test("a Request indexing window that is due 24 h with no signed-in browser counts in source_errors and names what to do", () => {
  assert.equal(errors({ window: window(DOWN) }, NOW), 0);
  const at = DOWN * 1000 + WINDOW_DOWN_MS;
  assert.equal(errors({ window: window(DOWN) }, at), 1);
  const line = visitsOutput({ window: window(DOWN) }, at).flagged!.find(slice => slice.excerpt.startsWith("Request indexing window"))!;
  assert.equal(line.kind, "source_error");
  assert.match(line.excerpt, /due for 24 h with no signed-in browser, since 2026-11-18T00:19Z.*last took a request at 2026-11-16T23:59:16Z, and 63 pinned/);
  assert.equal(errors({ window: window(null) }, at), 0);
  assert.equal(visitsOutput({ window: window(null) }, at).flagged!.find(slice => slice.kind === "request_window")!.excerpt,
    "Request indexing window: Google last took a request at 2026-11-16T23:59:16Z, and 63 pinned recrawl URLs wait.");
  assert.equal(errors({ window: { error: "FileNotFoundError" } }, at), 1);
});
