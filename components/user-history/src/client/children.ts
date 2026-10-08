import type { PulseReading } from "../shared/pulse.ts";
import type { ChildAgent } from "../shared/types.ts";

export const isActiveChild = (child: ChildAgent): boolean => child.status === "running" || child.status === "queued";
export const childName = (child: ChildAgent): string => child.sessionName ?? child.label.split("\n", 1)[0]!.slice(0, 80);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function childActivity(child: ChildAgent): string {
  if (child.status === "queued") return "Queued";
  const activity = child.activity;
  if (!activity) return "Starting";
  if (activity.kind === "executing") return activity.toolName ? "Running " + activity.toolName : "Running a tool";
  return activity.kind === "writing" ? "Writing" : "Thinking";
}

export interface ChildDetail { lead: string; text: string; tone: "" | "quiet" | "stalled" | "failed" }
/** Line two of a subagent row: now (activity and recap) for a running child, the outcome for a finished one. `reading` is its pulse while it runs. */
export function childDetail(child: ChildAgent, reading: PulseReading | null): ChildDetail {
  if (reading?.level === "failed") return { lead: "Failed", text: oneLine(reading.text), tone: "failed" };
  if (reading && reading.level !== "live") return { lead: childActivity(child) + ", " + reading.text, text: child.recap ? oneLine(child.recap) : "", tone: reading.level };
  if (isActiveChild(child)) return { lead: childActivity(child), text: child.recap ? oneLine(child.recap) : "", tone: "" };
  if (child.status === "error") return { lead: "Failed", text: oneLine(child.error ?? ""), tone: "failed" };
  if (child.status === "cancelled") return { lead: "Cancelled", text: oneLine(child.recap ?? ""), tone: "" };
  return { lead: "", text: oneLine(child.answerPreview ?? child.recap ?? "Done"), tone: "" };
}
