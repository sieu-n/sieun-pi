import { join } from "node:path";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord, type SubagentDelete, type ThreadView } from "../src/chat-sources.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import type { ChatBoard, ChatWait, ModelInfo, SessionRow, ThreadMessage } from "../src/shared/types.ts";

type Observer = Parameters<ChatThreads["observe"]>[0];
/** A check-in source with no timer: an empty board unless one is given, one unrelated catalog row (a catalog that has listed), and its memory in `dir`. */
const LISTED: SessionRow[] = [{ id: "other-session", name: "other" } as SessionRow];
export function source(dir: string, boards: Record<string, ChatBoard> = {}, now = () => 0, rows: () => SessionRow[] = () => LISTED): CheckInSource {
  return { board: async id => boards[id] ?? null, rows: async () => rows(), memory: checkInRecord(join(dir, "check-ins.json")),
    replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now, noReportGraceMs: 0 };
}
export function fakeThreads(calls: string[]) {
  let observer: Observer | undefined;
  let next = 1;
  const pinned = new Set<string>();
  const busyIds = new Set<string>();
  /** Threads with input queued and nothing running: `busy` but not `running`. */
  const queuedIds = new Set<string>();
  const transcripts = new Map<string, ThreadMessage[]>();
  return {
    pinned,
    busyIds,
    queuedIds,
    transcripts,
    /** Info, queue and retry the hub would hold next to the transcript. */
    extras: new Map<string, Omit<ThreadView, "messages">>(),
    state(id: string): ThreadView | undefined { const messages = transcripts.get(id); return messages ? { messages, ...this.extras.get(id) } : undefined; },
    async restart(id: string, message: string, abort?: boolean) { calls.push(`restart ${id} ${message}${abort ? " (abort)" : ""}`); },
    async abort(id: string) { calls.push(`abort ${id}`); },
    async resumeQueue(id: string) { calls.push(`resume ${id}`); },
    /** What the daemon answers a delete. */
    deleteAnswer: "deleted" as SubagentDelete,
    async deleteSubagent(id: string, childId: string) { calls.push(`delete ${id} ${childId}`); return this.deleteAnswer; },
    async unarchive(id: string) { calls.push(`unarchive ${id}`); },
    async archive(id: string) { calls.push(`archive ${id}`); },
    catalog: { models: [] as ModelInfo[], configuredProviders: [] as string[] },
    async models(_id: string) { return { ...this.catalog, current: null, thinkingLevel: null, availableThinkingLevels: [] }; },
    async setModel(id: string, provider: string, modelId: string) { calls.push(`model ${id} ${provider}/${modelId}`); },
    async setThinking(id: string, level: string) { calls.push(`thinking ${id} ${level}`); },
    async notice(id: string, text: string) { calls.push(`notice ${id} ${text}`); },
    waits: new Map<string, ChatWait | null>(),
    setWait(id: string, wait: ChatWait | null) { this.waits.set(id, wait); },
    views: new Map<string, ThreadView>(),
    async view(id: string) { return this.views.get(id) ?? null; },
    fire: () => observer!,
    busy(id: string) { return busyIds.has(id) || queuedIds.has(id); },
    running(id: string) { return busyIds.has(id); },
    async reload(id: string) { calls.push(`reload ${id}`); },
    /** Job threads whose daemon state shows work (a turn, a background bash, queued input), and the jobs `reloadIdle` reloaded. */
    sessionBusy: new Set<string>(),
    reloaded: [] as string[],
    async reloadIdle(id: string): Promise<"reloaded" | "busy" | "saved"> { if (this.sessionBusy.has(id)) return "busy"; this.reloaded.push(id); return "reloaded"; },
    async create(input: { cwd: string; name: string; kind: "chat"; thinkingLevel?: string }) { calls.push(`create ${input.kind} ${input.name} ${input.cwd}`); return { id: `s${next++}` }; },
    pin(id: string) { calls.push(`pin ${id}`); pinned.add(id); },
    unpin(id: string) { calls.push(`unpin ${id}`); pinned.delete(id); },
    async setSteeringMode(id: string, mode: string) { calls.push(`steering ${id} ${mode}`); },
    heartbeats: new Map<string, string>(),
    async heartbeat(id: string) { return this.heartbeats.get(id); },
    async clearHeartbeat(id: string) { calls.push(`heartbeat ${id} clear`); this.heartbeats.delete(id); },
    async prompt(id: string, input: { message: string; mode: string }) { calls.push(`${input.mode} ${id} ${input.message}`); },
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  };
}

/** A duty runner fake for Chats: the check-in runs it was handed, by chat. */
export function dutySink() {
  const runs: { id: string; run: CheckInRun }[] = [];
  return { runs, duty: { async checkIn(id: string, run: CheckInRun) { runs.push({ id, run }); } } };
}

export const row = (id: string, lastActivityAt: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/repo", kind: "live", status: "idle", archived: false,
  messageCount: 3, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", origin: "user", lastActivityAt, ...extra });
export const ownerAsks = (text: string, at: number): ThreadMessage => ({ role: "user", content: text, timestamp: at });
export const reply = (stopReason: "stop" | "error", at: number, errorMessage?: string): ThreadMessage =>
  ({ role: "assistant", content: [], provider: "p", model: "m", stopReason, timestamp: at, ...(errorMessage ? { errorMessage } : {}) });

export const TOKEN_FAILURE = 'Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token';
