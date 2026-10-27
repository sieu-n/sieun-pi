// 10-18 14:00Z to 20:40Z on us-metal02: the token hook alert fired 6 times on slot waits ("pi-pool: this session waits for its slot at ...") while 8 Claude accounts sat at their limits, and woke two alert jobs that could fix nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tallyTail } from "../src/token-hook-watch.ts";

const HOOK = 'Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token';
const turn = (timestamp: string, errorMessage: string) =>
  JSON.stringify({ type: "message", timestamp, message: { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage } });

test("a slot wait is the pool holding the turn, so only the other hook errors count as failures", () => {
  const text = [
    turn("2026-10-18T20:30:17.991Z", `${HOOK} pi-pool: this session waits for its slot at 2026-10-18T20:44:00.000Z. Try again in 14 minutes.`),
    turn("2026-10-18T20:31:00.000Z", `${HOOK} pi-pool: claude4@slack.green is limited until 2026-10-24T00:59:59.000Z; this session waits for its slot at 2026-10-18T20:40:00.000Z.`),
    turn("2026-10-18T20:32:00.000Z", `${HOOK} pi-pool: the token hook gave no token; the retry uses a new hook run.`),
    turn("2026-10-18T20:33:00.000Z", HOOK),
  ].join("\n");
  assert.deepEqual(tallyTail(text, Date.parse("2026-10-18T20:00:00Z")).failures,
    [Date.parse("2026-10-18T20:32:00.000Z"), Date.parse("2026-10-18T20:33:00.000Z")]);
});
