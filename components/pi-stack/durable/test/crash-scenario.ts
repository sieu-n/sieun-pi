/** The crash test's conversation: one input that makes the root hand a task to a subagent and wait on it. */
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory, type Message } from "@earendil-works/pi-ai";

export const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
export const REQUEST_ID = "crash-test-input-1";
export const CHILD_TASK = "List the first ten prime numbers, one per line, then explain in two sentences why 1 is not prime.";
export const INPUT = `Call the subagent tool exactly once with this task: "${CHILD_TASK}" When it returns, reply with its answer quoted in full and then the word DONE.`;
/** The faux child's answer, long enough that a kill lands while it streams. */
export const FAUX_CHILD_ANSWER = ["2", "3", "5", "7", "11", "13", "17", "19", "23", "29"].join("\n") + "\n" + "One is not prime because a prime has exactly two distinct divisors. One has only itself as a divisor, so it falls short of that rule. ".repeat(4).trim();
export const FAUX_FINAL = "The subagent said the first ten primes. DONE";
const FAUX_PREAMBLE = "I will hand this to a subagent so the answer comes from a separate conversation that I wait on. ".repeat(4).trim();

export const textOf = (content: Message["content"]): string =>
  typeof content === "string" ? content : content.flatMap(c => ("text" in c && typeof c.text === "string" ? [c.text] : [])).join("");

/** Answers from the transcript alone, so a restarted process gives the same answer at the same point. */
export const fauxRespond: FauxResponseFactory = transcript => {
  const messages = transcript.messages;
  const firstUser = messages.find(m => m.role === "user");
  if (firstUser && textOf(firstUser.content) === CHILD_TASK) return fauxAssistantMessage(FAUX_CHILD_ANSWER);
  if (messages.some(m => m.role === "toolResult")) return fauxAssistantMessage(FAUX_FINAL);
  return fauxAssistantMessage([fauxText(FAUX_PREAMBLE), fauxToolCall("subagent", { task: CHILD_TASK })], { stopReason: "toolUse" });
};

export interface EntrySummary { id: number; kind: string; role?: string; stopReason?: string; text: string; tools?: string[]; toolName?: string; isError?: boolean; error?: string }
