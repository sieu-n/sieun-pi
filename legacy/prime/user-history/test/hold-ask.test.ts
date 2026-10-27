// Guards c72 after its text fix did not hold: on 10-26 Prospect feature bro asked t33 whether to keep an unmeasured 600 s post-deploy pause, and the owner answered "why pause/do all that bespoke bullshit at all?" on 10-27.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOps } from "../src/agent-board.ts";

const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const FLAG = /^Saved, but this asks the owner to keep, narrow or scope a cautious setting .* \(c72, rule 7;.*Do not ask him: delete the setting now/;
async function summaries(ops: unknown[]): Promise<string[]> {
  return (await applyAgentOps(mkdtempSync(join(tmpdir(), "hold-ask-")), CHAT, ops)).summaries;
}
const flagged = async (ops: unknown[]) => assert.ok((await summaries(ops)).some(line => FLAG.test(line)), JSON.stringify(ops));
const passes = async (ops: unknown[]) => assert.ok(!(await summaries(ops)).some(line => /c72, rule 7/.test(line)), JSON.stringify(ops));

const T33 = "Each crawler deploy pauses new Instagram logins for 10 minutes, which starved Watchlist reads three times today. Keep that pause only for a database restore?";
const T33_CHOICES = ["Pause only after a database restore (my pick)", "Keep the pause after every deploy"];
const P230_NOTE = "Done when d2 reads owner_green_pct 100%. Done 10-26 09:35Z: the d2 precheck read owner_green_pct 100 (9,854 of 9,855 owner accounts green, one tagged row starved on its retry). " +
  "After it shipped, the collab backlog drained from 647 due rows to 5, and the jobs worker shows no admission timeouts. e7c80b5fe (a second prod jobs-worker process) sits on sieun/dev for a later cut and is not urgent. " +
  "Making the 600 s post-deploy opening hold (owner pick D-HOLD-PROD a) restore-only needs his ok.";

test("t33, which asked the owner to keep an unmeasured pause for restores only, is saved with the c72 flag", async () => {
  await flagged([{ op: "todo_add", text: T33, choices: T33_CHOICES }]);
  await flagged([{ op: "todo_add", text: "Each crawler deploy pauses new Instagram logins for 10 minutes. What should we do?", choices: T33_CHOICES }]);
});

test("a plan note that holds narrowing a hold for the owner's ok is flagged, and so are other unmeasured keeps", async () => {
  await flagged([{ op: "plan_add", text: "Watchlist green on prod", note: P230_NOTE }]);
  await flagged([{ op: "plan_add", text: "Import speed", waitFor: "the owner's pick on keeping the 30 s fetch timeout only on staging" }]);
  await flagged([{ op: "todo_add", text: "Cap TikTok Shop at 40 workers only during the day?", choices: ["Day only", "Always"] }]);
  await flagged([{ op: "todo_add", text: "The 2 min cooldown after a proxy error slows census. Shorten the cooldown to 30 s?", choices: ["Shorten it", "Keep 2 min"] }]);
});

test("a hold backed by a cited measurement or incident passes, and so do deletions and the owner's own limits", async () => {
  await passes([{ op: "todo_add", text: "On 10-12 a restore that reopened logins at once locked out 41 accounts in 6 minutes (incident p88). Keep the 600 s pause after a database restore?",
    choices: ["Keep it after a restore", "Remove it"] }]);
  await passes([{ op: "plan_add", text: "Restore drill", note: "Without the hold, the 10-12 restore banned 41 accounts in 6 minutes. Keeping the 600 s hold only after a restore needs his ok." }]);
  await passes([{ op: "todo_add", text: "I deleted the 600 s opening hold in 7359010b1a, so deploys start no pause. Ship it to prod with the next crawler cut?", choices: ["Ship it", "Not yet"] }]);
  await passes([{ op: "todo_add", text: "Delete the pause instead of keeping it after restores?", choices: ["Delete it", "Wait"] }]);
  await passes([{ op: "todo_add", text: "Keep pi-pool's admission threshold at 85% for the Codex accounts?", choices: ["Keep 85%", "Raise to 90%"] }]);
  await passes([{ op: "plan_add", text: "Crawler deploys on prod start no login pause", note: "Done when the next prod crawler deploy starts 0 s of opening hold. The owner on t33: the hold goes entirely, since no measurement shows it prevented harm." }]);
});
