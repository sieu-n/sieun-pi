import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, finishedJobs, lastJobMessages } from "../src/chat-checkin.ts";
import { stepNamesJob } from "../src/checkin-steps.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

/**
 * launch main bro 10-14 04:11Z to 04:24Z (service.log 48882 to 49278): the 04:11Z check-in moved 13 build steps' job to "release driver" (session
 * 01a1389b), which watches the train, and wrote in each note which build job still pushes the step's commits. finishedJobs read only the step
 * owner and waitFor, so the chat server deleted instagram access canary and watchlist all green at 04:12Z, and fair crawl queue and collab lane
 * self balance at 04:24Z, each "no open step", while they held pushes parked for 'released'. The steps and messages below are the real ones: the
 * waitFor texts from the 04:08Z board read of check-in 01a13898, the notes from its 04:11Z plan_update, and each job's last messages from the
 * chat's session file (01a11bd7, the lines named).
 */
const NOW = Date.parse("2026-10-14T04:24:30.000Z");
const RELEASE_DRIVER = "01a1389b-63c7-75c9-8397-33705fb9d3d2";
const STEPS: PlanItem[] = [
  { id: "p85", text: "Build: a read waits for its turn to open an Instagram session instead of being refused, so prod uses every session slot", status: "doing", job: "release driver",
    waitFor: "Fable's 'released' after land 34's re-run is green (re-dispatch due about 04:40Z after the nightly split); then job-retry, in-session and openings push fresh, green, CAS",
    note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35 and has the chat wake instagram access canary for the push at each point; instagram access canary still builds and pushes this step's commits.", children: [] },
  { id: "p75", text: "Build: the test group can read past 1,000 pages, then it goes back to 2,000 on prod; the standing 10% test group runs as the engage duty", status: "doing", job: "release driver",
    waitFor: "land 34's re-run and promote 10 (after about 06:00Z); then the job sets the arm to 2,000 on 115, 123, 138, 145, 147, 151, 153, 163, 166, 182 and sends the audit id; 5 days of verdicts",
    note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35 and has the chat wake instagram access canary for the push at each point; instagram access canary still builds and pushes this step's commits.", children: [] },
  { id: "p57", text: "Build: a fair crawl queue where each org gets its share and each kind of read gets a fair turn, staging first", status: "doing", job: "release driver",
    waitFor: "land 34's re-run and promote 10 (after about 06:00Z); then land 35: the NOTNULL_COLUMN=deficit fix with a fresh mgb, the lease gauge, the walk-stage fix",
    note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35 and has the chat wake fair crawl queue for the push at each point; fair crawl queue still builds and pushes this step's commits.", children: [] },
  { id: "p97", text: "Build: the collab claim split sizes itself from the re-read backlog, so daily re-reads stay inside 24 h with no hand-set share", status: "doing", job: "release driver",
    waitFor: "ci/watchlist-staged-collab-walk-r14 pushed at 'released' (watchlist add account rebuilds it on the dev tip); stack on it; push; green; CAS; land 35",
    note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35 and has the chat wake collab lane self balance for the push at each point; collab lane self balance still builds and pushes this step's commits.", children: [] },
  { id: "p90", text: "Fix: deleted Instagram accounts show 'Removed on Instagram', count as checked and keep their data", status: "doing", job: "release driver",
    waitFor: "Fable's 'released' after land 34's re-run is green (re-dispatch due about 04:40Z after the nightly split); then gone-UI r9 pushes, green, CAS",
    note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35 and has the chat wake watchlist all green for the push at each point; watchlist all green still builds and pushes this step's commits.", children: [] },
];
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-14T04:11:30.000Z", todos: [],
  plan: [{ id: "p82", text: "Crawler queue and year-deep walks: fair claims, walk handoffs, capacity dashboard", status: "doing", children: plan }] });
const BOARD_0411 = board(STEPS.map(step => ({ ...step, sessionId: RELEASE_DRIVER })));
/** The same steps with notes that name no build job, as a relink that lost them would leave the board. */
const UNNAMED = board(STEPS.map(step => ({ ...step, sessionId: RELEASE_DRIVER,
  note: "04:1xZ check-in: the job release driver (session 01a1389b) watches land 34's re-dispatch, promote 10 and land 35." })));
const said = (at: string, content: string) => ({ role: "custom", customType: "agent_message", content, timestamp: Date.parse(at) });
const MESSAGES = [
  /* chat session line 9908 */ said("2026-10-14T01:49:41.722Z", "[agent-message from child:instagram access canary]\n\nThe canary arm is CAS'd onto local sieun/dev: tip dd46e85dbd moved to 5cbba65e9e (full sha 5cbba65e9e80af0c5ca045ad0c2d3b4143917bc2).\nIt's 3 commits, each patch-id matched to the green r13 run 38492712967: 1a9eb45147 (canary arm, was 38565d2728), a500d7738f (rate arm 5,000 ceiling, was a36e3ff1f1) and 5cbba65e9e (COHORT_HASH to tuning, was b9a44e8aab).\nThe diff vs the old tip is 9 crawler-v3 files, +430/-24, only my files. I did it with update-ref and the old tip as the expected value, so commit.mjs wasn't needed.\nOnce it's on prod, I'll write the 2000 arm on 115,123,138,145,147,151,153,163,166,182 and send you the audit id."),
  /* chat session line 9909 */ said("2026-10-14T01:49:41.723Z", "[agent-message from child:instagram access canary]\n\nOne follow-up on the CAS. The shared checkout's HEAD is sieun/dev, so update-ref left the shared index holding the old blobs for my 9 files, staged as a revert of the canary. I reset just those 9 index entries to 5cbba65e9e (git reset 5cbba65e9e -- <9 paths>), and the index now matches HEAD for them.\nThe working tree is a different story. Seven of those files have other sessions' uncommitted edits on top of the old content: controls.py, metrics/health.py, control/tuning.py, engage/experiment.py, engage/read.py and test_engage_read.py, plus test_engage_canary.py, which is missing from the tree.\nAnyone who commits those working-tree files whole would undo the canary. I didn't touch the shared tree, under the no-shared-tree-edits rule. Please flag this to the release owner, who should rebase those sessions' edits onto 5cbba65e9e before they commit."),
  /* chat session line 10018 */ said("2026-10-14T02:14:13.816Z", "[agent-message from child:watchlist all green]\n\nGone guard landed: b251f3398793d32675f1a84c35485b3ce0aaa325 on local sieun/dev (was 7bd64ea68f), CAS'd on r3 run 38496593350's green (attempt 1, every job passed). Patch-id matched 3b80dbe4fe, and the tip changes didn't touch its files. Note: land-object left 5 working-tree files alone (receipt.py, receipt_statements.py, tuning.py and 2 test files) because they hold someone else's uncommitted content; the commit itself is complete. Gone-UI r9 is ready for 'released'."),
  /* chat session line 10041 */ said("2026-10-14T02:19:03.482Z", "[agent-message from child:watchlist all green]\n\nIt's already landed: b251f3398793d32675f1a84c35485b3ce0aaa325 on local sieun/dev, CAS'd at about 02:10Z on r3's green with the patch-id matched to 3b80dbe4fe. It's an ancestor of the current tip."),
  /* chat session line 10132 */ said("2026-10-14T03:17:27.558Z", "[agent-message from child:collab lane self balance]\n\nThe walk-stage fix leaves my reserved need as it is, and I won't change the code for it. My first-pass reserve uses capacity.deep_walk_sql for both the due rows and the open claims. That reads depth_days, walk_done_at, walk_end and walk_cursor and never walk_until. For a collab row, the first pass ends only when the receipt sets walk_end since at the 30-day op boundary (r13's first_pass_end). For any other kind it ends when the first chunk parks a cursor. So a walk that ci/walk-position-3 holds at stage 30 longer still moves to the deep side at the same moment. Its longer stage 30 only puts it earlier in fair.py's order among the deep walks, inside the deep limit. The deadline is unchanged too: walk_since + depth_days + 24 h, or the due time + 24 h if that comes first. I'm still waiting for the r14 sha to stack on and push ci/collab-reread-split."),
  /* chat session line 10142 */ said("2026-10-14T03:19:49.835Z", "[agent-message from child:fair crawl queue]\n\nThe land 35 walk-position fix is built, as objects only on tip 4c79491a2d, and nothing is pushed:\n- 8061f109be and 87c3c47dbe replay ci/walk-position-3's two commits (same patch-ids).\n- 51afa59775 is ours: walk_reached now returns coverage.walk_position (the oldest of each page's newest pk/date, with the next cursor as fallback) instead of oldest_at. OPS reads page_newest and newest_pk with coverage's own SQL, and the helper is imported, not copied. New test: chunk 1 has an old post tagged late (1,500 d) among recent ones, walk_until = the 6-day position, stage 30. It's 5 files, +96/−28, with receipt.py at 902 lines.\nFor collab lane self balance's author: the deep/first split (capacity.deep_walk_sql) reads only depth_days > 30, walk_done_at IS NULL and walk_cursor IS NOT NULL, never walk_until, so this fix changes nothing in the split. Only fair.py's 30/90/365 stage order moves, and a walk now stays at stage 30 until its position really passes 30 days.\nIt pushes with the land 35 set at \"released\": lease gauge r8, the 0147 NOTNULL fix (+ mgb), and this one. If walk-position-3 lands on its own first, I'll drop the two replays."),
];
const job = (id: string, name: string, at: string, extra: Partial<ChildAgent> = {}): ChildAgent =>
  ({ id, label: name, sessionName: name, status: "done", repliedSinceTask: true, lastActivityAt: Date.parse(at), ...extra });
const JOBS: ChildAgent[] = [
  job("sub-5f8c98a8", "instagram access canary", "2026-10-14T01:49:45.000Z", { sessionId: "01a13051-bf3d-752b-adb2-3de0eb638b73" }),
  job("sub-a3ea2ca6", "watchlist all green", "2026-10-14T02:19:10.000Z", { sessionId: "01a122bb-982b-7295-a9dd-e62d6e496469" }),
  job("sub-18a7839f", "fair crawl queue", "2026-10-14T03:19:55.000Z", { sessionId: "01a12e08-4448-756e-92c1-641a6530e16a" }),
  // Its rlm child id is not in the chat's session file; the id is a stand-in.
  job("sub-collab-lane", "collab lane self balance", "2026-10-14T03:17:30.000Z"),
];
const names = (children: readonly ChildAgent[]): string[] => children.map(child => child.sessionName ?? child.label);

test("launch main bro 04:1xZ: the four build jobs the 04:11Z notes name are not finished jobs, though the release driver owns their steps", () => {
  assert.deepEqual(names(finishedJobs(JOBS, BOARD_0411, lastJobMessages(MESSAGES))), [], "the step notes name all four");
});

test("launch main bro 04:1xZ: with no step naming them, the jobs whose last reply holds parked work stay and a plain final report is deleted", () => {
  const kept = lastJobMessages(MESSAGES);
  assert.match(kept.get("fair crawl queue")?.parked ?? "", /released/, "10142: \"It pushes with the land 35 set at \"released\"\"");
  assert.match(kept.get("collab lane self balance")?.parked ?? "", /still waiting for/i, "10132: \"I'm still waiting for the r14 sha\"");
  assert.match(kept.get("instagram access canary")?.parked ?? "", /once it's on prod/i, "9908 and 9909 are one reply sent 1 ms apart");
  assert.equal(kept.get("watchlist all green")?.parked, undefined, "10041: \"It's already landed\" is a plain report");
  assert.deepEqual(names(finishedJobs(JOBS, UNNAMED, kept)), ["watchlist all green"]);
});

test("launch main bro 04:1xZ: a step names a job by id or whole-word name in job, waitFor, note or text; a short name or a part of a word does not count", () => {
  const step = (fields: Partial<PlanItem>): PlanItem => ({ id: "p1", text: "Build", status: "doing", children: [], ...fields });
  const fair = { id: "sub-18a7839f", names: ["fair crawl queue"] };
  assert.ok(stepNamesJob(step({ waitFor: "then fair crawl queue pushes the lease gauge" }), fair));
  assert.ok(stepNamesJob(step({ note: "Fair Crawl Queue still pushes it" }), fair), "case folded");
  assert.ok(stepNamesJob(step({ text: "Build: hand sub-18a7839f's commits over" }), fair), "by id");
  assert.ok(stepNamesJob(step({ job: "fair crawl queue" }), fair));
  assert.ok(!stepNamesJob(step({ note: "a global fair crawl queues design" }), fair), "part of a longer word");
  assert.ok(!stepNamesJob(step({ note: "push to sieun/dev at 'released'" }), { id: "sub-1", names: ["dev"] }), "a name under 6 characters never counts in free text");
  assert.ok(stepNamesJob(step({ job: "dev" }), { id: "sub-1", names: ["dev"] }), "an owner match counts at any length");
  assert.ok(!stepNamesJob(step({ note: "the rebuilder pushes" }), { id: "sub-2", names: ["builder"] }));
});

test("launch main bro 04:1xZ: the precheck warns about an ended job whose last reply holds parked work when no open step names it", () => {
  const said = lastJobMessages(MESSAGES);
  const facts = JOBS.map(child => ({ key: child.id, name: child.sessionName!, state: "ended" as const, replied: true, lastMessage: said.get(child.sessionName!)! }));
  const warned = checkInPrecheck(undefined, facts, UNNAMED, NOW).facts.filter(line => /parked work/.test(line));
  // p57's text, "a fair crawl queue where each org gets its share", names fair crawl queue, so only two warn.
  assert.deepEqual(warned.map(line => line.split(" said at ")[0]), ["instagram access canary", "collab lane self balance"], warned.join("\n"));
  assert.ok(warned.some(line => line.startsWith("collab lane self balance said at ") && /\("still waiting for"\), but no open step names it/.test(line)), warned.join("\n"));
  assert.deepEqual(checkInPrecheck(undefined, facts, BOARD_0411, NOW).facts.filter(line => /parked work/.test(line)), [], "the 04:11Z notes name all four");
});
