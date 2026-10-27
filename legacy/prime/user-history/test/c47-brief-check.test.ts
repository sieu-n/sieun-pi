// Guards owner rule c47 in the brief check: a gate negated in its own clause, a wait named as a measurement, a wait on a production step (c74,
// c154) and an ask to the release owner are not invented gates. On 10-22 chat-2572 (01a162bc-47b4-770b-a9fc-19c3a742e730) got two false flags,
// and a replay of every chat job brief from 10-19 to 10-22 found the other kinds below. The real gates from that replay still fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefCheck } from "../src/shared/brief-check.ts";
import { inventedGates } from "../src/shared/invented-gates.ts";

const brief = (line: string): string => `Split: none, one output.\n\n${line}`;

test("chat-2572's two lines pass the brief check", () => {
  assert.deepEqual(briefCheck(brief("Report the exact commit and tests. No source redesign or extra review round is needed.")), []);
  assert.deepEqual(briefCheck(brief("Save evidence under /home/sieun/work/chris slack message. End turns without an open polling process while waiting for the release or approval.")), []);
});

test("a rejected option, a measured wait and a wait on a prod step pass", () => {
  for (const line of [
    "Prefer a knip config that cannot break on any one app's config, such as ignoring config loading for every vitest or playwright config, over adding apps one at a time.",
    "If it got slower, find the concrete cause from data: queue wait for a slot or pi-pool account, model latency, longer turns, a few slow chats, a specific day or release.",
    "Split each latency into its causes: time waiting for a working slot (pi-pool-queue entries, the pool's turn queue log), time until the model's first output.",
    "Only after promote 15 reports 'prod deploy ok' may you end idle owner_ro sessions older than an hour that you can tie to a dead process.",
    "After promote 19's prod deploy ok, read the writer lag again (Postgres restart effect).",
    "When I pass on promote 16's 'prod deploy ok', measure bio sightings in the first prod hour and say what they add.",
  ]) assert.deepEqual(inventedGates(line), [], line);
});

test("an ask to the release owner named in the sentence is no wait for the owner's ok", () => {
  assert.deepEqual(briefCheck(brief("Send the sha to the release owner (01a10810-34b5-710f-88fe-3d369f89a8c9) and ask him to push sieun/dev at once and dispatch one land.yml run.")), []);
  assert.equal(briefCheck(brief("Commit it, then ask him to push sieun/dev before you go on."))[0]?.kind, "waits-for-leave");
});

test("real gates still fail, with a negation in another clause", () => {
  const gates: [string, string][] = [
    ["Never walk the sitemap against prod: check one URL at a time, at least 1 s apart.", "one URL at a time"],
    ["Run each on staging or in the lab (crawler lab lane window owns lab slots on us-metal01 and runs offline lanes; ask me if you need a slot).", "need a slot"],
    ["Do not merge yet and hold the diff for Fable's go.", "hold the diff for Fable's go"],
    ["Push to staging, then wait for the release owner's go.", "wait for the release owner's go"],
    ["Prod writes are one change per 15-min slot with a clean read-back.", "one change per 15-min slot"],
    ["WAIT for my exact source freeze instruction and root source review before copying/building.", "WAIT for my exact source freeze instruction"],
  ];
  for (const [line, phrase] of gates) assert.equal(inventedGates(line)[0]?.phrase, phrase, line);
});
