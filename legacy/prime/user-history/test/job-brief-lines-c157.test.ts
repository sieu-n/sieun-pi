// A job started with rlm.spawn gets its brief as an agent_message custom message that opens "[task from parent]", and until 10-29
// deliverCorrections read only a user message, so no spawned job got the brief lines (c48, c78, c157). On 10-28 the c157 clean room
// "token use check" started two jobs on the owner-style ask "is check-in eating a lot of tokens? ... cut token use in half", and neither job's
// [corrections] block had the c157 line. The brief below is the start of the first job's, as its session file holds it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";

const BRIEF = "[task from parent]\n\nOwner's words (verbatim):\n1. (2026-10-29 about 04:07 KST, msg mvshl5u4) \"is check-in eating a lot of tokens? figure out where our tokens actually go and how we could realistically cut token use in half without hurting the work\"\n\nMy read: He wants a skeptical, measured answer from data we already have, on both boxes (us-metal02 and the Mac), over the last 7 days. A 10-22 study (wiki session sessions/2026/10/22/1334-canonical-token-spending-ledger, data/baseline.json, and wiki projects/sieun-token-tracking) found 10.9B tokens/day, 93% cache reads but only 24% of cost-equivalent, cache writes 68% of cost-equivalent, and check-in trees 2.3% of output tokens, with their input and cache cost never attributed. Re-measure now; do not just repeat that.\n\nPricing rules (c157): a cached read reuses a prompt prefix at a fraction of the input price. Keep cache reads, cache writes and fresh input apart. Never call a big cache-read volume waste, and never argue for shorter warm history from raw-token share. Judge every cut by net cache-aware cost (use each model's real list prices) and by measured useful work (commits, steps closed, reports, owner answers). Rule c162: lead with";
const at = "2026-10-28T19:08:00.000Z";
const digest = { type: "custom_message", id: "d0", parentId: null, timestamp: at, customType: "harness_digest", content: "[harness-digest]", display: false } as unknown as SessionEntry;
const task = (content: string, id = "t1") => ({ type: "custom_message", id, parentId: "d0", timestamp: at, customType: "agent_message", content, display: true,
  details: { id: "spawn:sub-483c1dd8", fromRelationship: "parent" } }) as unknown as SessionEntry;

function block(branch: SessionEntry[]): string {
  const lines: string[] = [];
  deliverCorrections({ messages: [] as AgentMessage[], branch, ledger: null, job: true, brief: new Set(),
    append: data => { lines.push(...data.lines); branch.push({ type: "custom", id: "ck", parentId: null, timestamp: at, customType: CORRECTION_CHECKPOINT, data } as unknown as SessionEntry); } });
  return lines.join("\n");
}

test("a spawned job's [task from parent] brief gets its brief lines, so the 10-28 token job gets the c157 line", () => {
  assert.match(block([digest, task(BRIEF)]), /^- c157 This job counts tokens or prices model calls/m);
});

test("a later agent_message from a sibling is no brief, and a root still reads its first user message", () => {
  assert.doesNotMatch(block([digest, task("[agent-message from sibling:ops] how much do tokens cost us per day?")]), /c157/);
  const root = { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: BRIEF.replace("[task from parent]\n\n", "") }], timestamp: 1 } } as unknown as SessionEntry;
  assert.match(block([digest, root]), /^- c157 /m);
});
