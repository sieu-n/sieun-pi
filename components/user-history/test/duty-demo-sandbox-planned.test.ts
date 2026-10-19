// Guards d1's restarts_24h after frontend bro's ruling of 10-19: it counts only unplanned exits, so the deliberate fleet stops at 05:31Z and
// 05:33Z and the virev-demo stop at 07:37Z on 10-19 (pm2.log on us-metal02) read 0, while a crash and a dev-guard kill still count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restarts } from "../scripts/duties/demo-sandbox.ts";

const RUN_AT = Date.parse("2026-10-19T11:08:43Z");
const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "Z";
const HAND = [
  "2026-10-19T05:31:05: PM2 log: Stopping app:virev-demo id:5",
  "2026-10-19T05:31:05: PM2 log: App [virev-demo:5] exited with code [0] via signal [SIGINT]",
  "2026-10-19T05:33:18: PM2 log: Stopping app:virev-demo id:5",
  "2026-10-19T05:33:20: PM2 log: App [virev-demo:5] exited with code [0] via signal [SIGINT]",
  "2026-10-19T07:37:15: PM2 log: Stopping app:virev-demo id:5",
  "2026-10-19T07:37:15: PM2 log: App [virev-demo:5] exited with code [0] via signal [SIGINT]",
];

test("deliberate pm2 restarts and stops are planned and do not count", () => {
  const { events, planned } = restarts(HAND.join("\n"), "", RUN_AT, "Etc/UTC");
  assert.equal(events.length, 0);
  assert.deepEqual(planned.map(exit => iso(exit.at)), ["2026-10-19T05:31:05Z", "2026-10-19T05:33:20Z", "2026-10-19T07:37:15Z"]);
});

test("a crash and a dev-guard memory kill still count", () => {
  const log = [...HAND,
    "2026-10-19T09:00:00: PM2 log: App [virev-demo:5] exited with code [1] via signal [SIGINT]",
    "2026-10-19T10:00:00: PM2 log: App [virev-demo:5] exited with code [97] via signal [SIGINT]",
  ].join("\n");
  const { events, planned } = restarts(log, "", RUN_AT, "Etc/UTC");
  assert.deepEqual(events.map(event => [iso(event.at), event.kinds.join()]), [["2026-10-19T09:00:00Z", "crash"], ["2026-10-19T10:00:00Z", "guard"]]);
  assert.equal(planned.length, 3);
});
