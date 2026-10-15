import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyRunRecord, DutyView } from "../src/shared/chat-duties.ts";

// duties.svelte.ts imports the page's api module, which reads the chat token from the page body at load.
(globalThis as { document?: unknown }).document ??= { body: { dataset: {} } };
const { dutiesCount, lastLabel, VERDICT_WORDS } = await import("../src/client/duties.svelte.ts");

const NOW = Date.parse("2026-10-10T09:00:00Z");
const run = (verdict: DutyRunRecord["verdict"], minutesAgo: number): DutyRunRecord => ({ at: NOW - minutesAgo * 60_000, verdict, metrics: {}, summary: "" } as unknown as DutyRunRecord);
const view = (runs: DutyRunRecord[]): DutyView => ({ duty: { id: "d1", name: "Chat system", metrics: [] }, schedule: { kind: "every", minutes: 15 }, paused: false, nextAt: NOW, running: false, runs } as unknown as DutyView);

test("duty card words: a run whose numbers came up short is 'off target' with its streak; 'missed' is only a slot that did not run (owner 10-10, p256)", () => {
  assert.equal(VERDICT_WORDS.missed, "off target");
  assert.equal(VERDICT_WORDS.skipped, "missed");
  assert.match(lastLabel(view([run("missed", 1), run("met", 16), run("missed", 31)]), NOW), /^off target · /);
  assert.match(lastLabel(view([run("missed", 1), run("skipped", 16), run("missed", 31), run("met", 46)]), NOW), /^off target 2 runs in a row · /, "a skipped slot does not break the streak");
  assert.match(lastLabel(view([run("met", 1), run("missed", 16)]), NOW), /^met · /);
  assert.match(lastLabel(view([{ ...run("missed", 10), after: { at: NOW - 60_000, verdict: "met", metrics: {}, summary: "" } }, run("missed", 25)]), NOW), /^met after its job · /,
    "the after-job measure is the verdict");
  assert.match(lastLabel(view([run("skipped", 1), run("met", 16)]), NOW), /^missed · /, "the newest slot did not run");
  assert.doesNotMatch(lastLabel(view([run("missed", 1)]), NOW), /missed/);
  assert.equal(lastLabel(view([]), NOW), "no run yet");
  assert.equal(dutiesCount([view([run("missed", 1)]), view([run("met", 1)])]), "2 duties, 1 off target");
});
