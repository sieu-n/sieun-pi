import { DutyStore } from "../../src/chat-duty-store.ts";
import { byItem, type FlaggedSlice } from "../../src/shared/chat-duties.ts";

/**
 * Chat health's `unresolved_after_turn`: every item a duty flagged on a run and flagged again by the recheck after the chat's turn, on a step the
 * chat did not touch (the duty's after-turn records, src/chat-duty-run.ts). Each step counts once per recheck, whatever number of metrics flagged
 * it; its slice names the chat, the duty and the item.
 */
export async function unresolvedAfterTurn(dataDir: string, chats: readonly string[], start: number, now: number): Promise<FlaggedSlice[]> {
  const store = new DutyStore(dataDir);
  const flagged: FlaggedSlice[] = [];
  for (const chat of chats) {
    for (const run of await store.runs(chat).catch(() => [])) {
      if (run.trigger !== "after-turn" || run.at < start || run.at > now) continue;
      for (const group of byItem(run.unresolved ?? [])) {
        flagged.push({ chat, at: run.at, kind: "unresolved_after_turn", item: group.item,
          excerpt: `duty ${run.duty} item ${group.item} (${group.kinds.join(", ")}) still flagged after the chat's turn with no change: ${group.excerpt}`.slice(0, 300) });
      }
    }
  }
  return flagged;
}
