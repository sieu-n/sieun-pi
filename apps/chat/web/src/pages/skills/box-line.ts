import type { SkillBoxState } from "../../lib/api/shared/skills.ts";
import { stampLabel } from "../../lib/ui/datetime.ts";

export const boxName = (box: string): string => (box === "mac" ? "Mac" : box);

const when = (iso: string, now: number): string => {
  const label = stampLabel(Date.parse(iso), now);
  return label.replace(/^(Yesterday|Today) at /, (_, day: string) => `${day.toLowerCase()} at `);
};

/** The one line a layout shows for a box whose last scan failed, in the viewer's own time, such as "Mac asleep or offline since 3:00 PM, showing its scan from 2:27 PM." */
export function boxStateLine(box: SkillBoxState, now = Date.now()): string | null {
  if (box.state === "ok") return null;
  if (box.state === "never" || !box.lastOkAt) return `${boxName(box.box)} has not answered a scan yet.`;
  const since = box.since ? ` since ${when(box.since, now)}` : "";
  return `${boxName(box.box)} asleep or offline${since}, showing its scan from ${when(box.lastOkAt, now)}.`;
}
