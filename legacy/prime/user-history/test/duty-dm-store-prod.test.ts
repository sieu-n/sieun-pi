// Guards d3 "DM extension on prod" of the chrome extension chat: the store CRX loads under the store id, each account's parts decide its
// metric, and the 24 h failure count leaves out cancelled rows, other transports and older rows.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type DutyMetric, outsideWaitOf } from "../src/shared/chat-duties.ts";
import { type DmRow, extensionIdOf, report, type RigEvidence, sendFailures, splitCrx, STORE_ID } from "../scripts/duties/dm-store-prod.ts";

const METRICS = (JSON.parse(readFileSync(new URL("../scripts/duties/dm-store-prod.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] }).metrics;
const NOW = Date.parse("2026-11-26T12:00:00Z");
const HOUR = 3_600_000;

const brief = (id: string, sender: string, thread: string, status = "sent") => ({ id, status, account: null, sender, thread, errorCode: null });
const PASSED: RigEvidence = {
  paired: { deviceId: "dev1", ms: 4000, status: "connected", version: "2.0.6" },
  linkA: { already: false, ms: 900 },
  linkB: { already: false, ms: 800 },
  bNamed: { front: "2", frontHandle: "rinayui37" },
  sentA: brief("m1", "aoi.otoha", "tA"),
  sentB: brief("m2", "rinayui37", "tB"),
  incomingInA: brief("m3", "rinayui37", "tA", "received"),
  incomingInB: brief("m4", "aoi.otoha", "tB", "received"),
  checks: { aSentAsA: true, bSentAsB: true, aStayedInFront: true, replyInAThread: true, replyInBThread: true, twoThreads: true },
  inboxShowsReply: { a: true, b: true },
  endSweep: { revoked: ["dev1"], cancelled: [] },
  code: 0,
};

test("a run whose every part held reads 1 for both accounts, and a Link press on an already linked account proves nothing", () => {
  const out = report({ now: NOW, rig: PASSED, rows: { messages: [], read: 0, truncated: false }, errors: [] }, METRICS);
  assert.deepEqual(out.metrics, { prod_store_e2e_pass: 1, two_accounts_pass: 1, prod_send_failures_24h: 0 });
  assert.deepEqual(out.n, { prod_store_e2e_pass: 2, two_accounts_pass: 2, prod_send_failures_24h: 0 });
  const already = report({ now: NOW, rig: { ...PASSED, linkB: { already: true, ms: 10 } }, errors: [] }, METRICS);
  assert.equal(already.metrics.prod_store_e2e_pass, 1);
  assert.equal(already.metrics.two_accounts_pass, 0);
  assert.match(already.flagged?.find(slice => slice.kind === "second_account_part")?.excerpt ?? "", /linked before the press/);
});

test("a reply in the store that the Inbox page does not show fails the headline, and the rig's error names where it stopped", () => {
  const unseen = report({ now: NOW, rig: { ...PASSED, inboxShowsReply: { a: false, b: true } }, errors: [] }, METRICS);
  assert.equal(unseen.metrics.prod_store_e2e_pass, 0);
  assert.equal(unseen.metrics.two_accounts_pass, 1);
  const stopped = report({ now: NOW, rig: { error: "A is not signed in to Instagram.", code: 1 }, errors: [] }, METRICS);
  assert.deepEqual([stopped.metrics.prod_store_e2e_pass, stopped.metrics.two_accounts_pass], [0, 0]);
  assert.deepEqual(stopped.n, { prod_store_e2e_pass: 0, two_accounts_pass: 0, prod_send_failures_24h: 0 });
  assert.match(stopped.flagged?.find(slice => slice.item === "pair")?.excerpt ?? "", /The rig stopped: A is not signed in to Instagram\. the rig stopped before the pairing/);
  assert.ok(stopped.flagged?.some(slice => slice.kind === "cleanup"));
});

test("prod send failures count every org's extension failures of 24 h and leave out cancelled rows", () => {
  const row = (id: string, status: string, at: number, extra: Partial<DmRow> = {}): DmRow =>
    ({ _id: id, _creationTime: at, status, orgId: "org_x", queue: { transport: "extension", lastAttemptAt: at }, ...extra });
  const rows = [
    row("failed", "failed", NOW - HOUR, { errorCode: "ui_no_composer" }),
    row("unknown", "delivery_unknown", NOW - 2 * HOUR),
    row("restricted", "scheduled", NOW - HOUR, { errorCode: "send_restricted" }),
    row("cancelled", "failed", NOW - HOUR, { errorCode: "cancelled" }),
    row("old", "failed", NOW - 25 * HOUR),
    row("sent", "sent", NOW - HOUR),
    row("proxy", "failed", NOW - HOUR, { queue: { transport: "proxy", lastAttemptAt: NOW - HOUR } }),
  ];
  assert.deepEqual(sendFailures(rows, NOW).map(r => r._id), ["failed", "unknown", "restricted"]);
  const out = report({ now: NOW, rows: { messages: rows, read: 1545, truncated: false }, errors: [] }, METRICS);
  assert.equal(out.metrics.prod_send_failures_24h, 3);
  assert.equal(out.n.prod_send_failures_24h, 1545);
});

test("a held or boxed test account waits on a residential exit, counts toward no error streak, and still reads the failure count", () => {
  const out = report({ now: NOW, boxed: ["B @rinayui37: the crawler holds its jar"], rows: { messages: [], read: 0, truncated: false }, errors: [] }, METRICS);
  assert.equal(out.metrics.prod_send_failures_24h, 0);
  assert.match(outsideWaitOf(out) ?? "", /residential exit/);
  assert.match(out.flagged?.find(slice => slice.kind === "unmeasured")?.excerpt ?? "", /start no fix job/);
});

test("splitCrx returns the zip and the key whose id is the asked one, out of the publisher's and the store's keys", () => {
  const key = () => generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" });
  const [publisher, store] = [key(), key()];
  const field = (number: number, bytes: Buffer) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  const proof = (publicKey: Buffer) => field(2, Buffer.concat([field(1, publicKey), field(2, Buffer.from("sig"))]));
  const header = Buffer.concat([proof(publisher), proof(store), field(10000, field(1, Buffer.from("id")))]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  const crx = Buffer.concat([Buffer.from("Cr24"), Buffer.from([3, 0, 0, 0]), length, header, Buffer.from("PK-zip")]);
  const out = splitCrx(crx, extensionIdOf(store));
  assert.equal(out.zip.toString(), "PK-zip");
  assert.ok(out.publicKey.equals(store));
  assert.throws(() => splitCrx(crx, STORE_ID), /carries no key of jcoaoifnchpadejdimobidgoglimgfkd/);
});

function varint(value: number): Buffer {
  const bytes: number[] = [];
  for (; value > 0x7f; value = Math.floor(value / 128)) bytes.push((value & 0x7f) | 0x80);
  bytes.push(value);
  return Buffer.from(bytes);
}
