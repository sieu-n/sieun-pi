/**
 * `relay-line.ts` and `comm-guard.ts` on the agent posts of apps/chat's room logs (11-03): the relay lines are marked with their kind, and
 * the results and answers beside them are not; a comm thread's post after its hand-over in the same turn is refused unless it asks a question,
 * hand-over words are refused on any turn, and progress words only on a turn the owner did not start.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { commPostRefusal, turnStartedAt } from "../../src/durable/comm-guard.ts";
import { relayWords } from "../../src/durable/relay-line.ts";

/** Agent posts from the room logs that relay the agent's own work, with the kind each one reads as. */
const RELAYS: [string, "handoff" | "progress"][] = [
  ["The vent thread is now listing every panel, including Vent, admin, Grafana and the rest, with its data, backend and a tested login, on one wiki page.", "progress"],
  ["The agent factory work thread is building all five now, including the wip emoji, auto-tagging channel members and @ for agents outside the channel.", "progress"],
  ["The agent factory work thread is fixing all three on live :5184, and it will send a shot of gpt guy's panel when done.", "handoff"],
  ["The job [agents list shows agents only](job:agents list shows agents only) is fixing it so pickers list only agents and jobs stay inside their agent (p29).", "progress"],
  ["The job tailscale gate design is mapping each screen and writing the design page for p1.", "progress"],
  ["Got it on the health light, real traffic only and grey when there's none. I passed that to the job vent integration health.", "handoff"],
  ["I started 4 jobs that run in parallel: vent landing and deploy, vent caller cutover, vent webhooks and vent console.", "handoff"],
  ["It should print 6 lines. The work thread is running it now, and I'll confirm the real count when it finishes.", "handoff"],
  ["I'll post the wiki link here once the list is done.", "handoff"],
  ["I asked the vent work thread to build the full list.", "handoff"],
  ["I sent the task to the work thread.", "handoff"],
  ["On it.", "handoff"],
  ["지금 konti domain finish가 그 로그인으로 직접 들어가서 konti.bot 리다이렉트 걸고, 끝나면 결과만 알려드릴게요.", "handoff"],
];

/** Results and answers from the same logs, which no check may mark. */
const RESULTS = [
  "Vent's console is at vent.virev.ai for prod and staging-vent.virev.ai for staging, but I don't have each panel's sign-in on hand yet.",
  "Makes sense, Accounts moves into a tab under Settings and leaves the top bar.",
  "gpt guy's panel is fixed on :5184, and he shows Idle now because his GPT runs work again.",
  "The @ list and the Agents page now show only agent factory and vent, with each job inside its agent under a short title.",
  "Plan lives in the Convex table searchCreditBalances, one row per org with plan, included pool, Stripe subscription id and status, and period dates.",
  "The loop finished and printed 6 lines, so result.txt now says 6.",
  "summaries.md is done, with one line for each of the 20 files.",
  "Each screen gets its own Tailscale address on us-metal01, and Grafana and Vent log you in from your Tailscale identity.",
  "Should I start a job to move these dashboards behind Tailscale now?",
  "Release 21 fixed the frozen Vercel and Railway panels, so the small prod Vent update on t15 isn't needed.",
  "Removed 120 committed leftovers plus 1,546 local junk files from the checkout.",
  "Stopped. The Railway job and its helpers are shut down, and I sent the Railway Breach thread where things stand.",
];

test("the relay lines of the room logs read as hand-over or progress, and the results and answers beside them read as neither", () => {
  for (const [text, kind] of RELAYS) assert.equal(relayWords(text)?.kind, kind, text);
  for (const text of RESULTS) assert.equal(relayWords(text), undefined, text);
});

test("a comm thread's post after its hand-over in the turn is refused unless it is a plain question", () => {
  const handed = { owner: true, handed: true };
  assert.match(commPostRefusal("Makes sense, Accounts moves into a tab under Settings and leaves the top bar.", handed)!, /^Not sent: you handed this to your work thread in this turn/);
  assert.match(commPostRefusal(RELAYS[0]![0], handed)!, /handed this to your work thread/);
  assert.equal(commPostRefusal("Which repo should the panel list cover, auto-sns-agent only or every repo?", handed), undefined);
  assert.match(commPostRefusal("The vent thread is listing the panels now, want the logins too?", handed)!, /handed this to your work thread/);
});

test("hand-over words are refused on any turn, and progress words only on a turn the owner did not start", () => {
  const owner = { owner: true, handed: false };
  const notice = { owner: false, handed: false };
  assert.match(commPostRefusal("I'll post the wiki link here once the list is done.", owner)!, /^Not sent: "I'll post the wiki link here once" announces a hand-over/);
  assert.equal(commPostRefusal("summaries.md isn't written yet. The work thread is reading threads.ts, the last of the 20 files.", owner), undefined);
  assert.match(commPostRefusal("The work thread is reading threads.ts, the last of the 20 files.", notice)!, /is progress on work still going/);
  assert.equal(commPostRefusal("summaries.md is done, with one line for each of the 20 files.", notice), undefined);
});

test("the turn starts at the newest owner or agent message before the call", () => {
  assert.equal(turnStartedAt([{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "custom", timestamp: 3 }, { role: "toolResult", timestamp: 4 }, { role: "assistant", timestamp: 5 }]), 3);
  assert.equal(turnStartedAt([{ role: "assistant", timestamp: 2 }]), undefined);
});
