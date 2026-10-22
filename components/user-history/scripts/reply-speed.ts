import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Projector } from "../src/chat-projection.ts";
import { historyMessages, readBranchPage } from "../src/session-tail.ts";
import { chatLines, poolSlot } from "../src/shared/chat-feed.ts";

/**
 * How long the owner's chats took to answer each of his messages, for the 10-22 question "are the chats getting slower to answer me this
 * week?". It reads the chats' transcripts the way the Owner messages precheck does (owner-messages.ts): his lines and the chat's lines are
 * the :5182 feed's (chatLines). Each row is one owner message in the window with the times the turn reached:
 * - sentAt: the user message's own timestamp, enteredAt: when its entry was written to the session, so enteredAt - sentAt is the time it waited
 *   for the chat's running work before the turn took it.
 * - firstModelAt: the start of the first model call after it, replyAt: when the first chat line he sees (a tell_owner bubble or a reply text)
 *   was done, and its kind.
 * - modelCalls, toolCalls, modelMs, toolMs and poolWaitMs over the messages from his message to that reply: poolWaitMs is the time a failed
 *   call that pi-pool turned into a wait for an account slept until the next call, retryMs the same after any other failed call, and idleMs
 *   the time from a turn that ended without a line he sees (endedTurns) to the next model call.
 * No model call and no write but the out file.
 *
 *   node --import tsx scripts/reply-speed.ts --out <file> --since <ISO> --host <name> --chats <id,id> --dir <sessions dir> [--dir ...]
 * Each dir is searched for <chat>.jsonl and <chat>.jsonl.returned-to-mac; a chat found in several files gives a row per file, and the reader
 * keeps one row per (chat, sentAt).
 */
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const dirs = args.flatMap((arg, index) => arg === "--dir" ? [args[index + 1]!] : []);
const out = opt("--out"), host = opt("--host") ?? "", since = Date.parse(opt("--since") ?? "");
const chats = (opt("--chats") ?? "").split(",").filter(Boolean);
if (!out || !Number.isFinite(since) || !chats.length || !dirs.length) { process.stderr.write("usage: --out <file> --since <ISO> --host <name> --chats <ids> --dir <dir>\n"); process.exit(2); }

const projector = new Projector({ put: () => "x", link: () => {} } as never);
async function branchSince(file: string, from: number): Promise<any[]> {
  let place = null; const pages: any[][] = [];
  for (;;) {
    const page = await readBranchPage(file, place, { messages: 2000, bytes: 16 * 1024 * 1024 });
    if (!page) return pages.flat();
    pages.unshift(page.entries);
    if (!page.before || (page.entries.length ? Date.parse(page.entries[0]!.timestamp) : 0) < from) break;
    place = page.before;
  }
  return pages.flat();
}

const rows: object[] = [];
for (const chat of chats) for (const dir of dirs) for (const name of [`${chat}.jsonl`, `${chat}.jsonl.returned-to-mac`]) {
  const file = join(dir, name);
  if (!existsSync(file)) continue;
  const entries = (await branchSince(file, since - 6 * 3_600_000)).filter(entry => entry.type === "message" || entry.type === "custom_message");
  const written = (entry: any): number => Date.parse(entry.timestamp);
  const stamp = (entry: any): number => entry.type === "message" ? entry.message.timestamp : written(entry);
  const lines = chatLines(projector.messages(historyMessages(entries))).filter(line => line.kind === "user" || line.kind === "agent");
  const results = new Map<string, any>();
  entries.forEach(entry => { if (entry.message?.role === "toolResult") results.set(entry.message.toolCallId, entry); });
  const indexAt = (at: number, role: string): number => entries.findIndex(entry => entry.type === "message" && entry.message.role === role && entry.message.timestamp === at);
  lines.forEach((line, k) => {
    if (line.kind !== "user" || line.at < since) return;
    const start = indexAt(line.at, "user");
    if (start < 0) return;
    const reply = lines.slice(k + 1).find(later => later.kind === "agent");
    let end = entries.length, replyAt: number | null = null, replyKind: string | null = null;
    if (reply) {
      end = indexAt(reply.at, "assistant");
      const part = /-t(\d+)$/.exec(reply.id);
      const call = part && end >= 0 ? entries[end].message.content[Number(part[1])] : null;
      replyKind = call ? "told" : "text";
      replyAt = end < 0 ? reply.at : call && results.has(call.id) ? written(results.get(call.id)) : written(entries[end]);
      if (end < 0) end = entries.length;
    }
    let modelCalls = 0, toolCalls = 0, modelMs = 0, toolMs = 0, poolWaitMs = 0, retryMs = 0, idleMs = 0, endedTurns = 0, errors = 0, firstModelAt: number | null = null;
    let lastCallEnd: number | null = null;
    for (let index = start + 1; index <= Math.min(end, entries.length - 1); index++) {
      const entry = entries[index]!;
      const message = entry.message;
      if (entry.type !== "message") continue;
      if (message.role === "assistant") {
        modelCalls++;
        firstModelAt ??= message.timestamp;
        modelMs += Math.max(0, written(entry) - message.timestamp);
        toolCalls += message.content.filter((part: any) => part.type === "toolCall").length;
        const next = entries.slice(index + 1).find(later => later.type === "message" && later.message.role === "assistant");
        const pause = next ? Math.max(0, next.message.timestamp - written(entry)) : 0;
        if (message.stopReason === "error") {
          errors++;
          if (poolSlot(message.errorMessage ?? "") !== null) poolWaitMs += pause;
          else retryMs += pause;
        } else if (message.stopReason !== "toolUse") { endedTurns++; idleMs += pause; }
        lastCallEnd = written(entry);
      } else if (message.role === "toolResult" && lastCallEnd !== null) {
        toolMs += Math.max(0, written(entry) - lastCallEnd);
        lastCallEnd = written(entry);
      }
    }
    const before = entries.slice(0, start).reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
    rows.push({ chat, host, file: name, sentAt: line.at, enteredAt: written(entries[start]), busy: before ? before.message.stopReason === "toolUse" : false,
      firstModelAt, replyAt, replyKind, modelCalls, toolCalls, modelMs, toolMs, poolWaitMs, retryMs, idleMs, endedTurns, errors, text: line.text.slice(0, 80) });
  });
}
writeFileSync(out, JSON.stringify(rows));
process.stdout.write(`${rows.length} owner messages\n`);
