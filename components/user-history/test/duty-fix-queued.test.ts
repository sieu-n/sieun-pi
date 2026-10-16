import assert from "node:assert/strict";
import { test } from "node:test";
import { fixJobLive, sessionBornAt, UNLISTED_LIVE_MS } from "../src/shared/duty-fixes.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

// fixJobLive says whether a duty metric's fix step has a job at work, for the run record's fixes. On 10-15 a job that waited in the turn
// queue read idle everywhere but its `queued` place (api portal vp, d2), and a root job's place showed only in pi-pool.

const CHAT = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 9, 15, h, m, s);

test("a fix job with a turn queue place is live, and one with no place and no working row is not", () => {
  const item = { id: "p29", job: "fix portal matches crawler api portal vp 22:58", sessionId: "fix1" };
  const agent = { key: "thread:fix1", sessionId: "fix1", name: item.job, job: "session:fix1", sender: item.job, link: "step", state: "idle", steps: ["p29"] } as ChatAgent;
  const rows = (extra: Partial<ChatAgent>) => [{ id: CHAT, agents: [{ ...agent, ...extra }] } as unknown as SessionRow, { id: "fix1", archived: false, working: false } as unknown as SessionRow];
  assert.equal(fixJobLive(item, CHAT, rows({}), new Set()), false, "an ended job with nothing pending is not live");
  assert.equal(fixJobLive(item, CHAT, rows({ queued: { position: 46, total: 46, since: at(14, 1, 17) } }), new Set()), true, "46th of 46 at 14:01:17Z");
});

// A fix job is a root session, not an agent of the chat, so its queue place shows only in pi-pool, and a session the daemon just made may
// not be in the catalog rows yet. The id below is the 01:09 job's session, which p128 to p130 name; the daemon made it at 16:09:49Z.
test("a root fix job with a pi-pool place, or one the catalog does not list yet, is live; an old unlisted one is not", () => {
  const first = "01a14053-b42b-723b-8ae3-1b13b72d392e";
  const born = sessionBornAt(first)!;
  assert.equal(new Date(born).toISOString(), "2026-10-15T16:09:49.867Z");
  const item = { id: "p128", job: "fix check-in launch main bro 01:09", sessionId: first };
  const chat = { id: CHAT, agents: [] } as unknown as SessionRow;
  const idleRow = { id: first, archived: false, working: false } as unknown as SessionRow;
  assert.equal(fixJobLive(item, CHAT, [chat, idleRow], new Set(), new Set([first]), born + 21_000), true, "queued in pi-pool 21 s after its create");
  assert.equal(fixJobLive(item, CHAT, [chat, idleRow], new Set(), new Set(), born + 21_000), false, "listed, idle and in no queue: ended");
  assert.equal(fixJobLive(item, CHAT, [chat], new Set(), new Set(), born + 21_000), true, "not in the catalog rows yet");
  assert.equal(fixJobLive(item, CHAT, [chat], new Set(), new Set(), born + UNLISTED_LIVE_MS), false, "gone from the catalog past the list's worst lag");
  assert.equal(sessionBornAt("fix1"), null);
});
