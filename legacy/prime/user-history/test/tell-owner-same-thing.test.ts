// 10-24: SEO guy asked the owner to wake his Mac at 03:39Z while sep launch!! t30 and CI and RepoOps t67 already asked it on For you, and the
// texts shared too few words for sameAsk. tell_owner now also matches the same device or account said to be down the same way (sameThing).
import assert from "node:assert/strict";
import { test } from "node:test";
import { tellOwner, tellTurn } from "../src/chat-guard.ts";
import type { AssistantMessage, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-24T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:second google user]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const tell = (id: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, text: string, clock: string): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: false, timestamp: at(clock) });

const settled = [owner("keep the daily indexing requests going", "01:00:00"), said("The job second google user runs them.", "01:01:00")];
const wake = job("03:10Z sieun@virev.ai window missed: the owner's Mac is still offline (tailscale last seen ~02:51Z).", "03:39:00");
const t67 = { chat: "01a1180e-6567-747f-bf44-452520ebdd1b", id: "t67", at: "2026-10-23T22:58:45Z",
  text: "Your Mac has been offline since 19:08 KST on Oct 23. Please wake it or check its network, so the demo cleanup can reach staging." };
const t30 = { chat: "01a15427-0000-7000-8000-000000000000", id: "t30", at: "2026-10-23T13:52:19Z",
  text: "Your MacBook Pro has been offline on Tailscale since about 10:50Z. I restarted its 16 jobs of this chat on us-metal02 from their pushed " +
    "branches, so the work goes on. Can you wake it when you're back?" };
const seo = { text: "Please open your MacBook and keep it awake on the network for a bit, because the daily Google indexing requests run through Aside on it. " +
  "It has been offline since 10-23, so we lost about 20 requests a day.", why: "blocker", about: "p93 indexing windows need the owner's Mac online" };

test("an ask about the same device another chat's open todo says is down is refused once, and the very same text again goes out", () => {
  const turn = tellTurn([...settled, wake]);
  const now = at("03:39:54");
  for (const todo of [t67, t30]) {
    const refused = tellOwner(seo, { ...turn, others: [todo] }, now);
    assert.equal(refused.kind, "refused", `the Mac offline ask repeats ${todo.id}`);
    assert.match(refused.text, new RegExp(`another chat already asks him this on For you, as ${todo.id} of chat ${todo.chat}`));
  }
  const history = [...settled, wake, tell("s1", seo, "03:39:54"), result("s1", "Not sent, another chat already asks him this on For you", "03:39:55"), tell("s2", seo, "03:40:10")];
  assert.equal(tellOwner(seo, { ...tellTurn(history), others: [t67] }, now).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(seo, { ...turn, owner: true, others: [t67] }, now).kind, "sent", "his own turn is never held");
  assert.equal(tellOwner(seo, { ...turn, others: [t67] }, Date.parse(t67.at) + 24 * 3_600_000 + 1).kind, "sent", "a todo older than a day is not this incident");
});

test("the same device with no shared down word, or a down word on another account, goes out", () => {
  const turn = tellTurn([...settled, wake]);
  const now = at("03:39:54");
  // 10-23 13:08Z: AI harness asked the owner to wake his Mac while CI and RepoOps t64 asked about Mac chats' branches, a different question.
  const t64 = { ...t67, id: "t64", text: "Should Mac chats keep their own working folder and branch, now that each branch restarts from staging after every landing?" };
  assert.equal(tellOwner(seo, { ...turn, others: [t64] }, now).kind, "sent");
  // 10-22 14:21Z: sep launch!! asked where its jobs run after pinning them to sieunpark77, while AI harness t87 asked him to pay that account's paused bill.
  const t87 = { ...t67, id: "t87", text: "Please pay the $200 Claude Max bill for sieunpark77@gmail.com. The Mastercard ending 8306 was declined on 10-21, so Anthropic paused the account." };
  const pin = { text: "Pinning all 21 jobs to sieunpark77 backfired. They keep hitting its per-minute rate limit. Pick on t27.", why: "decision", about: "which account the jobs run on" };
  assert.equal(tellOwner(pin, { ...turn, others: [t87] }, now).kind, "sent");
  const krenerd = { text: "krenerd77's Codex login was paused by OpenAI. Please sign it back in.", why: "blocker", about: "krenerd77 Codex sign-in" };
  assert.equal(tellOwner(krenerd, { ...turn, others: [t87] }, now).kind, "sent", "a down word on another account goes out");
});
