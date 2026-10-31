// Guards the DM extension working duty of the chrome extension chat. The headline holds only when all four parts of the staging proof hold,
// as the 10-29 proof read them (send row sent, the reply in the test DM's thread), and the 24 h counts read only extension rows of 24 h.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DutyMetric } from "../src/shared/chat-duties.ts";
import { errorCounts, jarIgUserId, otherRuns, parts, report, senderFits, type AutopairEvidence, type DmRow, type E2eEvidence, type JarRow } from "../scripts/duties/dm-extension.ts";

const METRICS = (JSON.parse(readFileSync(new URL("../scripts/duties/dm-extension.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] }).metrics;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const HOUR = 3_600_000;

const AUTOPAIR: AutopairEvidence = { checks: [
  { name: "1 the unpaired popup offers only Open virev", ok: true },
  { name: "2 the signed-in /app page paired the extension with no click", ok: true, detail: { pairStatus: 200 } },
  { name: "3a the account in front is registered from the heartbeat and the popup says so", ok: true },
  { name: "3b Connections lists @caiyiting8674", ok: true },
  { name: "5a an Instagram sign-out reaches the popup in seconds", ok: false },
] };
const E2E: E2eEvidence = {
  connectionsRow: "@caiyiting8674",
  firstOutreach: { id: "m1", status: "sent", threadId: "t1" },
  bReply: { text: "reply from @glenmyftiu945 09:52Z", onInstagram: true },
  replyInStore: { threadId: "t1", messageId: "m2" },
  replyInInboxUi: true,
  inboxCard: { sent: false, error: "no DM window at https://staging.virev.ai/app/inbox?outreach=1&to_handle=glenmyftiu945" },
};

test("all four parts hold: e2e_pass 1, and an unrelated autopair check is a slice, not a miss", () => {
  const out = report({ now: NOW, autopair: AUTOPAIR, e2e: E2E, rows: { messages: [], devices: [], truncated: false }, errors: [] }, METRICS);
  assert.deepEqual(out.metrics, { e2e_pass: 1, maybe_sent_24h: 0, send_restricted_24h: 0, unknown_username_24h: 0 });
  assert.ok(out.flagged?.some(slice => slice.kind === "autopair_check" && slice.excerpt.includes("5a")));
  assert.ok(out.flagged?.some(slice => slice.kind === "inbox_card" && slice.excerpt.includes("Inbox DM window")));
});

test("a sender with too few sends left reads sender_daily_limit and an unmeasured e2e_pass, never a fake 0", () => {
  const sender = { username: "caiyiting8674", sentToday: 8, dailyLimit: 8 };
  assert.equal(senderFits(sender), false);
  const out = report({ now: NOW, autopair: AUTOPAIR, sender, rows: { messages: [], devices: [], truncated: false }, errors: [] }, METRICS);
  assert.ok(out.metrics.e2e_pass! < 0);
  assert.ok(out.flagged?.some(slice => slice.kind === "sender_daily_limit" && slice.excerpt.includes("8 of its daily limit of 8")));
  assert.ok(!out.flagged?.some(slice => slice.kind === "e2e_part"));
});

test("a fresh org's sender row fits a run, and the four parts decide e2e_pass", () => {
  assert.equal(senderFits({ username: "caiyiting8674", sentToday: 5, dailyLimit: 8 }), true);
  assert.equal(senderFits({ username: "caiyiting8674", sentToday: 6, dailyLimit: 8 }), false);
  const out = report({ now: NOW, autopair: AUTOPAIR, e2e: E2E, sender: { username: "caiyiting8674", sentToday: 0, dailyLimit: 8 }, errors: [] }, METRICS);
  assert.equal(out.metrics.e2e_pass, 1);
});

test("a reply in another thread fails the reply part", () => {
  const held = parts(AUTOPAIR, { ...E2E, replyInStore: { threadId: "t2", messageId: "m2" } });
  assert.equal(held.reply.ok, false);
  assert.equal(held.sent.ok, true);
});

test("a send that settled delivery_unknown fails the sent part and names the row", () => {
  const out = report({ now: NOW, autopair: AUTOPAIR, e2e: { ...E2E, firstOutreach: { id: "m1", status: "delivery_unknown", errorCode: "send_response_lost", threadId: "t1" } }, errors: [] }, METRICS);
  assert.equal(out.metrics.e2e_pass, 0);
  assert.ok(out.flagged?.some(slice => slice.kind === "e2e_part" && slice.item === "sent" && slice.excerpt.includes("send_response_lost")));
});

test("no rig evidence reads unmeasured, never green", () => {
  const out = report({ now: NOW, errors: [{ source: "world", message: "up exited 1" }] }, METRICS);
  assert.ok(out.metrics.e2e_pass! < 0);
  assert.ok(out.metrics.maybe_sent_24h! > 0);
});

test("24 h counts take extension rows of the last day by their last attempt", () => {
  const row = (id: string, status: string, hoursAgo: number, extra: Partial<DmRow> = {}): DmRow =>
    ({ _id: id, _creationTime: NOW - 72 * HOUR, status, orgId: "org", queue: { transport: "extension", lastAttemptAt: NOW - hoursAgo * HOUR }, ...extra });
  const counts = errorCounts({
    messages: [
      row("a", "delivery_unknown", 2), row("b", "delivery_unknown", 30), row("c", "scheduled", 1, { errorCode: "send_restricted" }),
      row("d", "delivery_unknown", 1, { queue: { transport: "fleet", lastAttemptAt: NOW - HOUR } }),
    ],
    devices: [
      { _id: "d1", orgId: "org", updatedAt: NOW - HOUR, unregistered: [{ platformUserId: "1", username: null, reason: "unknown_username" }, { platformUserId: "2", username: "x", reason: "limit" }] },
      { _id: "d2", orgId: "org", updatedAt: NOW - 30 * HOUR, unregistered: [{ platformUserId: "3", username: null, reason: "unknown_username" }] },
    ],
  }, NOW);
  assert.deepEqual(counts.maybeSent.map(r => r._id), ["a"]);
  assert.deepEqual(counts.restricted.map(r => r._id), ["c"]);
  assert.deepEqual(counts.unknown.map(u => u.platformUserId), ["1"]);
});

test("a jar with a null ig_user_id is named by its ds_user_id cookie, as on 10-31 for 206", () => {
  const jar = (ig_user_id: string | null, cookies: JarRow["cookies"]): JarRow => ({ id: 206, username: "caiyiting8674", ig_user_id, cookies, status: "active", valid: true, jar_at: "2026-10-31" });
  assert.equal(jarIgUserId(jar(null, [{ name: "csrftoken", value: "x" }, { name: "ds_user_id", value: "29063885913" }])), "29063885913");
  assert.equal(jarIgUserId(jar("29063885913", null)), "29063885913");
  assert.throws(() => jarIgUserId(jar(null, [])), /no ds_user_id/);
});

test("the precheck waits on another copy of itself or a rig, never on itself or its own shell, and says how long it waited", () => {
  const lines = [
    "100 node --import tsx scripts/duties/dm-extension.ts",
    "90 sh -c cd x && OUTPUT_FILE=y node --import tsx scripts/duties/dm-extension.ts > z",
    "200 node --import tsx scripts/duties/dm-extension.ts",
    "300 node /repo/apps/dm-extension/tests/staging-real-ig.mjs --a jar",
    "400 node --test test/duty-dm-extension.test.ts",
  ].join("\n");
  assert.deepEqual(otherRuns(lines, new Set([100, 90])).map(line => line.split(" ")[0]), ["200", "300"]);
  assert.deepEqual(otherRuns(lines.split("\n").slice(0, 2).join("\n"), new Set([100, 90])), []);
  const out = report({ now: NOW, autopair: AUTOPAIR, e2e: E2E, waited: { ms: 332_400, on: ["node --import tsx scripts/duties/dm-extension.ts"] }, errors: [] }, METRICS);
  assert.equal(out.metrics.e2e_pass, 1);
  assert.ok(out.flagged?.some(slice => slice.kind === "waited" && slice.excerpt.startsWith("waited 332 s")));
});
