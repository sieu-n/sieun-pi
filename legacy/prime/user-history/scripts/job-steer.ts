#!/usr/bin/env node
/**
 * A check-in job's message to a job of its chat. A chat's jobs are its subagents, which a check-in job cannot reach with agent_message, so the
 * chat server delivers the message into the job's session, or restarts the job with it when its last turn ended in an error.
 *
 *   node --import tsx scripts/job-steer.ts <chat session id> <job name or session id> <message>
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { chatService, restartAnswer, throughRestart } from "../src/chat-host.ts";

const [chat, job, ...words] = process.argv.slice(2);
const message = words.join(" ").trim();
if (!chat || !job || !message) {
  console.error("usage: job-steer.ts <chat session id> <job name or session id> <message>");
  process.exit(2);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * This caller's session, which the server records on the steer's receipt and checks against a running clean-room trial's wall: a root's
 * RLM_SESSION_DIR is named for it, and a subagent's holds its one <id>.jsonl.
 */
function callerSession(): string | undefined {
  const folder = process.env.RLM_SESSION_DIR ?? "";
  if (UUID.test(basename(folder))) return basename(folder);
  const logs = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith(".jsonl") && UUID.test(name.slice(0, -6))) : [];
  return logs.length === 1 ? logs[0]!.slice(0, -6) : undefined;
}
const caller = callerSession();
/** The root of this caller's tree: the folder after session-artifacts in RLM_SESSION_DIR (.../session-artifacts/<root>/sub-...). */
const parts = (process.env.RLM_SESSION_DIR ?? "").split("/");
const callerRoot = parts.flatMap((part, index) => part === "session-artifacts" && UUID.test(parts[index + 1] ?? "") ? [parts[index + 1]!] : [])[0];
const data = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const service = await chatService(data);
if (!service) { console.error(`job-steer: no chat service is set up in ${data} or in hosts.json`); process.exit(1); }
const response = await throughRestart(async () => {
  const answer = await fetch(`${service.base}api/threads/${encodeURIComponent(chat)}/job-steer`, {
    method: "POST", body: JSON.stringify({ job, message }), signal: AbortSignal.timeout(180_000),
    headers: { "content-type": "application/json", "x-chat-token": service.token, origin: service.origin, ...caller ? { "x-chat-agent-session": caller } : {},
      ...callerRoot ? { "x-chat-agent-root": callerRoot } : {} } });
  const body = await answer.text();
  if (restartAnswer(answer.status, body)) throw new Error(`Chat service answered ${answer.status}`);
  return { ok: answer.ok, status: answer.status, text: body };
});
const text = response.text;
if (!response.ok) { console.error(`job-steer: ${response.status} ${text}`); process.exit(1); }
const { act, session } = JSON.parse(text) as { act: string; session: string };
console.log(act === "relay" ? `sent ${job} the message through its chat (session ${session}), because the server cannot reach the job` :
  `${act === "restart" ? "restarted" : "steered"} ${job} (session ${session})`);
