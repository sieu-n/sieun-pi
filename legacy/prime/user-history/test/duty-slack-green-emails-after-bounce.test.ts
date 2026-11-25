// Resend's 30-day log on 2026-11-25 held 6 Slack Green trial emails to 3 addresses after each one's first bounce, all soft, and the Slack
// green emails precheck counted none of them, because it judged each send alone. This checks a send after an earlier bounce or complaint to
// the same address counts as a bad send, while a send Resend dropped as suppressed and a send to another address do not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emailMetrics, templateOf, type Send } from "../scripts/duties/slack-green-emails.ts";

test("a send after an earlier bounce to the same address is a bad send", () => {
  const NOW = Date.parse("2026-11-25T10:00:00Z");
  const HOUR = 3_600_000;
  const send = (id: string, to: string, hoursAgo: number, lastEvent: string,
    subject = "Less than a day left on your trial, and Slack isn't connected yet"): Send => {
    return { id, at: NOW - hoursAgo * HOUR, to, template: templateOf(subject), subject, lastEvent };
  };
  const sends = [
    send("first", "a@x.com", 30, "bounced"),
    send("again", "a@x.com", 2, "bounced"),
    send("dropped", "a@x.com", 1, "suppressed", "Your Slack Green trial ended before Slack was connected"),
    send("spam", "b@x.com", 40, "complained"),
    send("after-spam", "b@x.com", 3, "delivered"),
    send("other", "c@x.com", 2, "delivered"),
  ];
  const recipients = { "a@x.com": { userId: "ua" }, "b@x.com": { userId: "ub" }, "c@x.com": { userId: "uc" } };
  const result = emailMetrics({ sends, recipients, optedOut: [], errors: [] }, NOW, undefined);
  assert.equal(result.metrics.false_positive_sends, 2);
  assert.equal(result.metrics.bad_sends_24h, 2);
  const why = result.flagged.filter(item => item.kind === "false_positive").map(item => item.excerpt);
  assert.match(why[0]!, /user ua .*an earlier email to this address ended bounced at 2026-11-24T04:00:00Z \(Resend first\)/);
  assert.match(why[1]!, /user ub .*ended complained/);
});
