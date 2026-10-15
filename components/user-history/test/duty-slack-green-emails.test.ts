import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { DAY_MS, emailMetrics, type Recipient, type Send, type Sources, TOKEN_EMAIL_REMOVED_AT, templateOf } from "../scripts/duties/slack-green-emails.ts";

const NOW = Date.parse("2026-10-15T01:00:00Z");
const HOUR = 3_600_000;
let next = 0;
const send = (template: Send["template"], to: string, hoursAgo: number, lastEvent = "delivered"): Send =>
  ({ id: `e${next++}`, at: NOW - hoursAgo * HOUR, to, template, subject: template, lastEvent });
const user = (userId: string, extra: Partial<Recipient> = {}): Recipient => ({ userId, ...extra });
const run = (sources: Partial<Sources>, previous?: { at: number; optedOut: string[] }) => emailMetrics({ errors: [], ...sources }, NOW, previous);
const kinds = (flagged: { kind: string }[]) => flagged.map(item => item.kind);

test("emails: subjects map to templates, and an unknown subject is other", () => {
  assert.equal(templateOf("Connect Slack to finish setting up Slack Green"), "connect_reminder");
  assert.equal(templateOf("Finish your Slack Green setup on a computer"), "setup_link");
  assert.equal(templateOf("Action needed: kim-super-ninja needs updated tokens"), "token_expired");
  assert.equal(templateOf("Your Slack Green Pro Trial Ends in a Week. "), "trial_d7");
  assert.equal(templateOf("Confirm Your Signup"), "signup_confirm");
  assert.equal(templateOf("Something new"), "other");
});

test("emails: a nudge after a connect, a send to a deleted account and a token email after #233 are false positives", () => {
  const { metrics, flagged } = run({
    sends: [send("connect_reminder", "a@x.com", 2), send("setup_link", "b@x.com", 3), send("trial_d2", "c@x.com", 4), send("signup_confirm", "new@x.com", 5),
      { ...send("token_expired", "d@x.com", 1), at: TOKEN_EMAIL_REMOVED_AT + HOUR }, send("trial_d0", "gone@x.com", 6)],
    recipients: { "a@x.com": user("ua", { firstWorkspaceAt: NOW - 10 * HOUR }), "b@x.com": user("ub", { firstWorkspaceAt: NOW - HOUR }),
      "c@x.com": user("uc", { deletedAt: NOW - 30 * HOUR }), "d@x.com": user("ud") },
  });
  assert.equal(metrics.false_positive_sends, 4);
  const wrong = flagged.filter(item => item.kind === "false_positive").map(item => item.excerpt);
  assert.match(wrong[0]!, /^connect_reminder to user ua .*connected a Slack workspace/);
  assert.match(wrong[1]!, /^trial_d2 to user uc .*deleted/);
  assert.match(wrong[2]!, /^token_expired to user ud .*#233/);
  assert.match(wrong[3]!, /^trial_d0 to user address [0-9a-f]{10} \(no account\) .*: no account has this address$/);
  assert.ok(wrong.every(line => !line.includes("@")), "no flagged line names an address");
});

test("emails: nudges over the cap, repeats within 24 h and the bounce rate", () => {
  const { metrics, flagged } = run({
    sends: [send("setup_link", "a@x.com", 1), send("setup_link", "a@x.com", 30), send("connect_reminder", "a@x.com", 200),
      send("trial_d2", "b@x.com", 1), send("trial_d2", "b@x.com", 13, "bounced"), send("signup_confirm", "c@x.com", 1), send("signup_confirm", "c@x.com", 2, "complained")],
    recipients: { "a@x.com": user("ua"), "b@x.com": user("ub"), "c@x.com": user("uc") },
  });
  assert.equal(metrics.users_over_cap, 1);
  assert.equal(metrics.repeat_sends_24h, 1, "a second signup email is the person's own retry");
  assert.equal(metrics.annoying_sends_24h, 2, "the third nudge to a sent today and the second trial_d2 to b");
  assert.equal(metrics.bad_sends_24h, 2);
  assert.equal(metrics.bounce_or_complaint_pct, 40);
  assert.deepEqual(kinds(flagged).filter(kind => kind !== "sends_24h").sort(), ["bounced", "complained", "over_cap", "repeat"]);
});

test("emails: QA sends and sends older than 24 h are left out of the day's numbers", () => {
  const { metrics, flagged } = run({ sends: [send("setup_link", "sieun+sgqa-x@gmail.com", 1), send("setup_link", "sieun+sgqa-x@gmail.com", 2),
    send("setup_link", "sieun+sgqa-x@gmail.com", 3), send("trial_d0", "a@x.com", 25, "bounced")], recipients: {} });
  assert.deepEqual([metrics.false_positive_sends, metrics.users_over_cap, metrics.repeat_sends_24h, metrics.bounce_or_complaint_pct], [0, 0, 0, 0]);
  assert.match(flagged[0]!.excerpt, /^0 Slack Green emails in the last 24 h \(3 QA sends left out\)/);
  assert.ok(NOW - 25 * HOUR < NOW - DAY_MS);
});

test("emails: opt-outs count against the last run, and a marketing send after an opt-out is a false positive", () => {
  const first = run({ optedOut: ["u1"] });
  assert.equal(first.metrics.unsubscribes_24h, 0);
  assert.deepEqual(kinds(first.flagged), ["baseline"]);
  const previous = { at: NOW - 20 * HOUR, optedOut: ["u1"] };
  const later = run({ optedOut: ["u1", "u2"], sends: [send("trial_d2", "a@x.com", 2), send("signup_confirm", "a@x.com", 1)], recipients: { "a@x.com": user("u1") } }, previous);
  assert.equal(later.metrics.unsubscribes_24h, 1);
  assert.equal(later.metrics.false_positive_sends, 1);
});

test("emails: a send that is both wrong and annoying counts once in the headline", () => {
  const { metrics } = run({ sends: [send("connect_reminder", "a@x.com", 1), send("connect_reminder", "a@x.com", 2)],
    recipients: { "a@x.com": user("ua", { firstWorkspaceAt: NOW - 10 * HOUR }) } });
  assert.deepEqual([metrics.false_positive_sends, metrics.annoying_sends_24h, metrics.bad_sends_24h], [2, 1, 2]);
});

test("emails: a failed source makes the headline a miss, and the duty file declares one headline and at most 3 more", async () => {
  const { metrics } = run({ errors: ["Resend send log: HTTP 401"] });
  assert.equal(metrics.source_errors, 1);
  assert.equal(metrics.bad_sends_24h, 1);
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/slack-green-emails.duty.json"), "utf8")), "d1", NOW);
  assert.equal(duty.name, "Slack green emails");
  assert.deepEqual(duty.metrics.filter(metric => metric.headline).map(metric => metric.key), ["bad_sends_24h"]);
  assert.ok(duty.metrics.length <= 4);
  for (const metric of duty.metrics) assert.ok(metric.key in metrics, metric.key);
});
