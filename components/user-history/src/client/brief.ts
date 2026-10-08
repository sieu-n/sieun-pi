import type { ChatBriefState, SessionRow } from "../shared/types.ts";

/** What Settings > Chats says about one chat's brief. */
export type BriefStatus = "updating" | "update pending" | "up to date";
const ORDER: Record<BriefStatus, number> = { updating: 0, "update pending": 1, "up to date": 2 };

export const briefStatus = (brief: ChatBriefState): BriefStatus => brief.updating ? "updating" : brief.version === brief.current ? "up to date" : "update pending";

export interface BriefRow { id: string; name: string; version: string; status: BriefStatus }
/** The unarchived chats in the sessions stream with their brief, the ones not up to date first, then by name. */
export function briefRows(rows: readonly SessionRow[]): BriefRow[] {
  return rows.flatMap(row => row.chat && !row.archived && row.brief ? [{ id: row.id, name: row.name, version: row.brief.version ?? "unknown", status: briefStatus(row.brief) }] : [])
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
}

/** The brief the service runs now, from any chat row; null with no chat listed. */
export const currentBrief = (rows: readonly SessionRow[]): string | null => rows.find(row => row.chat && row.brief)?.brief?.current ?? null;
