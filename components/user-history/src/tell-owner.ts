import { TELL_OWNER_REFUSED, tellOwner } from "./chat-guard.ts";
import { jobLinkFinding, unlinkedJobSentence } from "./shared/job-mentions.ts";
import type { ChatAgent } from "./shared/types.ts";

/** How many job names a refusal lists: the number the board tool's Agents list shows (`agentLines`). */
const LISTED_JOBS = 15;

/** The job names a chat can link (`job:<name>`), most recently active first. A thread the chat only talks to links as `thread:`, not here. */
export function linkableJobs(agents: readonly ChatAgent[]): string[] {
  const at = (agent: ChatAgent) => agent.lastActivityAt ? Date.parse(agent.lastActivityAt) || 0 : 0;
  return [...agents].filter(agent => agent.job && !agent.job.startsWith("session:")).sort((a, b) => at(b) - at(a)).map(agent => agent.job).slice(0, LISTED_JOBS);
}

/**
 * What tell_owner answers in a chat: `tellOwner`'s checks, then a refusal when the text points at a job with no `job:` link (c12, chat health
 * unlinked_job_mentions). The refusal carries the text with the chat's job names linked when that fixes it. `jobs` loads the chat's job names
 * only when the text points at a job.
 */
export async function tellOwnerChecked(text: unknown, ownerText: string, jobs: () => Promise<readonly string[]>): Promise<{ ok: boolean; text: string }> {
  const result = tellOwner(text, ownerText);
  const told = typeof text === "string" ? text.trim() : "";
  if (!unlinkedJobSentence(told) || (!result.ok && !result.text.startsWith(TELL_OWNER_REFUSED))) return result;
  const finding = jobLinkFinding(told, await jobs().catch(() => []));
  if (!finding) return result;
  return { ok: false, text: result.ok ? `${TELL_OWNER_REFUSED}\n${finding}` : `${result.text}\n${finding}` };
}
