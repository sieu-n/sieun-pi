import assert from "node:assert/strict";
import { test } from "node:test";
import { briefCheck, briefCheckNote } from "../src/shared/brief-check.ts";
import { inventedGates } from "../src/shared/invented-gates.ts";

/* c47 reopened 10-12 by the ledger: "Do not invent waiting rules, extra review rounds or safety gates; act directly and ship, unless the owner
 * explicitly asks for caution." Every line below is from a job brief written on 10-12. */
const REFUSED = [
  "Prod slot queue: one write per 15-min slot",
  "Prod writes are one change per 15-min slot with a clean read-back.",
  "Run the probe only on Fable's explicit slot go.",
  "Metal box rules (metal box owner thread 01a11d24-ac9b-757d-ac51-9b2b7598782f): one change at a time, at most one box reader, IO STOP lines, staging deploy of land 32b comes at about 11:00-11:30Z.",
  "You may inspect existing builder scripts and prepare a manifest/build plan now; WAIT for my exact source freeze instruction and root source review before copying/building.",
  "Ask it for a slot first: one probe at a time, and push only on its go.",
  "Resume check-ins in every chat through the chat service's own API, one chat at a time, about 2 minutes apart.",
  "Prod writes need a Crawler VP slot (I ask for it).",
  "Migration numbers 0135-0139 are taken; ask me before adding one.",
  "No commit until coordinator source+secret review, any release successor distinct .6.",
  "Staging control writes only for the time-boxed test, through the audited controls API with a reason, after metal's slot, and restored at the end.",
  "Wait for the owner's go before the staging land.",
];
const ALLOWED = [
  "Push PROBE A at Fable's staging word, because land 32b's deploy needs the same runners",
  "Push PROBE A at Fable's staging word, since land 32b's deploy holds the M1 Air runner.",
  "Hold the census writes until the box answers, since the last ramp step hit 429s on 40% of calls.",
  "Do not wait for review, already approved source, but no production promotion.",
  "Staging lands need no ask; never cancel or rerun a workflow.",
  "No production merge, push to main, promote or prod deploy: when a fix is proven on staging, report it and I get the owner's go.",
  "An automatic email to phone signups (p94) and the 24 h reminder email (#225) wait for the owner's go, so do not build or extend any automatic email.",
  "Run tests one file at a time with --test-concurrency=1, and stop the scratch serve when you are done.",
  "Run parts in parallel; only browser checks and builds wait for the load gate.",
  "Register the runner with its own label and one job at a time, and show it online in the GitHub API.",
  "Wait until :5180 answers.",
  "Export ci/repo-guard-move-r2 read-only into your session folder and run the commit.mjs object-mode tests there, one file at a time.",
  "First send 2 single queries and confirm both answer 200 with real organic results; if prod answers 5xx, wait until 05:40Z and try once more.",
  "Add a check that flags a brief whose next action waits on another thread's go, word or slot.",
  "Owner's words quoted as \"one write per 15-min slot\" are not a gate.",
];

test("c47 invented gates: today's gate lines are refused", () => {
  for (const line of REFUSED) assert.equal(inventedGates(line).length, 1, line);
  assert.deepEqual(inventedGates(REFUSED[0]!), [{ phrase: "one write per 15-min slot", sentence: REFUSED[0] }]);
});

test("c47 invented gates: a gate with its cause, an owner rule, a real event or a negation passes", () => {
  for (const line of ALLOWED) assert.deepEqual(inventedGates(line), [], line);
  assert.equal(inventedGates("Run the probe only on Fable's explicit slot go, to be safe.").length, 1, "caution is not a cause");
});

test("c47 invented gates: the brief check flags a gate in the task and leaves the owner's quoted words and My read alone", () => {
  const brief = "Owner's words: none, started by the corrections ledger\n\nMy read: today that meant 15-minute slot spacing and quiet stretches.\n" +
    "Split: stays inline.\nTask: fix the canary. Prod writes are one change per 15-min slot with a clean read-back.";
  const findings = briefCheck(brief).filter(finding => finding.kind === "invented-gate");
  assert.deepEqual(findings, [{ kind: "invented-gate", gates: [{ phrase: "one change per 15-min slot", sentence: "Prod writes are one change per 15-min slot with a clean read-back." }] }]);
  assert.match(briefCheckNote("canary", findings), /- It sets a gate nobody asked for: "one change per 15-min slot"\. Drop the gate and have the job act now \(c47/);
  const fixed = brief.replace("Prod writes are one change per 15-min slot with a clean read-back.", "Write the canary now and read it back.");
  assert.deepEqual(briefCheck(fixed).filter(finding => finding.kind === "invented-gate"), []);
});
