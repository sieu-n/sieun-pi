import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_REFUSED } from "../src/chats.ts";
import { jobLinkFinding, linkJobNames } from "../src/shared/job-mentions.ts";
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
