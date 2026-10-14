import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, type CheckInMemory, stepMemo, stepSig } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * c63: a rewritten waitFor is no progress. Crawler VP p39 sat blocked from 10-13 09:58Z while its waitFor was rewritten 98 times in the
 * chat's transcript; these are its last 8 texts at their real times. Each rewrite moved the step's sig, so the check-in read a fresh wait every
 * time and never a stale chase or a stall.
 */
const REWRITES: [string, string][] = [
  [
    "2026-10-14T03:25:44.216Z",
    "land 34's pin and candidate CI with ClickHouse readers, prod-move-0149 and durable 0149 green, then staging"
  ],
  [
    "2026-10-14T03:33:17.504Z",
    "land 34 run 38506757323 (d8f38b72a5) green with ClickHouse readers, prod-move-0149 and durable 0149 run, then staging about 04:45Z and metal's read-back"
  ],
  [
    "2026-10-14T03:49:18.613Z",
    "media serving build pushes the staging search Vercel blob (MEDIA_URL_KEY from its media layer), the check says ok, then the release owner re-dispatches land 34 at d8f38b72a5"
  ],
  [
    "2026-10-14T03:50:47.711Z",
    "the release owner re-dispatches land 34 at d8f38b72a5, its candidate CI green, staging, then promote 10 with the prod search blob push on the owner's go"
  ],
  [
    "2026-10-14T03:55:43.050Z",
    "land 34 run 38508691072 (d8f38b72a5, re-dispatched 03:54:51Z) green, staging after 04:45Z, metal's read-back, then promote 10 on the owner's go"
  ],
  [
    "2026-10-14T03:58:36.736Z",
    "the media job's fix moving metal-gate-baseline's 'nightly' job into its own workflow, the runner reviewer's trailer and metal's byte check, CAS, then the release owner re-dispatches land 34"
  ],
  [
    "2026-10-14T04:01:15.390Z",
    "ci/metal-gate-nightly-split-media 22a9f39382 (verify-dev 38509138964) green and metal's byte check, CAS, then the release owner re-dispatches land 34"
  ],
  [
    "2026-10-14T04:01:53.147Z",
    "verify-dev 38509138964 green, then the media job CASes 22a9f39382 and the release owner re-dispatches land 34"
  ]
];
const P39: PlanItem = { id: "p39", text: "Build image serving: which images to keep, a resolver for the rest, and a cache of fresh links", status: "blocked",
  job: "media serving build", children: [] };
const board = (waitFor: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-13T09:58:14.901Z", scratch: [], todos: [],
  plan: [{ id: "p30", text: "Images load on the search app", status: "doing", children: [{ ...P39, waitFor }] }] }) as unknown as ChatBoard;
const self = ["01a115e2-9544-7204-b8db-8ce4d5319048", "Crawler VP"];

test("c63: 8 real waitFor rewrites of Crawler VP p39 leave its clock where it was, so 90 min after the last one it is a stale chase to act on", () => {
  let memory: CheckInMemory | undefined;
  for (const [at, waitFor] of REWRITES) memory = checkInPrecheck(memory, [], board(waitFor), Date.parse(at), { self }).memory;
  const core = Date.parse("2026-10-13T09:58:14.901Z");
  assert.equal(memory!.steps.p39!.at, core, "no rewrite moves the step's last change from the board's 10-13 09:58Z");
  assert.equal(memory!.steps.p39!.waitAt, core, "no rewrite moves the wait's start");
  const later = Date.parse(REWRITES.at(-1)![0]) + 90 * 60_000;
  const precheck = checkInPrecheck(memory, [], board(REWRITES.at(-1)![1]), later, { self });
  assert.equal(precheck.steps.find(view => view.item.id === "p39")!.cls, "stale-chase", "the last rewrite was 90 min before, and the step has not moved since 10-13 09:58Z");
  assert.ok(precheck.stalled.some(stall => stall.view.item.id === "p39") || precheck.blocked.some(block => block.view.item.id === "p39"), "it is flagged to act on");
});

test("c63 migration: a memo written before the rule keeps its clocks when only the wait text changed, and a real change still moves them", () => {
  const core = Date.parse("2026-10-13T09:58:14.901Z");
  const [[, before], [at, after]] = REWRITES.slice(-2) as [[string, string], [string, string]];
  const old = { sig: JSON.stringify([P39.status, P39.text, P39.job, "", before]), at: core, wait: JSON.stringify([before, "", P39.job]), waitAt: core };
  const memo = stepMemo({ ...P39, waitFor: after }, old, Date.parse(at), core);
  assert.deepEqual([memo.sig, memo.at, memo.waitAt], [stepSig(P39), core, core], "the release keeps 10-13 09:58Z, not 04:01Z");
  const done = stepMemo({ ...P39, status: "done", waitFor: after }, memo, Date.parse(at) + 60_000, core);
  assert.equal(done.at, Date.parse(at) + 60_000, "a status change is a change");
  const cleared = stepMemo({ ...P39 }, memo, Date.parse(at) + 60_000, core);
  assert.equal(cleared.waitAt, Date.parse(at) + 60_000, "a wait that ends restarts the wait clock");
});
