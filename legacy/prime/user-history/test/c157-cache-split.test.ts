// c157 came back after narrow fixes: the chat brief line (395791e8) held it for explaining token use and 5f353fe0 added cost estimates, but
// nothing checked what reached the owner, and a job brief that asked where tokens go got no c157 line unless it had a cost word. On 10-22 at
// 04:51Z gpt sol (metal 02) sent "99.7% of recorded tokens are input; ... The proposal replaces full history with current task state" through
// tell_owner and wrote "99.704 percent prompt" in p8's note, and the owner answered "check what a Cached read is." On 10-27 Crawler VP's own
// sketch priced every input token of a classification run as fresh, and he wrote "note that system prompt (instruction) should be registered
// as Cache read". tell_owner now refuses such a text once, the board flags such a todo or step note, and every job asked where tokens go,
// how to cut them or what model calls cost gets the c157 line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import { applyBoardOp, emptyBoard } from "../src/shared/chat-board.ts";
import { jobLedgerPrompt, TOKEN_COST_RULE_LINE, tokenCostRuleLine } from "../src/chat-corrections.ts";
import { cacheBlindTokenClaim } from "../src/shared/token-claim.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-22T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer", about: "token cut" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const told = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) }) as ThreadMessage;

const ASK = "다각도로 현재 harness의 토큰 비효율을 분석해서 임팩트 없이 실제 50% 이상 줄일 수 있을 현실적인 감축안을 제안해. also is Check-in taking up alot of tokens?";
const turn = [owner(ASK, "04:20:00")];
/** gpt sol (metal 02)'s tell_owner of 10-22 04:51Z, the text the owner answered. */
const TOLD_1022 = "99.7% of recorded tokens are input; 4 of 192 check-in jobs had unchanged, unflagged checks. The proposal replaces full " +
  "history with current task state and on-demand evidence, but a no-impact 50% cut still needs testing.";
/** Crawler VP's own sketch of 10-27 19:14Z, which priced every input token as fresh. */
const SKETCH_1027 = "Ballpark: about $20k to tag all 65.6M bios with DeepSeek Flash, at ~3k input tokens each including the image and $0.07/1M.";
/** p8's note of 10-22 04:51Z. */
const NOTE_P8 = "Done when a short, measured proposal addresses check-ins and several token-waste angles. Recorded use is 10.888 billion " +
  "assistant-message tokens, 99.704 percent prompt. Known check-in trees emitted 2.286 percent of output.";

test("the 10-22 input share and the 10-27 fresh-input estimate are refused once with the cache split to use", () => {
  for (const text of [TOLD_1022, SKETCH_1027]) {
    const out = tellOwner({ text, why: "answer", about: "token cut" }, tellTurn(turn));
    assert.equal(out.kind, "refused", text);
    assert.match(out.text, /no cache split/);
    assert.match(out.text, /cache-read rate/);
    assert.match(out.text, /c157/);
  }
  assert.equal(cacheBlindTokenClaim("Most of the spend is cache reads, which are wasted replay of old history, so we should compact sooner."),
    "cache reads, which are wasted");
});

test("the very same text sent again goes out, so the check is a soft cap (c98)", () => {
  const first = tellOwner({ text: TOLD_1022, why: "answer", about: "token cut" }, tellTurn(turn));
  const again = [...turn, tell("a1", TOLD_1022, "04:51:10"), told("a1", first.text, "04:51:10"), tell("a2", TOLD_1022, "04:51:20")];
  assert.deepEqual(tellOwner({ text: TOLD_1022, why: "answer", about: "token cut" }, tellTurn(again)), { kind: "sent", text: TELL_OWNER_DONE });
});

test("a text that keeps cache reads apart, or does not count model tokens, goes out as before", () => {
  for (const text of [
    "Cache reads are 92.9% of tokens but 24% of cost; cache writes are 67.6% of cost. Fresh input is 1%.",
    "About $310 for all 65.6M bios on DeepSeek Flash: the 2.1k-token instructions as cache reads at $0.0069/1M, 400 fresh tokens per bio at $0.07/1M.",
    "Cache reads are not waste, they reuse the prefix.",
    "Prod p95 latency is 120 ms, 12% under target. The Opus seat bill is $4,600 a month.",
    "Input validation now covers 95% of the forms.",
    "2 included seats plus $12.34 a seat gave a $12.34 line for a 3rd seat. Chat threads (tokens and images) are metered. The COST-1 query has no gpt-image-2 price row.",
    "TypeSafe billed about $0.52 for 1,000 creators on Jev at 1.9k input tokens each.",
  ]) assert.deepEqual(tellOwner({ text, why: "answer", about: "token cut" }, tellTurn(turn)), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("the board saves p8's note and a todo with no cache split, and flags both", () => {
  const start = applyBoardOp(emptyBoard("2026-10-22T04:00:00Z"), { op: "plan_add", text: "Find a measured plan to cut token waste by at least half" },
    "agent", "2026-10-22T04:00:00Z", kind => `${kind}8`).board;
  const note = applyBoardOp(start, { op: "plan_update", id: "p8", status: "done", note: NOTE_P8 }, "agent", "2026-10-22T04:51:00Z", kind => `${kind}9`);
  assert.equal(note.board.plan[0]!.note, NOTE_P8);
  assert.match(note.summary, /step note counts tokens .* no cache split \("99\.704 percent prompt"\).*c157/s);
  const todo = applyBoardOp(start, { op: "todo_add", text: "Cut history replay, since 99.7% of tokens are input?", choices: ["Yes (my pick)", "No"] },
    "agent", "2026-10-22T04:52:00Z", kind => `${kind}1`);
  assert.equal(todo.board.todos.length, 1);
  assert.match(todo.summary, /todo counts tokens .* no cache split/s);
  const split = applyBoardOp(start, { op: "plan_update", id: "p8", note: "Cache reads are 92.9% of tokens and 24% of cost; fresh input is 1%." },
    "agent", "2026-10-22T04:53:00Z", kind => `${kind}9`);
  assert.doesNotMatch(split.summary, /cache split/);
});

/** The token part of gpt sol (metal 02)'s 'token cut proposal' brief of 10-22 04:45Z, and briefs in the owner's words with no cost word. */
const PROPOSAL_1022 = "Owner wants a short, data-based algorithm proposal for at least 50 percent fewer tokens without harming useful work. " +
  "Rolling24 official assistant-message totals are 10.888313B tokens, 99.704 percent prompt. A high cache ratio is not waste.";
const TOKEN_ASKS = [
  PROPOSAL_1022,
  `Owner's words: "${ASK}" Task: measure where tokens go and propose a cut of at least half.`,
  "Chats replay 300k tokens of history every turn. Find a way to shorten the context each call sends, through compaction or summaries.",
  "Measure the token spending of duty runs per day and say which duty uses most.",
  "Owner's words: \"how much would it be to tag every bio with deepseek flash? ballpark\". Measure per bio on 50 samples.",
  "Owner's words: \"deepseek flash로 바이오 분류하면 비용 얼마나 나와?\" Measure per profile and give the total.",
];

test("every job asked where tokens go, how to cut them or what model calls cost gets the c157 line with its warm-history half", () => {
  for (const brief of TOKEN_ASKS) {
    assert.equal(tokenCostRuleLine(brief), TOKEN_COST_RULE_LINE, brief);
    assert.match(jobLedgerPrompt(null, brief), /^- c157 .*cache-read rate.*never argue for shorter warm history .* raw-token share.*measured useful work/m, brief);
  }
});

test("a brief about design tokens or a credential token gets no c157 line", () => {
  for (const brief of ["Use the design tokens from $lib/ui and keep the spacing tokens as they are.",
    "Rotate the GitHub token the deploy job uses and store it in the vault."]) assert.doesNotMatch(jobLedgerPrompt(null, brief), /c157/, brief);
});
