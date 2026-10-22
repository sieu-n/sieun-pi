// AI harness d9 read Slack green emails' bad_sends_24h as a lagging window on 10-22 because its precheck gave no lastEventAt, so it could not
// tell a count of old sends from a fresh one. This checks each windowed count names its newest counted send.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emailMetrics, type Send } from "../scripts/duties/slack-green-emails.ts";

const NOW = Date.parse("2026-10-22T08:00:00Z");
const HOUR = 3_600_000;
const send = (id: string, to: string, template: Send["template"], hoursAgo: number): Send =>
  ({ id, at: NOW - hoursAgo * HOUR, to, template, subject: template, lastEvent: "delivered" });
const recipients = { "a@x.com": { userId: "ua" }, "b@x.com": { userId: "ub", firstWorkspaceAt: NOW - 10 * HOUR }, "c@x.com": { userId: "uc" } };

test("bad_sends_24h's lastEventAt is its newest wrong or annoying send, never a newer good one", () => {
  const sends = [send("1", "a@x.com", "setup_link", 5), send("2", "a@x.com", "setup_link", 2), send("3", "b@x.com", "connect_reminder", 3),
    send("4", "c@x.com", "trial_d7", 1)];
  const result = emailMetrics({ sends, recipients, optedOut: [], errors: [] }, NOW, undefined);
  assert.equal(result.metrics.bad_sends_24h, 2);
  assert.deepEqual(result.lastEventAt, { bad_sends_24h: NOW - 2 * HOUR, false_positive_sends: NOW - 3 * HOUR, annoying_sends_24h: NOW - 2 * HOUR });
});

test("a clean day gives no lastEventAt, and a failed source dates bad_sends_24h at this run", () => {
  const clean = emailMetrics({ sends: [send("4", "c@x.com", "trial_d7", 1)], recipients, optedOut: [], errors: [] }, NOW, undefined);
  assert.equal(clean.metrics.bad_sends_24h, 0);
  assert.deepEqual(clean.lastEventAt, {});
  const broken = emailMetrics({ errors: ["Resend send log: HTTP 500"] }, NOW, undefined);
  assert.deepEqual(broken.lastEventAt, { bad_sends_24h: NOW });
});
