// Guards 10-30 17:06Z: hosted-app-chat.spec.ts went red on ci-staging-proof-spec-red while hosted-inbox-whatsapp-dm.spec.ts, held red on Meta's
// name approval, kept the rule open, and the bridge gave the new red to no job, since a new label set on an open rule was the same incident.
// A rule whose label incident_by names one of its labels now holds one fault per value of it, and a new value fires the rule again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, emptyState, type FiringAlert } from "../src/alert-bridge.ts";

const NOW = Date.parse("2026-10-30T17:06:00Z");
const RULE = "ci-staging-proof-spec-red";
const spec = (name: string, fingerprint: string, startsAt: string, by: string | null = "spec"): FiringAlert => ({
  fingerprint, startsAt, alertname: "CI staging-proof spec red", summary: "", url: "",
  labels: { __alert_rule_uid__: RULE, alertname: "CI staging-proof spec red", spec: name, ...by ? { incident_by: by } : {} },
});
const WHATSAPP = spec("hosted-inbox-whatsapp-dm.spec.ts", "f-wa", "2026-10-30T15:10:10.000Z");
const CHAT = spec("hosted-app-chat.spec.ts", "f-chat", "2026-10-30T17:05:10.000Z");

test("a new spec on an open rule with incident_by fires the rule again, so its job owes the new red", () => {
  const before = advance([WHATSAPP], emptyState(), () => "ci", NOW - 3_600_000).state;
  const after = advance([WHATSAPP, CHAT], before, () => "ci", NOW);
  assert.deepEqual([...after.fired], [`ci/${RULE}`]);
  assert.equal(after.state.rules[`ci/${RULE}`]!.wokeAt, NOW);
  assert.equal(after.state.rules[`ci/${RULE}`]!.firstWokeAt, NOW - 3_600_000);
});

test("a new label set of a spec the rule already holds open is the same fault, as is any new label set of a rule with no incident_by", () => {
  const before = advance([WHATSAPP], emptyState(), () => "ci", NOW - 3_600_000).state;
  const rerun = spec("hosted-inbox-whatsapp-dm.spec.ts", "f-wa-2", "2026-10-30T17:05:10.000Z");
  assert.equal(advance([WHATSAPP, rerun], before, () => "ci", NOW).fired.size, 0);
  const plain = advance([spec("a.spec.ts", "f-a", "2026-10-30T15:10:10.000Z", null)], emptyState(), () => "ci", NOW - 3_600_000).state;
  assert.equal(advance([spec("a.spec.ts", "f-a", "2026-10-30T15:10:10.000Z", null), spec("b.spec.ts", "f-b", "2026-10-30T17:05:10.000Z", null)], plain, () => "ci", NOW).fired.size, 0);
});

test("a deploy that adds incident_by gives the open specs new fingerprints and fires nothing", () => {
  const old = { ...WHATSAPP, labels: { ...WHATSAPP.labels } };
  delete old.labels.incident_by;
  const before = advance([old], emptyState(), () => "ci", NOW - 3_600_000).state;
  assert.equal(advance([{ ...WHATSAPP, fingerprint: "f-wa-labelled" }], before, () => "ci", NOW).fired.size, 0);
});

test("a spec whose earlier red resolved fires again when it goes red while the rule stays open", () => {
  const start = advance([WHATSAPP, CHAT], emptyState(), () => "ci", NOW - 7_200_000).state;
  const chatGreen = advance([WHATSAPP], start, () => "ci", NOW - 3_600_000).state;
  const again = spec("hosted-app-chat.spec.ts", "f-chat", "2026-10-30T17:50:10.000Z");
  assert.deepEqual([...advance([WHATSAPP, again], chatGreen, () => "ci", NOW).fired], [`ci/${RULE}`]);
});
