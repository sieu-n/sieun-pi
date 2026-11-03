// Guards d1, the owner's usable Mac (10-09: "have it your duty to have usable mac"). On 11-03 at 12:21Z Crawler VP's brief told its small
// model classify job to train on the owner's MacBook Pro with PyTorch MPS when no box had an NVIDIA GPU, the job's smc-* subagents ran
// run_mps_bench.sh and train.py there over ssh, and from 12:38Z to 15:14Z the Mac read 43 unusable minutes. A job whose brief trains,
// benchmarks or runs a model now gets the d1 line that sends that compute to us-metal02.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { HEAVY_COMPUTE_RULE_LINE, heavyComputeRuleLine, jobLedgerPrompt } from "../src/chat-corrections.ts";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";

// The routing sentence of Crawler VP's 12:21Z brief to small model classify, as its session file holds it.
const VP_BRIEF = "[task from parent]\n\nOwner's words (verbatim):\n1. 11-03 about 21:25 KST (12:2xZ), on todo t81: \"how about we fine tune & batch " +
  "inference using a t5-style(?) model? can you check the output feasability, on a T4 machine (something like COlab, or even the mbp?)\"\n\n(b) " +
  "Train: fine-tune flan-t5-base (and flan-t5-small, and one encoder classifier such as a multilingual MiniLM or DeBERTa-v3 head) to output the " +
  "labels. Train where a GPU exists. Check whether us-metal02 or any box we control has a GPU (nvidia-smi). If not, train headless on the owner's " +
  "MacBook Pro with PyTorch MPS through the Mac host, with no visible windows (c103), at normal priority.";
// The start of the job's 12:24Z brief to its smc-t5 subagent, which ran train.py on the Mac.
const T5_BRIEF = "Your unit: SEQ2SEQ flan-t5. Models: google/flan-t5-small, then flan-t5-base. 1. While the data job runs, set up the Mac venv and " +
  "measure batch generation throughput on MPS (batch 64 to 256, real input length, greedy decoding) with the base checkpoint, holding the GPU timing lock.";
// Briefs with no model compute: a storage price and a 5180 screen.
const DISK_COST = "Task: price moving the census table to the main drive: the disk cost per TB, the copy time and the B2 bill for a month.";
const UI_BRIEF = "Task: restyle the Inbox sidebar on 5180 so the channel rows use the shared $lib/ui list, with the sample rows in fixtures/train.jsonl.";

test("a brief that trains or benchmarks a model, the job's or its subagent's, gets the d1 line", () => {
  for (const brief of [VP_BRIEF, T5_BRIEF]) {
    assert.equal(heavyComputeRuleLine(brief), HEAVY_COMPUTE_RULE_LINE, brief);
    assert.match(jobLedgerPrompt(null, brief), /^- d1 .*on us-metal02.*never on the owner's Mac.*MPS.*published benchmark/m, brief);
  }
});

test("a brief with no model compute gets no d1 line", () => {
  for (const brief of [DISK_COST, UI_BRIEF]) assert.doesNotMatch(jobLedgerPrompt(null, brief), /^- d1 /m, brief);
});

test("a job spawned with the 11-03 brief reads the d1 line in its first [corrections] block", () => {
  const at = "2026-11-03T12:21:00.000Z";
  const branch = [{ type: "custom_message", id: "t1", parentId: null, timestamp: at, customType: "agent_message", content: VP_BRIEF, display: true,
    details: { id: "spawn:sub-01a1a15b", fromRelationship: "parent" } }] as unknown as SessionEntry[];
  const lines: string[] = [];
  deliverCorrections({ messages: [] as AgentMessage[], branch, ledger: null, job: true, brief: new Set(),
    append: data => { lines.push(...data.lines); branch.push({ type: "custom", id: "ck", parentId: null, timestamp: at, customType: CORRECTION_CHECKPOINT, data } as unknown as SessionEntry); } });
  assert.ok(lines.includes(HEAVY_COMPUTE_RULE_LINE));
});
