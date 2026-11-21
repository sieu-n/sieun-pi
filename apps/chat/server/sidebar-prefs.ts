/**
 * The owner's sidebar choices per room, as Slack's row menu sets them: Star, Mute, Close conversation for a DM and Leave channel for a
 * channel. They live in state.json under `sidebar`, and `withPrefs` marks each sidebar row with them. A closed DM comes back with its next
 * post, and a DM with no posts yet counts as closed, so the sidebar lists only DMs that hold a conversation. A left channel comes back when
 * the owner posts in it or joins it again.
 */
import type { ConversationPrefs, ConversationSummary, Ms, PrefsPatch } from "../web/src/lib/api/types.ts";

type PostMark = { readonly at: Ms; readonly author: string };

/** The row with the owner's star, mute and hidden state, read against the room's posts. */
export function withPrefs(row: ConversationSummary, prefs: ConversationPrefs | undefined, posts: readonly PostMark[]): ConversationSummary {
  const hidden = hiddenAs(row, prefs, posts);
  return { ...row, ...(prefs?.starred ? { starred: true } : {}), ...(prefs?.muted ? { muted: true } : {}), ...(hidden ? { hidden } : {}) };
}

function hiddenAs(row: ConversationSummary, prefs: ConversationPrefs | undefined, posts: readonly PostMark[]): ConversationSummary["hidden"] {
  const hide = prefs?.hidden;
  if (hide?.kind === "left") return posts.some(p => p.author === "owner" && p.at > hide.at) ? undefined : "left";
  if (hide?.kind === "closed") return posts.some(p => p.at > hide.at) ? undefined : "closed";
  return row.kind === "dm" && !posts.length ? "closed" : undefined;
}

/** Why a prefs body is refused, or the patch it holds. */
export function parsePrefsPatch(body: unknown): PrefsPatch | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "A prefs patch is an object with starred, muted or hidden.";
  const { starred, muted, hidden, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length) return `A prefs patch carries only starred, muted and hidden, not ${Object.keys(rest).join(", ")}.`;
  if (starred !== undefined && typeof starred !== "boolean") return "starred is true or false.";
  if (muted !== undefined && typeof muted !== "boolean") return "muted is true or false.";
  if (hidden !== undefined && hidden !== null && hidden !== "closed" && hidden !== "left") return 'hidden is "closed", "left" or null.';
  return { ...(starred !== undefined ? { starred } : {}), ...(muted !== undefined ? { muted } : {}), ...(hidden !== undefined ? { hidden } : {}) };
}

/** The prefs after a patch, or undefined when nothing is left to keep. */
export function applyPrefs(current: ConversationPrefs | undefined, patch: PrefsPatch, now: Ms): ConversationPrefs | undefined {
  const next: ConversationPrefs = { ...current };
  if (patch.starred !== undefined) {
    if (patch.starred) next.starred = true;
    else delete next.starred;
  }
  if (patch.muted !== undefined) {
    if (patch.muted) next.muted = true;
    else delete next.muted;
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) next.hidden = { kind: patch.hidden, at: now };
    else delete next.hidden;
  }
  return Object.keys(next).length ? next : undefined;
}
