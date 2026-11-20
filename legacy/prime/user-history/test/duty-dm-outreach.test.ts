// Guards the DM outreach works duty (d3 of the api portal vp chat). On 11-20 at 18:34Z prod's GET /ops/engage/health held 58 active accounts
// and no paid proxy, so no outreach could send, while the portal and this duty counted census.new plus census.active and read green. The duty
// reads the crawler's sendable_now, runs the deployed sendingState on the same answer, and counts failed sends (10-15 ui_no_compose).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyMetric } from "../src/shared/chat-duties.ts";
import { codeOf, failedOf, report, runSendingState, sendableOf } from "../scripts/duties/dm-outreach.ts";

/** sendingState as prod runs it on 11-20, counting census.new plus census.active, and as auto-sns-agent dev/sieun has it after it read sendable_now. */
const CENSUS_SUM = `export async function sendingState(who: Record<string, string>): Promise<Sending> {
	const out = await crawler('/ops/engage/health', who);
	if (!out.ok) return 'unknown';
	const census = (out.data as { census?: Record<string, unknown> } | null)?.census;
	const counts = [census?.new, census?.active];
	if (!counts.every((n): n is number => typeof n === 'number')) return 'unknown';
	return counts.some((n) => n > 0) ? 'available' : 'paused';
}
`;
const SENDABLE = `export async function sendingState(who: Record<string, string>): Promise<Sending> {
	const out = await crawler('/ops/engage/health', who);
	if (!out.ok) return 'unknown';
	const sendable = (out.data as { sendable_now?: unknown } | null)?.sendable_now;
	if (typeof sendable !== 'number') return 'unknown';
	return sendable > 0 ? 'available' : 'paused';
}
`;
/** GET /ops/engage/health on prod, 11-20 18:34Z, with the sendable_now the crawler now answers. */
const HEALTH = { status: 200, body: { ok: true, data: { census: { new: 0, active: 58, parked: 103 }, claimable_now: 0, admissible_now: 0, sendable_now: 0 } } };
const METRICS: DutyMetric[] = [
  { key: "sending_available", label: "", op: ">=", target: 1, headline: true },
  { key: "sendable_accounts", label: "", op: ">=", target: 1 },
  { key: "failed_sends_24h", label: "", op: "<=", target: 0 },
];
const NOW = Date.parse("2026-11-20T18:40:00Z");
const SHA = "a8f85b4206990cd73b4adbb87a88f04af8507040";

test("with nothing sendable the duty reads red and flags a deployed page that still offers Start conversation (prod 11-20 18:34Z)", async () => {
  assert.equal(await runSendingState(CENSUS_SUM, HEALTH), "available");
  assert.equal(await runSendingState(SENDABLE, HEALTH), "paused");
  const output = report({ now: NOW, sha: SHA, sending: "available", sendable: sendableOf(HEALTH.body), failed: [], errors: [] }, METRICS);
  assert.deepEqual(output.metrics, { sending_available: 0, sendable_accounts: 0, failed_sends_24h: 0 });
  assert.ok(output.flagged!.some(flag => flag.kind === "no_capacity"));
  assert.match(output.flagged!.find(flag => flag.kind === "page_offers_start")!.excerpt, /deployed a8f85b4206 answers available while sendable_now is 0/);
});

test("with an account to send from the duty reads green, and a page that shows Paused is flagged", () => {
  const output = report({ now: NOW, sha: SHA, sending: "paused", sendable: 3, failed: [], errors: [] }, METRICS);
  assert.deepEqual(output.metrics, { sending_available: 1, sendable_accounts: 3, failed_sends_24h: 0 });
  assert.match(output.flagged!.find(flag => flag.kind === "paused")!.excerpt, /answers paused while sendable_now is 3/);
  assert.deepEqual(report({ now: NOW, sha: SHA, sending: "available", sendable: 3, failed: [], errors: [] }, METRICS).flagged, []);
});

test("the 10-15 ui_no_compose send counts as failed", () => {
  const failed = failedOf("1\tfailed\tWebSendError: ui_no_compose: no New message control on this page\t1792095503599\n");
  assert.deepEqual(failed.map(send => send.code), ["WebSendError: ui_no_compose"]);
  const output = report({ now: NOW, sendable: 1, failed, errors: [] }, METRICS);
  assert.equal(output.metrics.failed_sends_24h, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "failed_sends")!.excerpt, /WebSendError: ui_no_compose x1/);
  assert.equal(codeOf("daily_send_limit_reached"), "daily_send_limit_reached");
});

test("an unread source misses every metric it feeds instead of reading green, and a crawler without sendable_now is unread", () => {
  assert.throws(() => sendableOf({ ok: true, data: { census: { new: 0, active: 58 } } }), /no sendable_now/);
  const output = report({ now: NOW, failed: [], errors: [{ source: "crawler engage health", message: "GET /ops/engage/health has no sendable_now" }] }, METRICS);
  assert.ok(output.metrics.sending_available! < 1);
  assert.ok(output.metrics.sendable_accounts! < 1);
  assert.equal(output.metrics.failed_sends_24h, 0);
  assert.ok(output.flagged!.some(flag => flag.kind === "source_error"));
});
