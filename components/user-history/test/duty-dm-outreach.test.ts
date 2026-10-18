// Guards the DM outreach works duty (d3 of the api portal vp chat). On 2026-10-15 prod's sendingState counted only aiograpi accounts, so
// https://api.virev.ai/playground/dm-playground showed Paused with 127 active jar accounts (auto-sns-agent 60aa3284dc), and at 20:18Z prod
// message 1 failed WebSendError ui_no_compose. The duty runs the deployed sendingState on the census and counts that failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyMetric } from "../src/shared/chat-duties.ts";
import { codeOf, failedOf, report, runSendingState, sendableOf } from "../scripts/duties/dm-outreach.ts";

/** sendingState as prod runs it at a8f85b4206, with the constant it names, and as auto-sns-agent sieun/dev has it after 60aa3284dc. */
const DEPLOYED = `const HEALTH_TIMEOUT_MS = 3_000;
export async function sendingState(): Promise<Sending> {
	const out = await crawler('/ops/engage/health', { method: 'GET', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
	if (!out.ok) return 'unknown';
	const census = (out.data as { census?: Record<string, Record<string, unknown>> } | null)?.census;
	const counts = [census?.new?.aiograpi, census?.active?.aiograpi];
	if (!counts.every((n) => typeof n === 'number')) return 'unknown';
	return (counts as number[]).some((n) => n > 0) ? 'available' : 'paused';
}
`;
const FIXED = `export async function sendingState(): Promise<Sending> {
	const out = await crawler('/ops/engage/health');
	if (!out.ok) return 'unknown';
	const census = (out.data as { census?: Record<string, unknown> } | null)?.census;
	const bands = [census?.new, census?.active];
	if (!bands.every((band) => typeof band === 'object' && band !== null)) return 'unknown';
	const counts = bands.flatMap((band) => Object.values(band as Record<string, unknown>));
	if (counts.length === 0 || !counts.every((n) => typeof n === 'number')) return 'unknown';
	return (counts as number[]).some((n) => n > 0) ? 'available' : 'paused';
}
`;
/** GET /ops/engage/health on prod, 10-15 20:0xZ: every account is a jar account. */
const HEALTH = { status: 200, body: { ok: true, data: { census: { new: { aiograpi: 0, jar: 0 }, active: { aiograpi: 0, jar: 127 }, challenged: { aiograpi: 0, jar: 15 } } } } };
const METRICS: DutyMetric[] = [
  { key: "sending_available", label: "", op: ">=", target: 1, headline: true },
  { key: "sendable_accounts", label: "", op: ">=", target: 1 },
  { key: "failed_sends_24h", label: "", op: "<=", target: 0 },
];
const NOW = Date.parse("2026-10-15T21:00:00Z");

test("the deployed aiograpi-only sendingState reads Paused on the all-jar census, and the fixed one reads available", async () => {
  assert.equal(await runSendingState(DEPLOYED, HEALTH), "paused");
  assert.equal(await runSendingState(FIXED, HEALTH), "available");
  assert.equal(await runSendingState(FIXED, { status: 503, body: { ok: false, error: { code: "upstream_unavailable" } } }), "unknown");
  assert.equal(sendableOf(HEALTH.body.data.census), 127);
});

test("a Paused page misses the headline while the census has capacity, and the 10-15 ui_no_compose send counts as failed", () => {
  const failed = failedOf("1\tfailed\tWebSendError: ui_no_compose: no New message control on this page\t1792095503599\n");
  assert.deepEqual(failed.map(send => send.code), ["WebSendError: ui_no_compose"]);
  const output = report({ now: NOW, sha: "a8f85b4206990cd73b4adbb87a88f04af8507040", sending: "paused", census: HEALTH.body.data.census, failed, errors: [] }, METRICS);
  assert.deepEqual(output.metrics, { sending_available: 0, sendable_accounts: 127, failed_sends_24h: 1 });
  assert.match(output.flagged!.find(flag => flag.kind === "paused")!.excerpt, /deployed a8f85b4206 answers paused while the census holds 127/);
  assert.match(output.flagged!.find(flag => flag.kind === "failed_sends")!.excerpt, /WebSendError: ui_no_compose x1/);
  assert.equal(codeOf("daily_send_limit_reached"), "daily_send_limit_reached");
});

test("an unread source misses every metric it feeds instead of reading green", () => {
  const output = report({ now: NOW, failed: [], errors: [{ source: "crawler engage health", message: "HTTP 502" }] }, METRICS);
  assert.ok(output.metrics.sending_available! < 1);
  assert.ok(output.metrics.sendable_accounts! < 1);
  assert.equal(output.metrics.failed_sends_24h, 0);
  assert.ok(output.flagged!.some(flag => flag.kind === "source_error"));
});
