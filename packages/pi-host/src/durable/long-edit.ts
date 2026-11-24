/**
 * A room post's word cap and the hold on an agent's edit that runs past it or holds a table. apps/chat runs `editHold` on every agent edit
 * (`POST /api/threads/:id/edits`, app.ts `editAsAgent`), so the hold covers edit_message and a kernel's own call of that route alike.
 * Until 11-24 only the edit_message tool held such an edit, and a job, which has no edit_message, posted to the route from ipython: on 11-24
 * Search product, misc.'s job "clickhouse layout" edited #dev-crawler p5 into 251 words with 7 bullets of table counts, and the owner wrote
 * under it "아오 씨발 겁나 길어" (p8, c242). This file imports only reply-lint and comm-guard, which the apps/chat release carries too.
 */
import { longReply } from "../../../../legacy/prime/user-history/src/shared/reply-lint.ts";
import { hasTable } from "./comm-guard.ts";

/**
 * A room post's word cap for tell_owner's long check (`longReply`, list markers not counted), above a Prime chat's 80. On 11-21 the owner
 * called agent factory's DM post a model (dm_agent-factory, msg mwqtp2l1, "정말 훌륭한 메시지였어"): an answer line, a short paragraph, a
 * lead-in line, three bullets and a closing line, 92 words, which the 80-word check had held once. Of the 1,315 agent posts in the rooms
 * that day, 32 ran over 80 words and 14 over 120.
 */
export const ROOM_LONG_WORDS = 120;

/**
 * The note for an edit held once, or undefined: one that runs long by tell_owner's check in a room (`longReply`: a sentence over 35 words
 * or over `ROOM_LONG_WORDS` in all, list markers not counted), or one that holds a markdown table, which a room's thread pane cuts off. The
 * same text sent again goes out, so the hold is a soft cap (c98). On 11-21 a blind run's work thread grew a checklist over its edits from 54
 * to 78 to 86 words, as the d4 run of 11-20 saw it grow from 63 to 95, and on 11-22 a blind-reactions run's work thread edited a pass and
 * fail table into the comm thread's first reply; neither edit was held then.
 */
export function editHold(edit: string, held: Set<string>): string | undefined {
  if (held.has(edit)) return undefined;
  const long = longReply(edit, ROOM_LONG_WORDS);
  const table = hasTable(edit);
  if (!long.length && !table) return undefined;
  held.add(edit);
  const why = [long.length ? `it runs long, with ${long.join(" and ")}` : "", table ? "it holds a table, which a room's thread pane cuts off" : ""];
  const fix = [
    long.length ? `Keep the post within ${ROOM_LONG_WORDS} words: the answer on its own line, short items, a nested detail only for a fact its ` +
      "item lacks, and the rest on a wiki page you link." : "",
    table ? "Say the result in a line or a few short bullets, and put a table he must see on a wiki page you link." : "",
  ];
  return `Not edited, ${why.filter(Boolean).join(", and ")}. ${fix.filter(Boolean).join(" ")} Sending the very same text again edits it as it is (c98).`;
}
