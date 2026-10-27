// Guards t16 of 10-22: the owner said no to the Kaggle listing and yes to the Reddit reply in one answer, and the aside-browser send guard refused
// the Reddit post because approvedTodo read the "no" about Kaggle as a no on the whole todo.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownerOk } from "../src/owner-ok.ts";
import { approvedTodo } from "../src/shared/chat-board.ts";

const REDDIT = "https://old.reddit.com/r/influencermarketing/comments/1pof8jm/how_do_you_guys_get_in_touch_with/ | How do you guys get in touch with influencer/content creators? : influencermarketing";
const KAGGLE = "https://www.kaggle.com/datasets/new | Kaggle";
const text = "Okay to post two drafts for the new data studies: a Kaggle dataset listing and one Reddit reply in r/influencermarketing?";
const answered = (reply: string) => ({ text, reply, answeredBy: "owner" as const, done: true, choices: [] });

test("a split answer approves the send to the site it says yes to and refuses the other", () => {
  assert.equal(approvedTodo(answered("kaggle no reddit sure"), REDDIT), true);
  assert.equal(approvedTodo(answered("kaggle no reddit sure"), KAGGLE), false);
  assert.equal(approvedTodo(answered("reddit no kaggle yes"), REDDIT), false);
  assert.equal(approvedTodo(answered("no to kaggle, yes to reddit"), REDDIT), true);
  assert.equal(approvedTodo(answered("no to kaggle, yes to reddit"), KAGGLE), false);
});

test("an answer that names no site of the target is read whole", () => {
  assert.equal(approvedTodo(answered("no"), REDDIT), false);
  assert.equal(approvedTodo(answered("nope"), REDDIT), false);
  assert.equal(approvedTodo(answered("hmm"), REDDIT), false);
  assert.equal(approvedTodo(answered("sure"), REDDIT), true);
  assert.equal(approvedTodo(answered("kaggle no reddit sure")), false);
});

test("owner-ok passes the target to the check", async () => {
  const data = join(await mkdtemp(join(tmpdir(), "owner-ok-split-")), "browser-chat");
  await mkdir(join(data, "boards"), { recursive: true });
  const chat = "01a00000-0000-7000-8000-000000000016";
  await writeFile(join(data, "boards", `${chat}.json`), JSON.stringify({ v: 2, rev: 1, plan: [], todos: [{ id: "t16", from: "agent", at: "2026-10-22T10:00:00Z", ...answered("kaggle no reddit sure") }] }));
  const local = async () => null;
  assert.equal((await ownerOk(`${chat}/t16`, REDDIT, data, local)).ok, true);
  const kaggle = await ownerOk(`${chat}/t16`, KAGGLE, data, local);
  assert.equal(kaggle.ok, false);
  assert.match(kaggle.ok ? "" : kaggle.reason, /not a go for https:\/\/www\.kaggle\.com/);
});
