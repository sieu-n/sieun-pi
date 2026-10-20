// Guards owner rule c30: on 10-19 a job's page recommended switching to Codex, and 735 of 761 job checkpoints since that day's fix carried no c30 line, since JOB_RULES left it out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobLedgerPrompt, type Correction } from "../src/chat-corrections.ts";

const chat = { id: "c", name: "chat" };
const entry = (id: string, rule: string): Correction => ({ id, at: "2026-10-09T20:03:30.323Z", chat, words: "w", rule, enforcedBy: "brief", ref: "r", status: "active", theme: [], repeats: [] });

test("a job's [corrections] block carries c30, no model or provider fallback", () => {
  const prompt = jobLedgerPrompt({ corrections: [entry("c30", "Never propose, build or use model or provider fallback for rate limits."), entry("c61", "Board titles are plain.")] });
  assert.match(prompt, /^- c30 Never propose, build or use model or provider fallback/m);
  assert.doesNotMatch(prompt, /c61/);
});
