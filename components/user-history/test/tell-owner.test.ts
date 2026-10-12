import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_REFUSED } from "../src/chats.ts";
import { jobLinkFinding, linkJobNames, unlinkedJobSentence } from "../src/shared/job-mentions.ts";
import type { ChatAgent } from "../src/shared/types.ts";
import { linkableJobs, tellOwnerChecked } from "../src/tell-owner.ts";

/** tell_owner texts the chats sent the owner on 10-12, each pointing at a job with no job: link (chat health unlinked_job_mentions). */
const API_PORTAL = "No, only 72 of 176 crawler routes work the same through the portal, with 74 missing and 21 broken. I started four fix jobs on staging for YouTube paging, the broken crawler routes, batch, and the missing routes.";
const LAND_33 = "Land 32b failed again, this time on the signed-in search test. A new job is fixing the test for land 33.";
const SEND_TEST = "I recorded your rule again. A job now builds a test that fails if an agent can send without your ok.";
const API_PORTAL_JOBS = ["broken crawler routes", "youtube live cursors", "portal batch setup", "reader dm send"];

const agent = (job: string, lastActivityAt?: string): ChatAgent => ({ key: "child:" + job, name: job, job, sender: job, link: "subagent", state: "working", steps: [],
  ...(lastActivityAt ? { lastActivityAt } : {}) });

test("tell_owner: a reply that names a job in plain words is refused with the same text, the job linked (api portal vp, 10-12)", async () => {
  const result = await tellOwnerChecked(API_PORTAL, "", async () => API_PORTAL_JOBS);
  assert.equal(result.ok, false);
  assert.ok(result.text.startsWith(TELL_OWNER_REFUSED), result.text);
  assert.ok(result.text.endsWith(API_PORTAL.replace("the broken crawler routes", "the [broken crawler routes](job:broken crawler routes)")), result.text);
});

test("tell_owner: a reply that points at a job it does not name is refused with the chat's job names to link (ops guy, 10-12)", async () => {
  for (const text of [LAND_33, SEND_TEST]) {
    const result = await tellOwnerChecked(text, "", async () => ["land 33 test", "send guard test"]);
    assert.equal(result.ok, false, text);
    assert.match(result.text, /points at a job with no link: name each job you mean as \[name\]\(job:name\)\. One of yours: \[land 33 test\]\(job:land 33 test\), \[send guard test\]\(job:send guard test\)\./);
  }
  const linked = await tellOwnerChecked("[land 33 test](job:land 33 test) is fixing the signed-in search test.", "", async () => { throw new Error("not read when the text links its job"); });
  assert.deepEqual(linked, { ok: true, text: "told the owner" });
});

test("tell_owner: lint findings and the job link come back in one refusal; a reply with no job in it never loads the job list", async () => {
  const both = await tellOwnerChecked("Update: a new job is fixing the test for land 33.", "", async () => ["land 33 test"]);
  assert.equal(both.ok, false);
  assert.match(both.text, /label opener "Update:"/);
  assert.match(both.text, /\[land 33 test\]\(job:land 33 test\)/);
  assert.deepEqual(await tellOwnerChecked("The audit is done; nothing failed.", "", async () => { throw new Error("not read"); }), { ok: true, text: "told the owner" });
  assert.deepEqual(await tellOwnerChecked("x".repeat(401), "", async () => []), { ok: false, text: "shorter: one or two sentences" });
});

test("job links: only plain mentions of names with two or more words are linked, never inside a link, code or a URL", () => {
  assert.equal(linkJobNames("The census runs, and broken crawler routes is next.", ["census", "broken crawler routes"]), "The census runs, and [broken crawler routes](job:broken crawler routes) is next.");
  assert.equal(linkJobNames("See [broken crawler routes](job:broken crawler routes) and `broken crawler routes`.", ["broken crawler routes"]),
    "See [broken crawler routes](job:broken crawler routes) and `broken crawler routes`.");
  assert.equal(linkJobNames("Quiet Authority Plan started.", ["quiet authority plan"]), "[Quiet Authority Plan](job:quiet authority plan) started.");
  assert.equal(jobLinkFinding("Its gate run was green.", ["land 33 test"]), null);
});

test("job links: the names a refusal lists are the chat's jobs, most recently active first, without threads it only talks to", () => {
  const thread: ChatAgent = { ...agent("session:01a1"), link: "step" };
  assert.deepEqual(linkableJobs([agent("old job", "2026-10-12T01:00:00Z"), thread, agent("new job", "2026-10-12T13:00:00Z"), agent("quiet job")]), ["new job", "old job", "quiet job"]);
});

/** The sentences chat health flagged in tell_owner replies on 10-12 that talk about CI runs, crawler work or jobs in general, not one agent job. */
const NOT_POINTERS = [
  "The plan is down to 5 open goals from 10: chats and jobs running reliably, agent tools and the send guard, repo tooling, llm-wiki and sieun-pi.",
  "Your \"stop inventing waiting rules\" order is now in the chat and job briefs, and it ships in the next chat app release.",
  "Board, job and git rules moved into a skill that chats read only when needed.",
  "Since both are your code, the locked account mainly guards against a bad package or broken job in slack-green messing with our CI files or deploy keys.",
  "Every light test job spends about 21 minutes downloading all its packages again, because its package store is wiped after each job.",
  "The land gate's test job installed in 14 seconds instead of 21 minutes.",
  "Its gate run was green on all 8 jobs, and the release owner dispatched it at 12:18Z, so staging should get it around 13:05 to 13:20Z.",
  "A test run at 13:41Z gave real numbers: in the last hour, heavy jobs waited at most 8.5 minutes, light jobs 0.1, and nothing is waiting now.",
  "Its first read is bad: only 66% of new-profile jobs finish, a blocked read takes 19 s to retry, and we use 52 of 150 Mbps.",
  "Prod census is back on through us-08 and passed its 15-minute check: 98% of jobs ok, no account holds.",
  "Then it doubles every 15 minutes while jobs stay clean, up to the disk limit of about 25k a minute.",
];
/** The 10-12 tell_owner sentences that do point at an agent job with no link. */
const POINTERS = [
  "A job got a test key working against it today.",
  "I started four fix jobs on staging for YouTube paging, the broken crawler routes, batch, and the missing routes.",
  "Done, the cap is now 2 outbound DMs per account per day, and the job has the change.",
  "Five more jobs are building in parallel.",
  "Sorry, this got stuck in a 31-hour outage, and your Watchlist notes never reached the job.",
  "The Mac is overloaded, so I closed 4 idle jobs to free memory, and their work is saved.",
  "A new job rebuilds Creators as a product-like demo: funnel numbers per list, live email and AI results in the review, template auto-send, and default AI columns.",
  "Every other job now runs its remaining parts in parallel, and only browser checks wait for the Mac's load.",
  "Heads up: the job also renamed 37 blog post categories in the live database without asking.",
  "frontend bro may restart one job now, but its browser checks wait until memory frees up.",
  "Once swap is under 16 GB, frontend bro can start its second job.",
  "Slack green's runner on the M1 Air is staged, and the last part needs your Air password: run [these two sessions , and tell me when session 2 stops at the token line so the job can finish the install.",
  "Four jobs started: a baseline count, keyword and competitor research, Reddit and backlinks with your ok on each post, and signups.",
  "Everything is back now: I asked Fable to restart the release queue, restarted our four stuck jobs, and our fixes are being rebuilt on today's code.",
  "One heads-up: while checking, my job sent one keypress and one click while your chat window may have had focus.",
  "Slack-green gets its own locked account, so its jobs can't read your logins or our deploy keys.",
  "One job now fixes the red tests blocking land 32b, whoever owns them, and clears the queue.",
  "The fix is the land 32b recut that the unblock job is clearing, then reusing green test runs at land time.",
  "Ops guy says you told him to go ahead at session 1, so his install job runs the second session itself once land 32b reaches staging.",
  "A new job is fixing the test for land 33.",
  "A job now builds a test that fails if an agent can send without your ok.",
  "Ops guy's install job uses it for slack-green's second session after staging.",
  "I dropped every iWebFusion step from the board, deleted the new server job, and recorded your rule so no job tracks it again.",
  "The job that built them is fixing it now.",
  "I was wrong about the stray \"connect me with human\" line: neither job sent it, so it likely came from your own GeoNode tab.",
];

test("job mentions: counts of CI runs or crawler jobs and jobs in general are not job pointers; the 10-12 sentences that name an agent job still are", () => {
  for (const sentence of NOT_POINTERS) assert.equal(unlinkedJobSentence(sentence), null, sentence);
  for (const sentence of POINTERS) assert.equal(unlinkedJobSentence(sentence), sentence, sentence);
});
