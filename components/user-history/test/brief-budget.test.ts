import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { jobLedgerPrompt, ledgerPrompt, parseLedger } from "../src/chat-corrections.ts";
import { BRIEF_CORRECTIONS, CHAT_BRIEF } from "../src/chat-brief.ts";

/** Every chat carries the brief in its system prompt and the corrections block after each compaction, so both have a size target (p299: a VP
 * chat's first request is at least 20k tokens under the pre-trim 40.6k). The brief counts as the prompt renders it, one `- ` bullet per line.
 * A text past its target is a soft cap (owner 10-18): the test passes and prints a diagnostic line with the size and the fix. */
const BRIEF_MAX_CHARS = 5_000;
const CHAT_CORRECTIONS_MAX_CHARS = 2_200;
const JOB_CORRECTIONS_MAX_CHARS = 2_000;

/** The live ledger's shape on 2026-10-12 (ids, statuses, enforcement, rule and theme lengths), with the text replaced by filler. */
const shape = async () => parseLedger(JSON.parse(await readFile(new URL("./fixtures/corrections-shape.json", import.meta.url), "utf8")));

test("budget: the chat brief targets at most 5,000 characters", t => {
  const chars = CHAT_BRIEF.map(line => `- ${line}`).join("\n").length;
  if (chars > BRIEF_MAX_CHARS) t.diagnostic(`[soft cap] CHAT_BRIEF is ${chars} characters, past its ${BRIEF_MAX_CHARS} target; move rules for one kind of action into the board skill`);
});

test("budget: the corrections snapshot of a chat targets at most 2,200 characters, and a job's 2,000, for the current ledger shape", async t => {
  const ledger = await shape();
  assert.equal(ledger.corrections.length, 52);
  const chat = ledgerPrompt(ledger, BRIEF_CORRECTIONS)!;
  if (chat.length > CHAT_CORRECTIONS_MAX_CHARS) t.diagnostic(`[soft cap] the chat snapshot is ${chat.length} characters, past its ${CHAT_CORRECTIONS_MAX_CHARS} target; put the rule in the brief with its id, or in a skill the chat reads (c81)`);
  const job = jobLedgerPrompt(ledger);
  if (job.length > JOB_CORRECTIONS_MAX_CHARS) t.diagnostic(`[soft cap] the job snapshot is ${job.length} characters, past its ${JOB_CORRECTIONS_MAX_CHARS} target`);
});
