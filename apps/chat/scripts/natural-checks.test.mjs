// node --test --test-force-exit --test-isolation=none apps/chat/scripts/natural-checks.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { naturalChecks } from "./natural-checks.mjs";

const failed = versions => naturalChecks(versions).filter(([, ok]) => !ok).map(([name]) => name);

/** The owner praised this DM reply (msg mwqtp2l1, "정말 훌륭한 메시지였어"), the answer to mwqtnpb6. */
const PRAISED = `yes, all three are running.

The way I read your intent, sw factory should feel like Slack with coworkers. You drop a message, an agent answers like Prime chat would, works in the background and comes back with the result.

Here's what's moving toward that:
- why replies here feel stiffer than Prime's, compared with the real prompts
- replies that read like a normal message, with line breaks and a pick before any question
- unslop loading the way it does in Prime

I'll come back with a before and after once it's live.`;

/** dm_agent-factory p51, the checklist the owner showed in p54: a label opener over one-word topics with empty boxes. */
const P51 = "one table: Prime chat vs sw factory, file by file.\n- instructions\n  - [ ] \n- skills\n  - [ ] \n- tools\n  - [ ]\n- feel\n  - [ ]";

/** A reply in the shape of dm_agent-factory p55, which the owner answered in p57: four sentences on one line. */
const P55 = "Probably the comm thread lost the reply_to. The round closed on the wrong post, so the answer landed under p11. I'll trace closedPost in rooms.ts and add a test. I'd fix it in the server rather than the role text.";

test("the praised DM reply passes every natural check", () => {
  assert.deepEqual(failed([[PRAISED]]), []);
});

test("p51 fails on its opening line and its bare topic labels", () => {
  const fails = failed([[P51]]);
  assert.ok(fails.includes("the first post opens with a natural sentence"));
  assert.ok(fails.includes("no version holds a bare topic label bullet"));
});

test("the p55 wall fails on its 4-sentence line and its buried answer", () => {
  const fails = failed([[P55]]);
  assert.ok(fails.includes("no line of any version holds 3 or more sentences"));
  assert.ok(fails.includes("the last version's answer sits alone on its first line"));
});

test("a checklist of short sentences passes once an edit ticks it, and fails while its boxes stay open", () => {
  const first = "I'll read how symphony picks up issues and runs agents. Here's what I'm checking:\n- [ ] Read how it polls linear.\n- [ ] Map how each agent gets its workspace.";
  const done = "It polls linear every 30 s and runs one workspace per issue.\n- [x] Read how it polls linear.\n- [x] Map how each agent gets its workspace.";
  assert.deepEqual(failed([[first, done]]), []);
  assert.ok(failed([[first]]).includes("open tasks in the first post get ticked by a later edit"));
});

test("a question passes only with the agent's pick before or with it", () => {
  const items = "\n- I read the tracker adapter.\n- I read the workspace hooks.";
  assert.ok(failed([[`The tracker sits behind one adapter, so both ways work.${items}\n\nShould we adapt it or move to linear?`]]).includes("every question comes with the agent's pick"));
  assert.deepEqual(failed([[`The tracker sits behind one adapter, so both ways work.${items}\n\nI'd adapt it, unless you'd rather move to linear?`]]), []);
});
