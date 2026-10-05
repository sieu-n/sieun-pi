import type { PulseReading } from "../shared/pulse.ts";
import type { ChildAgent, ThreadMessage } from "../shared/types.ts";

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

/** A depth-0 session this thread started with `rlm.create_session`, read from the handle its tool result printed. */
export interface CreatedSession { sessionId: string; name: string }
const HANDLE = /RLMCreateSessionHandle\(active_session_id='[^']*', session_id='([^']+)', name=(?:'([^']*)'|None)/g;
/** Created sessions in first-seen order, one per session id, from the ipython tool results in the transcript. */
export function createdSessions(messages: readonly ThreadMessage[]): CreatedSession[] {
  const found = new Map<string, CreatedSession>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      for (const match of part.text.matchAll(HANDLE)) {
        const sessionId = match[1]!;
        if (!found.has(sessionId)) found.set(sessionId, { sessionId, name: match[2] ?? "" });
      }
    }
  }
  return [...found.values()];
}
