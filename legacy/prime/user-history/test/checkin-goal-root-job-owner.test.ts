// Prospect feature bro (01a11bd7) on 10-28: its goal p229 had one open step, p98, owned by "g2g accounts setup 10-20" (session 01a158eb), a root
// the AI harness chat started on 10-20, which reports to Prospect and was queued 64th of 66 for a working slot at the 04:14Z check-in. The
// check-in read that thread as no job of the chat, so goal_gaps flagged p229 "no live job owns it" twice in a row and asked for a push step;
// the chat had dropped p241, the one the first check-in added for the same job, as a duplicate of p98. The fixture is p229 as the board held it at 04:27Z.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses, type BoardFindings } from "../src/chat-checkin.ts";
import { goalGap } from "../src/checkin-goals.ts";
import { jobFacts, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { row } from "./chats-helpers.ts";

const NOW = Date.parse("2026-10-28T04:14:13.037Z");
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const G2G = "01a158eb-1de0-74a2-b73b-55b09d1621ba";
const board = (): ChatBoard => JSON.parse(readFileSync(new URL("./fixtures/prospect-board-p229-1028.json", import.meta.url), "utf8")) as ChatBoard;
const memory = { at: Date.parse("2026-10-28T03:14:11.152Z"), steps: {}, goals: { p229: { still: 1, pushed: { at: 1793150009585, reading: 1793145599000, value: 0.157, act: "start" },
  readings: [{ value: 0.112, at: 1792972799000, basis: "paced busiest-hour share on a full UTC prod day|share|<=" },
    { value: 0.157, at: 1793145599000, basis: "paced busiest-hour share on a full UTC prod day|share|<=" }] } } };
// The thread as gather read it: its catalog row (no chat), and pi-pool's queue place, which reads as working (`withQueuePlaces`).
const facts = (): JobFact[] => jobFacts([], board(), [row(G2G, "2026-10-28T04:12:00Z", { name: "g2g accounts setup 10-20" })], CHAT)
  .map(fact => ({ ...fact, state: "working", queued: { position: 64, total: 66, since: NOW - 2 * 60_000 } }));
const registry = ["prod watch reads 95", "staging doc ids refresh fault", "search sync batch fault"];

test("a root job that is no chat and works on the goal's only open step owns the goal", () => {
  const [g2g] = facts();
  assert.equal(g2g?.key, `thread:${G2G}`);
  assert.equal(g2g?.chat, undefined);
  const precheck = checkInPrecheck(memory as never, facts(), board(), NOW, { self: [CHAT, "Prospect feature bro"], jobs: registry });
  const p229 = precheck.goals.find(push => push.goal.id === "p229")!;
  assert.equal(p229.owner?.name, "g2g accounts setup 10-20");
  assert.notEqual(p229.act, "start");
  assert.equal(goalGap(p229), false);
  const findings: BoardFindings = { ...precheck, waitsMet: [], noProgress: null, stale: [], fold: [] } as never;
  const { metrics, flagged } = convergenceMisses(CHAT, precheck.steps, findings, {}, 60 * 60_000, NOW);
  assert.equal(metrics.goal_gaps, 0);
  assert.deepEqual(flagged.filter(slice => slice.kind === "goal_gaps"), []);
});

test("a thread that is a chat still owns no goal of this board", () => {
  const [fact] = jobFacts([], board(), [row(G2G, "2026-10-28T04:12:00Z", { name: "another chat", chat: true })], CHAT);
  assert.equal(fact?.chat, true);
  const precheck = checkInPrecheck(memory as never, [{ ...fact!, state: "working" }], board(), NOW, { self: [CHAT, "Prospect feature bro"], jobs: registry });
  const p229 = precheck.goals.find(push => push.goal.id === "p229")!;
  assert.equal(p229.owner, undefined);
  assert.equal(p229.act, "start");
});
