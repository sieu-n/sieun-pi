#!/usr/bin/env node
/**
 * A check-in job's message to a job of its chat. A chat's jobs are its subagents, which a check-in job cannot reach with agent_message, so the
 * chat server delivers the message into the job's session, or restarts the job with it when its last turn ended in an error.
 *
 *   node --import tsx scripts/job-steer.ts <chat session id> <job name or session id> <message>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chatService, throughRestart } from "../src/chat-host.ts";

const [chat, job, ...words] = process.argv.slice(2);
const message = words.join(" ").trim();
if (!chat || !job || !message) {
  console.error("usage: job-steer.ts <chat session id> <job name or session id> <message>");
  process.exit(2);
}
const data = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const service = await chatService(data);
if (!service) { console.error(`job-steer: no chat service is set up in ${data} or in hosts.json`); process.exit(1); }
const response = await throughRestart(async () => {
  const answer = await fetch(`${service.base}api/threads/${encodeURIComponent(chat)}/job-steer`, {
    method: "POST", body: JSON.stringify({ job, message }), signal: AbortSignal.timeout(180_000),
    headers: { "content-type": "application/json", "x-chat-token": service.token, origin: service.origin } });
  if (answer.status >= 502 && answer.status <= 504) throw new Error(`Chat service answered ${answer.status}`);
  return answer;
});
const text = await response.text();
if (!response.ok) { console.error(`job-steer: ${response.status} ${text}`); process.exit(1); }
const { act, session } = JSON.parse(text) as { act: string; session: string };
console.log(act === "relay" ? `sent ${job} the message through its chat (session ${session}), because the server cannot reach the job` :
  act === "held" ? `${job} sleeps on a board.wake, so the message waits in that wake's note and reaches it when the wake fires (session ${session})` :
  `${act === "restart" ? "restarted" : "steered"} ${job} (session ${session})`);
