// Guards the Mac session 01a14e22 of 2026-10-18 08:32:37Z: pi-pool gave it no token until its slot at 08:55:30Z, Prime slept until then to continue the turn, and the feed showed "Error: Failed to resolve API key" as a failed turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLines, failureText } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const SLOT = "2026-10-18T08:55:30.000Z";
const WAIT = `Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token pi-pool: this session waits for its slot at ${SLOT}. Try again in 23 minutes.`;
const hhmm = (iso: string): string => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("a pool wait reads as a wait with its time, not an error", () => {
  const messages: ThreadMessage[] = [
    { role: "user", content: [{ type: "text", text: "latency-probe af6e50d9. Reply with exactly: ok" }], timestamp: Date.parse("2026-10-18T08:31:33.418Z") },
    { role: "assistant", content: [{ type: "text", text: "" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage, stopReason: "error", errorMessage: WAIT, timestamp: Date.parse("2026-10-18T08:32:36.310Z") },
  ] as ThreadMessage[];
  const notices = chatLines(messages).filter(line => line.kind === "notice" || line.kind === "quiet").map(line => ({ kind: line.kind, text: line.text }));
  assert.deepEqual(notices, [{ kind: "quiet", text: `Waiting for a Claude account until ${hhmm(SLOT)}.` }]);
});

test("any other failure still reads as an error", () => {
  assert.equal(failureText("Provider rate limit exceeded (rate_limit_error, 429)"), "Error: Provider rate limit exceeded (rate_limit_error, 429)");
  assert.equal(failureText(undefined), "Error: the model returned an error");
});
