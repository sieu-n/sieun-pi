// Guards owner rule c157 for cost estimates: on 10-27 at 19:14:01Z the owner asked Crawler VP what classifying creators with DeepSeek Flash, Jev
// or GPT luna would cost, its 19:14:31Z job brief asked for prices and "batch or cache discounts" with no word on the shared instructions, and at
// 19:14:49Z he wrote "note that system prompt (instruction) should be registered as Cache read". A job whose brief asks what model calls cost now
// gets the c157 line in its [corrections] block unless the brief itself prices the shared instructions as cache reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobLedgerPrompt, TOKEN_COST_RULE_LINE, tokenCostRuleLine } from "../src/chat-corrections.ts";

// The cost part of Crawler VP's 'ai classification cost' brief, 10-27 19:14:31Z, as the chat relayed it. Its price list has a cache-read column,
// which does not say how to price the instructions.
const CLASSIFY_COST = "Owner's words: \"can you give a cost estimate if we ran it now with some model like deepseek flash, Jev, gpt luna. need to " +
  "include the multimodal render\". Providers Wafer $0.07 in / $0.50 out / $0.0069 cache read, inference.net $0.08 / $0.55 / $0.008, Relace " +
  "$0.07 / $0.50 / $0.008. (B) per-profile cost measured, not guessed: record input text tokens, image tokens, output tokens, latency and " +
  "failures per model. (C) price: per-model prices, batch or cache discounts, then the total to classify the 1k+ creators (65.6M) and all read " +
  "accounts (179M).";
// Its 19:14:55Z follow-up after the owner's line, which does say it.
const AFTER_OWNER = CLASSIFY_COST + " Price the shared system prompt and instructions at each model's cache-read rate, not as fresh input. Show " +
  "fresh input, cache read and output as separate columns.";
// A cost brief about storage, with no model calls in it.
const DISK_COST = "Task: price moving the census table to the main drive: the disk cost per TB, the copy time and the B2 bill for a month.";

test("a job brief that asks what model calls cost and leaves the shared instructions unpriced gets the c157 line", () => {
  assert.equal(tokenCostRuleLine(CLASSIFY_COST), TOKEN_COST_RULE_LINE);
  assert.match(jobLedgerPrompt(null, CLASSIFY_COST), /^- c157 .*shared system prompt and instructions.*cache-read rate.*measured cache-hit count/m);
});

test("a brief that prices the instructions as cache reads, or a cost brief with no model calls, gets no c157 line", () => {
  assert.equal(tokenCostRuleLine(AFTER_OWNER), null);
  assert.equal(tokenCostRuleLine(DISK_COST), null);
  assert.doesNotMatch(jobLedgerPrompt(null, DISK_COST), /c157/);
});
