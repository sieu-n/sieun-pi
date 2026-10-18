import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatService } from "../../src/chat-host.ts";
import { type ArchiveMark, type Check, chatEntries, chatToolsReopen, FOLLOW_UP, judge as toolChecks } from "./chat-tools-reopen.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The daily Chat reopen duty's scenario (scripts/duties/chat-reopen.duty.json). It sends chat-tools-reopen's ordinary task and follow-up and
 * judges the run on ~/.prime/agent/clean-room/reopen-first-message/criteria.md, whose run-3 passed by hand on 10-18, plus the chat's return to
 * the chat list (p24: in run-2 of 10-18 the reopened chat stayed in archived-chats.json and GET agents answered 404 "This thread is not a chat.").
 * The verdict text ends with a `Readings:` line that the duty's precheck (scripts/duties/chat-reopen.ts) reads.
 */
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 160): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const readText = (file: string): string => existsSync(file) ? readFileSync(file, "utf8") : "";

/** The duty's readings, 1 when every criterion behind it is met and 0 otherwise: a criterion not reached yet is no pass. */
export const READINGS = {
  followup_answered: ["archive", "send", "landed", "reply"],
  tools_after_reopen: ["tools"],
  chat_listed_after_reopen: ["listed"],
} as const;
export type ReadingKey = keyof typeof READINGS;

interface NamedCheck { key: string; ok: boolean | null; detail: string }

/** Whether the server lists the chat again: out of archived-chats.json, and its agents route answers as a chat's. */
async function listed(chat: string): Promise<NamedCheck> {
  const archived = (JSON.parse(readText(join(DATA, "archived-chats.json")) || "{}") as { ids?: string[] }).ids ?? [];
  const inArchive = archived.includes(chat);
  let route: string;
  let answered = false;
  try {
    const service = await chatService(DATA);
    if (!service) throw new Error(`no chat service in ${DATA}`);
    const response = await fetch(`${service.base}api/threads/${chat}/agents`, { headers: { "x-chat-token": service.token, origin: service.origin },
      signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    answered = response.ok && Array.isArray((JSON.parse(body) as { agents?: unknown }).agents);
    route = `GET api/threads/${chat}/agents answered ${response.status} ${clip(body, 120)} at ${iso(Date.now())}`;
  } catch (error) { route = `GET agents failed: ${error instanceof Error ? error.message : String(error)}`; }
  return { key: "listed", ok: !inArchive && answered, detail: `${inArchive ? "still" : "not"} in archived-chats.json; ${route}` };
}

/** Criteria 2 to 5 of reopen-first-message/criteria.md: the archive while idle, one send, the message landing once, and its finished reply. */
function followUp(run: string, state: RunState): NamedCheck[] {
  const chat = state.chat.id;
  const markFile = join(run, "archive.json");
  const mark = existsSync(markFile) ? JSON.parse(readFileSync(markFile, "utf8")) as ArchiveMark & { sent?: boolean } : undefined;
  // collect and evaluate both append the run's service.log block, so each audit line can show twice.
  const audit = [...new Set(readText(join(run, "service.log")).split("\n"))].flatMap(line => {
    if (!line.includes('"chat_archive"') || !line.includes(chat)) return [];
    try { return [JSON.parse(line) as { at: string; requestId: string; outcome: string; targetSessionId: string }]; } catch { return []; }
  }).filter(entry => entry.targetSessionId === chat && mark !== undefined && Date.parse(entry.at) >= mark.at - 60_000);
  const completed = audit.find(entry => entry.outcome === "completed");
  const archive: NamedCheck = { key: "archive", ok: mark ? Boolean(mark.sent && mark.idle.startsWith("idle") && completed) : null,
    detail: mark ? `${mark.idle}; chat_archive ${audit.map(entry => `${entry.outcome} at ${entry.at} (request ${entry.requestId})`).join(", ") || "not in service.log"}` : "not archived" };

  const log = readText(join(run, "clean-room.log")).split("\n");
  const sending = log.filter(line => / sending the owner's message \(request /.test(line));
  const sent = log.filter(line => / sent the owner's message \(request /.test(line));
  const failed = log.filter(line => / send failed \(request /.test(line));
  const id = (line: string | undefined) => /\(request ([0-9a-f]+)\)/.exec(line ?? "")?.[1];
  const send: NamedCheck = { key: "send", ok: sending.length === 0 ? null : sending.length === 1 && sent.length === 1 && failed.length === 0 && id(sending[0]) === id(sent[0]),
    detail: `${sending.length} sending, ${sent.length} sent and ${failed.length} send failed lines in clean-room.log${sent[0] ? `: "${clip(sent[0], 120)}"` : ""}${failed[0] ? `; "${clip(failed[0], 160)}"` : ""}` };

  const entries = chatEntries(chat);
  const archivedAt = mark ? entries.find(entry => entry.type === "session_state" && entry.status === "archived" && entry.at >= mark.at - 60_000) : undefined;
  const copies = archivedAt ? entries.filter(entry => entry.at > archivedAt.at && entry.role === "user" && entry.text.includes(FOLLOW_UP)) : [];
  const landed: NamedCheck = { key: "landed", ok: !archivedAt ? (mark ? false : null) : copies.length === 0 ? null : copies.length === 1,
    detail: archivedAt ? `${copies.length} copies of the follow-up after the archive's session_state at ${iso(archivedAt.at)}${copies[0] ? `, first at line ${copies[0].line + 1}` : ""}`
      : "no session_state archived entry after the archive" };

  const reopen = copies[0];
  const after = reopen ? entries.filter(entry => entry.line > reopen.line) : [];
  const end = after.find(entry => entry.role === "assistant" && entry.stopReason !== undefined && entry.stopReason !== "toolUse");
  const between = after.filter(entry => (!end || entry.line < end.line) && (entry.role === "user" || entry.customType === "agent_message"));
  const reply: NamedCheck = { key: "reply", ok: !reopen ? null : between.length ? false : end ? end.stopReason === "stop" : null,
    detail: !reopen ? "no follow-up yet" : between.length ? `input before the reply ended: ${between.map(entry => `line ${entry.line + 1} "${clip(entry.text, 80)}"`).join("; ")}`
      : end ? `the reply at line ${end.line + 1}, ${iso(end.at)}, ends with stopReason ${end.stopReason}: "${clip(end.text)}"` : "the reply has not ended yet" };
  return [archive, send, landed, reply];
}

/** The criteria of chat-tools-reopen behind "required chat tools stay available": the chat brief, the five tools, and no missing-tool error. */
const TOOL_CRITERIA = [6, 7, 9];

async function evaluate(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const tools = toolChecks(run, state);
  const toolOk = (ids: readonly number[]): boolean | null => {
    const picked = tools.checks.filter((check: Check) => ids.includes(check.id));
    return picked.some(check => check.ok === false) ? false : picked.every(check => check.ok === true) ? true : null;
  };
  const named: NamedCheck[] = [
    { key: "base", ok: tools.verdict === "pass" ? true : tools.verdict === "fail" ? false : null, detail: `chat-tools-reopen criteria 1 to 10: ${tools.verdict}` },
    ...followUp(run, state),
    { key: "tools", ok: toolOk(TOOL_CRITERIA), detail: tools.checks.filter(check => TOOL_CRITERIA.includes(check.id)).map(check => `${check.id}. ${check.detail}`).join("; ") },
  ];
  // The send route answers once the message is in the outbox (src/outbox.ts), so the chat is listed again only once the reopen ran: read the
  // list after the reply ended, and before that the check is not reached yet. The 12:13Z smoke run on 10-18 read it 0.1 s after the send.
  const replied = named.find(check => check.key === "reply")?.ok;
  named.push(replied === true ? await listed(state.chat.id) : { key: "listed", ok: null, detail: "read once the follow-up's reply has ended" });
  const ok = (key: string) => named.find(check => check.key === key)?.ok === true;
  const readings = Object.fromEntries(Object.entries(READINGS).map(([key, needs]) => [key, needs.every(ok) ? 1 : 0])) as Record<ReadingKey, number>;
  const verdict: Verdict = named.some(check => check.ok === false) ? "fail" : named.every(check => check.ok === true) ? "pass" : "open";
  const word = (value: boolean | null) => value === null ? "not reached yet" : value ? "met" : "not met";
  const text = [`# ${state.chat.name}: ${verdict}`, "", `Chat ${state.chat.id} on ${state.release}, set up ${iso(state.setupAt)}. Criteria: reopen-first-message/criteria.md, unchanged, and p24.`, "",
    ...named.map(check => `- ${check.key}: ${word(check.ok)}: ${check.detail}`), "", "## chat-tools-reopen criteria", "", tools.text, "",
    `Readings: ${Object.entries(readings).map(([key, value]) => `${key} ${value}`).join(", ")}`, ""].join("\n");
  return { verdict, text };
}

export const reopenFirstMessage: Scenario = { ...chatToolsReopen, name: "reopen-first-message", evaluate };
