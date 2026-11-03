import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The password, 2FA and passkey prompts that an agent's sign-in of a pool account reached, one per account. pool_claude and pool_codex read an
 * account with one as the owner's fix, since only he holds that secret or device, and every other account that needs a sign-in stays an agent
 * fix. Before this file nothing told d5 a sign-in had reached such a prompt: from 10-30 to 11-02 claude4@slack.green's magic link sat in
 * sieunpark77's Gmail, whose Google sign-in in Aside stopped on "Complete sign-in using your passkey" (10-30 20:11Z), and d5 started a job that
 * could not act on each of 6 runs. `scripts/sign-in-prompt.ts` writes it, and pool_claude drops an account's prompt once it no longer needs a
 * sign-in, so only a prompt reached since its last sign-in counts. A "payment" prompt is claude.ai's "Your subscription is paused. Pay your
 * invoice to restore access." on the OAuth Authorize click: on 11-03 01:50Z claude4@slack.green's magic link worked through a slack.green Email
 * Routing rule, and its Authorize answered 403 with that page, since its Max plan reads past_due and only the owner's payment brings it back.
 */
export const PROMPT_KINDS = ["password", "2fa", "passkey", "payment"] as const;
export type PromptKind = typeof PROMPT_KINDS[number];
export interface SignInPrompt {
  /** pi-pool's provider, "anthropic" or "openai-codex". */
  provider: string;
  /** The pool account's email. */
  account: string;
  prompt: PromptKind;
  /** When the agent's attempt reached it, ISO. */
  at: string;
  /** The page or account that asked, such as "Google sign-in for sieunpark77@gmail.com in Aside, the inbox that gets claude4's magic link". */
  where: string;
  /** A screenshot path or a session ref that shows the prompt. */
  evidence: string;
}

export const signInPromptsFile = (home: string = homedir()): string => join(home, ".config/sieun-pi/sign-in-prompts.json");

/** The prompts in the file's text; a missing or broken file, or a record without a known prompt, account or time, gives none. */
export function parsePrompts(text: string | undefined): SignInPrompt[] {
  let rows: unknown;
  try { rows = (JSON.parse(text ?? "") as { prompts?: unknown }).prompts; } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is SignInPrompt => typeof row === "object" && row !== null
    && typeof row.provider === "string" && typeof row.account === "string" && row.account !== ""
    && (PROMPT_KINDS as readonly unknown[]).includes(row.prompt) && typeof row.at === "string" && Number.isFinite(Date.parse(row.at))
    && typeof row.where === "string" && typeof row.evidence === "string" && row.evidence !== "");
}

export const promptsText = (prompts: readonly SignInPrompt[]): string => JSON.stringify({ prompts }, null, 2) + "\n";
const same = (a: Pick<SignInPrompt, "provider" | "account">, b: Pick<SignInPrompt, "provider" | "account">): boolean =>
  a.provider === b.provider && a.account.toLowerCase() === b.account.toLowerCase();
/** The prompts with `record` in place of the account's earlier one. */
export const withPrompt = (prompts: readonly SignInPrompt[], record: SignInPrompt): SignInPrompt[] => [...prompts.filter(row => !same(row, record)), record];
/** The account's prompt for the provider, if one is recorded. */
export const promptFor = (prompts: readonly SignInPrompt[], provider: string, account: string): SignInPrompt | undefined =>
  prompts.find(row => same(row, { provider, account }));
/** "a passkey prompt at 10-30 20:11Z (Google sign-in for ..., evidence ...)". */
export const promptWords = (row: SignInPrompt): string =>
  `a ${row.prompt === "2fa" ? "2FA" : row.prompt} prompt at ${new Date(row.at).toISOString().slice(5, 16).replace("T", " ")}Z (${row.where}; evidence ${row.evidence})`;
