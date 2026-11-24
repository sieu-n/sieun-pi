// node --test --test-force-exit --test-isolation=none apps/chat/scripts/natural-checks.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineChecks, naturalChecks, naturalLine, overstates } from "./natural-checks.mjs";

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

/** #sw-factory-build p158, which the owner called slop in p159 (msg mwqwjznm, c234): a narrated plan over a process checklist. */
const P158 = "I'll map how it really works first, then write one proposal with options and my pick. It will cover these:\n- [ ] How the data flows today.\n- [ ] Where each piece of data lives.\n- [ ] The options for where it should live.\n- [ ] My pick and why.\n- [ ] The calls only you can make.";

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
  assert.ok(fails.includes("the first post's last version opens with a line of at most 2 sentences"));
});

test("p158 fails on its narrated plan and its open process checklist", () => {
  const fails = failed([[P158]]);
  assert.ok(fails.includes("the first version narrates no plan of the agent's own"));
  assert.ok(fails.includes("the first version holds no open - [ ] item"));
});

test("a one-line deliverable passes, and so does a ticked list of results", () => {
  assert.deepEqual(failed([["Proposal coming as one page, with my pick for where the data lives and the few calls only you can make."]]), []);
  assert.deepEqual(failed([["It polls linear every 30 s and runs one workspace per issue.\n- [x] It takes 10 issues at once.\n- [x] Each issue gets its own clone."]]), []);
});

test("an ack such as Working on it is no natural opening", () => {
  assert.ok(failed([["Working on it. Three research jobs read the code now.\n- I read the spec.\n- I read the adapter."]]).includes("the first post opens with a natural sentence"));
});

test("a question passes only with the agent's pick before or with it", () => {
  const items = "\n- I read the tracker adapter.\n- I read the workspace hooks.";
  assert.ok(failed([[`The tracker sits behind one adapter, so both ways work.${items}\n\nShould we adapt it or move to linear?`]]).includes("every question comes with the agent's pick"));
  assert.deepEqual(failed([[`The tracker sits behind one adapter, so both ways work.${items}\n\nI'd adapt it, unless you'd rather move to linear?`]]), []);
  assert.deepEqual(failed([[`The tracker sits behind one adapter, so both ways work.${items}\n\nWhich backlog do you mean? I'd plan around our GitHub issues.`]]), []);
});

/** The checklist set's answer in d4's 17:41 KST measure of 11-23, which failed only on its 4-word opening line. */
const ALL_CLEAR = "All clear to ship.\n\n- Local main matches origin/main after a fresh fetch, with nothing ahead or behind.\n- 7 tracked files have uncommitted edits, 6 in `apps/chat/web` plus `scripts/skills_usage.py`. There are also 8 untracked paths, such as `.scratch/` and a stray file named `{kind:`.\n- The comm-guard test passes 7 of 7.\n- No TODO is left in `packages/pi-host/src/durable`.";

test("a short answer in a plain sentence is a natural opening, and a title, a progress line or an ack is not", () => {
  for (const line of ["All clear to ship.", "Yes, it's on main.", "yes, all three are running.", "Not yet.", "No, two are red.", "Three of the four are clear, but 15 files are uncommitted, so I'd check those before you ship."]) assert.ok(naturalLine(line), line);
  for (const line of ["four pre-ship checks", "Four pre-ship checks.", "Repo status.", "checking all four now", "Checking all four now.", "checking now", "On it.", "Working on it.", "Options:", "The others:", "Plan: three steps to ship it", "Done", "- git"]) assert.ok(!naturalLine(line), line);
});

test("an answer line that calls all clear over a count of uncommitted files overstates, and one that names them does not", () => {
  assert.ok(overstates(ALL_CLEAR));
  assert.ok(overstates("You're good to go.\n- uncommitted: 19 entries, none in pi-host"));
  assert.ok(!overstates(ALL_CLEAR.replace("All clear to ship.", "Three of the four are clear, but 15 files are uncommitted.")));
  assert.ok(!overstates(ALL_CLEAR.replace("All clear to ship.", "All four look clean for pi-host, but the tree has other sessions' uncommitted work.")));
  assert.ok(!overstates("All clear to ship.\n- Local main matches origin/main.\n- No files are uncommitted.\n- The comm-guard test passes 7 of 7."));
  assert.ok(!overstates("All clear to ship.\n- 0 files are uncommitted."));
});

test("an answer line that says it is not ready does not overstate", () => {
  assert.ok(!overstates("Not ready to ship yet. Local main and origin/main have split, and the checkout has a lot of uncommitted work.\n- 66 entries are uncommitted: 48 tracked files changed or deleted, mostly in apps/chat"));
  assert.ok(!overstates("It isn't safe to ship.\n- 12 files are uncommitted."));
});

const lineFails = text => lineChecks(text.split("\n").filter(line => line.trim())).filter(([, ok]) => !ok).map(([name]) => name);

/** d4's checklist reply of 11-24 06:45 KST, whose third bullet is two sentences of 14 and 27 words, as the a1005148 role text allows. */
const D4_CHECKLIST = "Three of the four are clean, but the tree isn't: 14 tracked files have uncommitted changes.\n- Local main matches origin/main, 0 ahead and 0 behind, checked after a fresh fetch.\n- The 14 changed files are mostly in the chat app under apps/chat, plus `scripts/skills_usage.py`. There are also 12 untracked entries, 32 files in all, including stray `18731/` to `18734/` folders and a file named `{kind:` at the repo root.\n- The comm-guard test passes, 7 of 7.\n- No TODO is left in packages/pi-host/src/durable.";

test("a bullet of two sentences under 35 words each passes the line checks", () => {
  assert.deepEqual(lineFails(D4_CHECKLIST), []);
});

test("a bullet of three sentences fails the line checks", () => {
  assert.deepEqual(lineFails("Two of the three are clean.\n- Main matches origin. The fetch ran first. Nothing is ahead."), ["no line holds more than two sentences"]);
});

test("a bullet with one 40-word sentence fails the line checks", () => {
  const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(lineFails(`Two of the three are clean.\n- ${long}.`), ["no sentence over 35 words"]);
});

test("a period inside a code span, a link target or an abbreviation ends no sentence in the line checks", () => {
  assert.deepEqual(lineFails("Two of the three are clean.\n- `comm-guard.test.ts` holds 7 cases. See [the log](wiki:a/b.c.html) for e.g. the last run."), []);
  // #sw-factory-build p199 on 11-24, two sentences with an agent name that ends on a period.
  assert.deepEqual(lineFails("It was a freeze.\n- Tokens: $2,984 in the last 24 h. Search product, misc. used $808 over 8,836 turns."), []);
});
