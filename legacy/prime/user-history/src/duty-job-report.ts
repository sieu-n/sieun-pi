import { open } from "node:fs/promises";

/**
 * When a duty job last got a prompt and when it last sent its chat a message, read from its transcript. A prompt is a user message: its
 * brief, a hand-off steer, the chat's steer or a quota resume. A sent message is the receipt `agent_message.send` prints in an ipython tool
 * result, the one src/chat-agents.ts reads, naming the chat as its target. 0 means none yet.
 */
export interface ReportMarks { promptAt: number; reportAt: number }

const RECEIPT = /'source': 'agent_message', 'target': \{[^}]*?'sessionId': '([^']+)'/g;

const entryTime = (entry: { timestamp?: unknown; message?: { timestamp?: unknown } }): number => {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(at)) return at;
  return typeof entry.message?.timestamp === "number" ? entry.message.timestamp : 0;
};

/** `from` moved on by transcript `lines` for the chat `chatId`. */
export function reportMarks(lines: readonly string[], chatId: string, from: ReportMarks = { promptAt: 0, reportAt: 0 }): ReportMarks {
  let { promptAt, reportAt } = from;
  for (const line of lines) {
    if (!line.startsWith('{"type":"message"')) continue;
    let entry: { timestamp?: unknown; message?: { role?: unknown; timestamp?: unknown; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const role = entry.message?.role;
    if (role === "user") { promptAt = Math.max(promptAt, entryTime(entry)); continue; }
    if (role !== "toolResult" || !Array.isArray(entry.message?.content)) continue;
    for (const part of entry.message.content as unknown[]) {
      const text = typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "";
      if ([...text.matchAll(RECEIPT)].some(match => match[1] === chatId)) reportAt = Math.max(reportAt, entryTime(entry));
    }
  }
  return { promptAt, reportAt };
}

/** Whether the job's report is in: it sent the chat a message after its last prompt. */
export const reportedSince = (marks: ReportMarks): boolean => marks.reportAt > 0 && marks.reportAt >= marks.promptAt;

/**
 * `reportMarks` of a transcript file, read once and then only for the bytes appended since, so a runner that asks on every tick reads each
 * line once. A file that got shorter is read again from its start. A line still being written waits for the next read.
 */
export function reportReader(): (file: string, chatId: string) => Promise<ReportMarks> {
  const read = new Map<string, { chatId: string; offset: number; marks: ReportMarks }>();
  return async (file, chatId) => {
    const handle = await open(file, "r").catch(() => null);
    if (!handle) { read.delete(file); return { promptAt: 0, reportAt: 0 }; }
    try {
      const { size } = await handle.stat();
      let kept = read.get(file);
      if (!kept || kept.chatId !== chatId || size < kept.offset) kept = { chatId, offset: 0, marks: { promptAt: 0, reportAt: 0 } };
      if (size > kept.offset) {
        const buffer = Buffer.alloc(size - kept.offset);
        await handle.read(buffer, 0, buffer.length, kept.offset);
        const end = buffer.lastIndexOf(0x0a) + 1;
        if (end > 0) kept = { chatId, offset: kept.offset + end, marks: reportMarks(buffer.subarray(0, end).toString("utf8").split("\n"), chatId, kept.marks) };
      }
      read.set(file, kept);
      return kept.marks;
    } finally { await handle.close(); }
  };
}
