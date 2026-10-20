import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageStore, Projector } from "../src/chat-projection.ts";
import { jobEnd, jobEndWords } from "../src/chat-checkin.ts";
import { clockTime } from "../src/checkin-settings.ts";
import { failureCause, turnStall } from "../src/chat-recovery.ts";
import { poolWait } from "../src/checkin-steps.ts";
import { cutEnd } from "../src/cut-end.ts";
import { lastTurnError, turnSince } from "../src/held-turns.ts";
import { failureText, poolSlot } from "../src/shared/chat-feed.ts";
import { endsOnPoolWait } from "../scripts/duties/whole-system.ts";

// stuck duty chat page from the mac (01a15a2b-be18) on us-metal02, 10-20: with dhx.3 Prime and the p692 hook, the hook answered exit 75 with a
// slot at 17:32:00Z, and Prime wrote this wait marker at 17:30:08Z (copied from a dhx.3 session, provider and times set to the incident's).
// The idle unload stopped it at 17:31:50Z, and no reader of "this session waits for its slot at" saw a pool wait in it.
const SLOT = Date.parse("2026-10-20T17:32:00.000Z");
const MARKER = {
  type: "message", id: "708fdbc3", parentId: "9da3ef81", timestamp: "2026-10-20T17:30:08.140Z",
  message: {
    role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: "API key for provider \"anthropic\" is temporarily unavailable until 2026-10-20T17:32:00.000Z: waiting for an account slot",
    timestamp: 1792517408140,
    diagnostics: [{ type: "provider_stream_failure", timestamp: 1792517408140, details: { kind: "credential_unavailable", retryAtMs: SLOT, retryAfterMs: 111860 } }],
  },
};
const USER = { type: "message", id: "9da3ef81", timestamp: "2026-10-20T17:30:07.900Z", message: { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1792517407900 } };
const ARCHIVED = { type: "session_state", timestamp: "2026-10-20T17:31:50.300Z", state: { status: "archived" } };
const lines = [USER, MARKER, ARCHIVED].map(entry => JSON.stringify(entry));

test("the job sweep and the idle unload read the marker as a pool wait with its retryAtMs", () => {
  const error = lastTurnError(lines.join("\n"));
  assert.ok(error !== undefined && poolWait({ error }), error);
  assert.equal(poolSlot(error), SLOT);
  assert.deepEqual(turnSince(lines.join("\n"), 0), { ran: false, error, slotAt: SLOT, provider: "anthropic" });
});

test("the cut a session ends on carries the marker's retryAtMs as its slot", () => {
  const cut = cutEnd(lines);
  assert.equal(cut?.slotAt, SLOT);
  assert.equal(cut?.error, `no account token from pi-pool, retries at ${clockTime(SLOT)}`);
});

test("the d1 pool-wait owners read a transcript that ends on the marker as waiting", () => {
  assert.equal(endsOnPoolWait(lines), true);
});

test("the chat reads the marker as a wait for its slot, not a failed turn", () => {
  const projected = new Projector(new ImageStore()).assistant(MARKER.message as unknown as Parameters<Projector["assistant"]>[0]);
  assert.equal(poolSlot(projected.errorMessage ?? ""), SLOT);
  assert.match(failureText(projected.errorMessage), /^Waiting for a Claude account until /);
  assert.equal(failureCause(projected.errorMessage ?? ""), "transient");
  const stall = turnStall({ messages: [projected], running: false, retrying: false, queued: 0, retryError: null }, SLOT - 60_000);
  assert.equal(stall?.slotAt, SLOT);
  // Prime's retry event carries the marker's text alone, so the slot comes from the projected turn.
  const retrying = turnStall({ messages: [projected], running: true, retrying: true, queued: 0, retryError: MARKER.message.errorMessage }, SLOT - 60_000);
  assert.equal(retrying?.slotAt, SLOT);
  const end = jobEnd([projected]);
  assert.ok(end && poolWait(end), JSON.stringify(end));
  assert.equal(jobEndWords(end!), `stopped on a provider error (no account token from pi-pool, retries at ${clockTime(SLOT)})`);
});
