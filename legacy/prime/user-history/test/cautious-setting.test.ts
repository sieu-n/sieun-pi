// Guards c72's whole rule (d10 p1258, 10-28): the hold-ask and lane-hold checks saw two shapes, only on the board, so tell_owner texts, job
// briefs and step notes that kept a pause, an idle account, an avoided login, a held push, a country pin or another chat's stop line went
// through. The owner: "you keep instinctually making bad defaults, overly safe bullshit behaviour" (10-14), "why pause/do all that bespoke
// bullshit at all?" (10-27).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOps } from "../src/agent-board.ts";
import { tellOwner } from "../src/chat-guard.ts";
import { briefCheck } from "../src/shared/brief-check.ts";

const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const FLAG = /c72, rule 7/;
const summaries = async (ops: unknown[]): Promise<string[]> => (await applyAgentOps(mkdtempSync(join(tmpdir(), "cautious-")), CHAT, ops)).summaries;
const flagged = async (ops: unknown[]): Promise<void> => assert.ok((await summaries(ops)).some(line => FLAG.test(line)), JSON.stringify(ops));
const passes = async (ops: unknown[]): Promise<void> => assert.ok(!(await summaries(ops)).some(line => FLAG.test(line)), JSON.stringify(ops));
const note = (text: string): unknown[] => [{ op: "plan_add", text: "Census speed", note: text }];
const todo = (text: string, choices?: string[]): unknown[] => [{ op: "todo_add", text, ...choices ? { choices } : {} }];

/** tell_owner on the owner's own turn, so only the content checks speak; then the same text again, which goes out (c98). */
function told(text: string): { first: string; again: string } {
  const first = tellOwner({ text, why: "answer" }, { owner: true, ownerIds: new Set() }, Date.now(), () => true);
  const again = tellOwner({ text, why: "answer" }, { owner: true, ownerIds: new Set(), resent: new Set([text]) }, Date.now(), () => true);
  return { first: first.kind === "sent" ? "sent" : first.text, again: again.kind };
}
const refused = (text: string): void => { const result = told(text); assert.match(result.first, /cautious setting.*c72/s, text); assert.equal(result.again, "sent"); };
const sent = (text: string): void => assert.equal(told(text).first, "sent", text);
const briefFlags = (task: string): boolean => briefCheck(`Owner's words (verbatim): 1. make census faster\n\nMy read: speed.\n\nSplit: one job.\n\n${task}`)
  .some(finding => finding.kind === "cautious-setting");

test("the 10-14 tell_owner texts that asked him whether to log accounts in or to switch a pause off are refused once", () => {
  refused("I misquoted the risk: the 7 of 8 bans came from a different, older login method, while this one got 2 of 35 prod accounts banned within 3 days. So I put one question in For you: whether to log the 10 expired accounts back in and let the system re-log by itself.");
  refused("Watchlist green fell to 48%: our crawler's proxy safety pause keeps stopping all reading, so prod got 39 good reads last hour against about 1,900 before. The fix is in the next release, hours away, so I put one question in For you: switch the pause off by hand on prod now.");
  refused("Turning the pause off in For you would let reads retry through the failures.");
  refused("Want me to drop the 6 spares too?");
});

test("tell_owner texts that report a lane held until a fix, under another chat's line, or a setting kept or added to be safe are refused once", () => {
  refused("Prod crawling is back on. The census runs under a fresh safety watch. That lane stays off until its new error rule passes review.");
  refused("So prod stays paused until GeoNode fixes it.");
  refused("The 2,100 cap is metal's 75 MB/s disk-write line, a caution limit, not the drive being full.");
  refused("Should I keep the 600 s opening hold only after a database restore, or drop it?");
  refused("I added a 30 minute cool-down between logins to be safe, so fewer accounts get flagged.");
  refused("I left the 12 staging Instagram accounts idle as spares, so prod reads run on the other 35.");
});

test("tell_owner texts that delete a setting, cite the failure it prevents, or name the owner's own limits go out", () => {
  sent("I deleted the 600 s opening hold, so the next deploy starts no pause and reads keep going.");
  sent("Please hold off saying yes to the promote for now. On staging, every crawl that goes through a proxy now times out.");
  sent("Census is at 2,400 slots now, up from 2,100, and good reads rose to 9,800 a minute.");
  sent("Keep pi-pool's admission threshold at 85% for the Codex accounts?");
  sent("A new workspace stays paused until the user presses Start, and the 24/7 popup is gone.");
});

test("board steps and todos that keep, add or ask about a cautious setting, or ask him to delete one the chat may delete, carry the c72 flag", async () => {
  await flagged(note("Census stays at 96 slots because metal's IO stop line pauses it above 30k IOPS."));
  await flagged(note("Make the 600 s opening hold restore-only so a plain deploy starts none."));
  await flagged(note("Added a 30 min cool-down between Instagram logins to be safe."));
  await flagged(note("Hold the push to main until tomorrow's quiet window."));
  await flagged(note("Done when watch reads hold 95% green. The 12 staging accounts stay idle as spares."));
  await flagged(todo("Log the 10 expired staging accounts back in, or leave them logged out for now?"));
  await flagged(todo("Turn the proxy safety pause off by hand on prod now?"));
  await flagged(todo("Pin GeoNode watch reads to the US pool, or keep the default pool?"));
  await flagged(todo("Should we buy 3 to 5 sender accounts?", ["Buy 3 accounts", "Keep DM paused"]));
  await flagged(todo("Delete the pause instead of keeping it after restores?", ["Delete it", "Wait"]));
});

test("board steps that remove a setting, back it with a measurement, or describe a product's own pause pass", async () => {
  await passes(note("Done when the next prod crawler deploy starts 0 s of opening hold and the Watchlist stays green through it."));
  await passes(note("Without the hold, the 10-12 restore banned 41 accounts in 6 minutes, so the 600 s hold stays after a restore."));
  await passes(note("Done when the cause is named, fixed with a test or alert, and no kill limit or cap was added."));
  await passes(note("New workspaces stay paused until Start, with saved hours and timezone shown."));
});

test("a job brief that keeps a hold, holds a lane until a land, avoids logins or pins a country gets a brief check", () => {
  assert.ok(briefFlags("Keep census at 128 slots until land 37 is live, then step up."));
  assert.ok(briefFlags("Keep the 600 s opening hold; only shorten it to 300 s."));
  assert.ok(briefFlags("Add a 10 s delay between census batches to be safe."));
  assert.ok(briefFlags("Do not log in the 10 expired accounts; leave them logged out until the ban wave passes."));
  assert.ok(briefFlags("Call GeoNode with country=US for the census lane."));
  assert.ok(!briefFlags("Delete the opening hold entirely: BOOTSTRAP_OPENING_HOLD_SECONDS, its callers, its tests and its docs. Add one test that a deploy's schema bootstrap leaves openings open."));
  assert.ok(!briefFlags("Raise census from 128 to 256 slots now and read good reads per minute over 15 minutes."));
});
