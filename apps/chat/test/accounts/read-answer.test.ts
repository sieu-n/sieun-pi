/**
 * What an Accounts row says after its last usage read or reset check failed (owner, #sw-factory-build p249, 11-28: a refreshed row kept
 * reading "Usage 6d 5h old"). pi-pool's `ls --json` row carries read_failed_at, read_error and usage_retry_at, the server parses them, and the
 * row leads with the provider's answer and its time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePoolRows, parseResets } from "../../../../legacy/prime/user-history/src/chat-pool.ts";
import { clockText, failedReadNote, failedReadTag, resetNote, rowNotes } from "../../web/src/pages/accounts/model.ts";

const NOW = Date.UTC(2026, 10, 28, 10, 30);
const S = (ms: number): number => ms / 1000;
const OAUTH = "Anthropic answered 403: OAuth authentication is currently not allowed for this organization.";

function row(extra: Record<string, unknown>) {
  const base = {
    id: "virev5", email: "claude-virev5@slack.green", label: "claude-virev5@slack.green", usage: "0%/0%", reason: null, usable: true, current: false, pinned: false,
    session_pct: 0, weekly_pct: 0, score: 1, windows: [{ kind: "session", label: "5h", pct: 3, resets_at: null }], usage_at: S(NOW - 6 * 86400_000), ...extra,
  };
  return parsePoolRows({ provider: "anthropic", rows: [base] }, "anthropic")[0]!;
}

test("the server parses the pool's last failed read, and a row with none reads null", () => {
  const failed = row({ read_failed_at: S(NOW - 60_000), read_error: OAUTH, usage_retry_at: S(NOW + 8 * 60_000) });
  assert.deepEqual([failed.readFailedAt, failed.readError, failed.usageRetryAt], [NOW - 60_000, OAUTH, NOW + 8 * 60_000]);
  const fine = row({});
  assert.deepEqual([fine.readFailedAt, fine.readError, fine.usageRetryAt], [null, null, null]);
});

test("a 429 leads the row with the provider's retry time, and the old numbers' age comes second", () => {
  const r = row({ read_failed_at: S(NOW - 60_000), read_error: "Anthropic rate limited usage reads (429)", usage_retry_at: S(NOW + 8 * 60_000) });
  assert.deepEqual(failedReadTag(r, NOW), { label: `429 until ${clockText(NOW + 8 * 60_000, NOW)}`, tone: "warning" });
  const notes = rowNotes(r, NOW, "Anthropic rate limited usage reads (429)");
  assert.equal(notes[0], `Usage read at ${clockText(NOW - 60_000, NOW)} failed. Anthropic rate limited usage reads (429) until ${clockText(NOW + 8 * 60_000, NOW)}.`);
  assert.equal(notes[1], "Usage from 6d ago.");
  assert.equal(notes.filter(note => note.includes("429")).length, 1, "the run's own reason does not repeat the pool's note");
});

test("a refused token reads as signed out and a 403 keeps Anthropic's own message", () => {
  const out = row({ read_failed_at: S(NOW - 60_000), read_error: "signed out: Anthropic refused the token (401)" });
  assert.deepEqual(failedReadTag(out, NOW), { label: `Signed out ${clockText(NOW - 60_000, NOW)}`, tone: "danger" });
  assert.equal(failedReadNote(out, NOW), `Usage read at ${clockText(NOW - 60_000, NOW)} failed. Signed out: Anthropic refused the token (401).`);
  const org = row({ read_failed_at: S(NOW - 60_000), read_error: OAUTH });
  assert.deepEqual(failedReadTag(org, NOW), { label: `403 at ${clockText(NOW - 60_000, NOW)}`, tone: "danger" });
  assert.match(failedReadNote(org, NOW)!, /OAuth authentication is currently not allowed for this organization\.$/);
});

test("a good read after the failure drops the failure", () => {
  const r = row({ read_failed_at: S(NOW - 60_000), read_error: OAUTH, usage_at: S(NOW - 30_000) });
  assert.equal(failedReadTag(r, NOW), null);
  assert.equal(failedReadNote(r, NOW), null);
});

test("a failed reset check leads with its time and Anthropic's answer, then the last good grants", () => {
  const resets = parseResets({
    checked_at: S(NOW - 60_000), error: "Anthropic rate limited the reset check (429)", error_at: S(NOW - 60_000),
    status: { eligible: false, ineligible_reason: "no_grant", at_limit: false, grants: [], next_grant_id: null, cooldown_until: null },
  });
  assert.equal(resetNote(resets, NOW),
    `Reset check at ${clockText(NOW - 60_000, NOW)} failed. Anthropic rate limited the reset check (429). The last good check said: no banked resets: no reset was granted.`);
});
