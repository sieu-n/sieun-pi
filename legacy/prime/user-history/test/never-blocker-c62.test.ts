// Guards owner rule c62 ("i approve don't ever ever be blocker", 10-14), which he repeated on 11-08 in ops guy with "빨리 옮기라니까" after
// its job held the staging Convex move behind the p147 prod promote and the chat asked him on t65 to keep or raise a $200 cap. Before 11-09 only
// the VP of CI's own brief named c62, and JOB_RULES left it out, so no other chat or job read it before it acted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { jobLedgerPrompt, type Correction } from "../src/chat-corrections.ts";

const chat = { id: "c", name: "chat" };
const entry = (id: string, rule: string): Correction => ({ id, at: "2026-10-14T00:20:53.172Z", chat, words: "w", rule, enforcedBy: "brief", ref: "r", status: "active", theme: [], repeats: [] });

test("chat brief: an owner-asked move starts at once and waits only on an outside send or a walked prod promote (c62)", () => {
  const line = CHAT_BRIEF.find(text => text.startsWith("Never be the blocker (c62)")) ?? "";
  assert.match(line, /start every part that can move now in that turn/);
  assert.match(line, /reviews and checks beside it instead of as gates/);
  assert.match(line, /retry a failed attempt as soon as its fix is ready/);
  assert.match(line, /his or a peer's ok, a review, an unrelated release or promote, or a For you question you can answer yourself/);
  assert.match(line, /when your pick spends no new money and sends nothing outside, take it/);
  assert.match(line, /Only an outside send \(c37\) and a prod promote the release owner walks with him \(c154\) wait, and then only that piece waits/);
  const c42 = CHAT_BRIEF.find(text => text.includes("(c42)")) ?? "";
  assert.match(c42, /unless it is a move he already asked for, where you take your pick and go \(c62\)/);
});

test("a job's [corrections] block carries c62", () => {
  const prompt = jobLedgerPrompt({ corrections: [entry("c62", "Never be the blocker, in every chat and job: start an owner-asked move at once."), entry("c61", "Board titles are plain.")] });
  assert.match(prompt, /^- c62 Never be the blocker, in every chat and job/m);
  assert.doesNotMatch(prompt, /c61/);
});

test("the todo rules and the global rules carry c62", () => {
  const owner = readFileSync(new URL("../../../../skills/board/references/owner.md", import.meta.url), "utf8");
  assert.match(owner, /A move the owner already asked for gets no todo about how to do it \(c62\)/);
  const rules = readFileSync(new URL("../../../../config/AGENTS.md", import.meta.url), "utf8");
  assert.match(rules, /start it at once and never be its blocker \(c62\)/);
  assert.match(rules, /Only an outside send \(c37\) and a prod promote walked with him \(c154\) wait/);
});
