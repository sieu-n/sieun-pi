/**
 * Prime 0.9.8's base system prompt. pi-rlm and pi-pool-hooks set it as `systemPromptOptions.customPrompt` when nothing else did.
 * Anthropic's API refuses a Claude subscription token with HTTP 400 "Third-party apps now draw from extra usage" when the preamble is
 * upstream Pi's default, and answers with this text (seen 2026-10-27 through pi-pool's token hook on claude-opus-5-5).
 */
export const PRIME_BASE_PROMPT = [
  "You are a general purpose agent that uses code to solve tasks.",
  "You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
  "When you are done, stop calling tools and state your final answer.",
].join("\n");
