// Trial emails v2 (slack-green packages/backend/app/polling/trial_emails.py) first sent on 2026-10-22 14:20Z with subjects the Slack green
// emails precheck did not know, so the 10-23 run listed 3 of them as "other" and checked none for opt-outs or a connected workspace. This
// checks each v2 subject maps to its trial step and that the never-connected copy counts as wrong once the user has a workspace. The same run's
// one bounce was a full Gmail inbox, a Transient bounce, which read as 9.09%; the last test checks a Transient bounce is listed, not counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emailMetrics, markSoftBounces, templateOf, type Send } from "../scripts/duties/slack-green-emails.ts";

test("every v2 trial subject maps to a trial template", () => {
  assert.equal(templateOf("A week left on your Slack Green trial"), "trial_d7");
  assert.equal(templateOf("7 days left on your trial, and Slack isn't connected yet"), "trial_d7");
  assert.equal(templateOf("2 days left to keep Acme green"), "trial_d2");
  assert.equal(templateOf("Last day of your Slack Green trial"), "trial_last_day");
  assert.equal(templateOf("Less than a day left on your trial, and Slack isn't connected yet"), "trial_last_day");
  assert.equal(templateOf("Slack Green stopped keeping william-happy-owl green"), "trial_d0");
  assert.equal(templateOf("Your Slack Green trial ended before Slack was connected"), "trial_d0");
  assert.equal(templateOf("Slack Green isn't keeping Acme green"), "trial_idle");
  assert.equal(templateOf("50% off your first month of Slack Green"), "trial_followup");
  assert.equal(templateOf("Connect Slack to keep Acme green"), "setup_link");
});

test("the never-connected trial email is wrong after the user connected Slack, and marketing after an opt-out", () => {
  const NOW = Date.parse("2026-10-23T01:00:00Z");
  const HOUR = 3_600_000;
  const send = (id: string, to: string, subject: string): Send =>
    ({ id, at: NOW - HOUR, to, template: templateOf(subject), subject, lastEvent: "delivered" });
  const recipients = { "a@x.com": { userId: "ua", firstWorkspaceAt: NOW - 5 * HOUR }, "b@x.com": { userId: "ub" } };
  const sends = [send("1", "a@x.com", "Your Slack Green trial ended before Slack was connected"),
    send("2", "b@x.com", "Last day of your Slack Green trial")];
  const result = emailMetrics({ sends, recipients, optedOut: ["ub"], errors: [] }, NOW, { at: NOW - 20 * HOUR, optedOut: ["ub"] });
  assert.equal(result.metrics.false_positive_sends, 2);
  assert.equal(result.flagged.filter(item => item.kind === "new_template").length, 0);
});

test("a Transient bounce is listed as soft_bounced and leaves the bounce rate at 0", async () => {
  const NOW = Date.parse("2026-10-23T01:00:00Z");
  const sends: Send[] = [{ id: "b1", at: NOW - 3_600_000, to: "a@x.com", template: "setup_link", subject: "s", lastEvent: "bounced" },
    { id: "d1", at: NOW - 3_600_000, to: "b@x.com", template: "setup_link", subject: "s", lastEvent: "delivered" }];
  const fetch = (async (url: string) => {
    assert.match(String(url), /\/emails\/b1$/);
    return new Response(JSON.stringify({ bounce: { type: "Transient", subType: "MailboxFull" } }), { status: 200 });
  }) as typeof globalThis.fetch;
  await markSoftBounces({ exec: async () => "", fetch, now: () => NOW, env: {} }, "key", sends);
  assert.equal(sends[0]!.lastEvent, "soft_bounced");
  const result = emailMetrics({ sends, recipients: { "a@x.com": { userId: "ua" }, "b@x.com": { userId: "ub" } }, errors: [] }, NOW, undefined);
  assert.equal(result.metrics.bounce_or_complaint_pct, 0);
  assert.equal(result.flagged.filter(item => item.kind === "soft_bounced").length, 1);
});
