/**
 * The models a default, fallback or fixed pick in sieun-pi may name: the newest model of each tier (owner rule c185, 2026-10-27).
 * Vent refuses every other model. When a tier gets a newer model, change it here, and test/default-models-allowed.test.ts in
 * legacy/prime/user-history checks every default list in the repo against this list.
 */
export const ALLOWED_MODELS = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-fable-5-1",
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "openai-codex/gpt-6-luna",
] as const;

export type AllowedModel = typeof ALLOWED_MODELS[number];

export const isAllowedModel = (key: string): key is AllowedModel => (ALLOWED_MODELS as readonly string[]).includes(key);
