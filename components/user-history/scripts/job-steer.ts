#!/usr/bin/env node
/**
 * A check-in job's message to a job of its chat. A chat's jobs are its subagents, which a check-in job cannot reach with agent_message, so the
 * chat server delivers the message into the job's session, or restarts the job with it when its last turn ended in an error.
 *
 *   node --import tsx scripts/job-steer.ts <chat session id> <job name or session id> <message>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [chat, job, ...words] = process.argv.slice(2);
const message = words.join(" ").trim();
if (!chat || !job || !message) {
  console.error("usage: job-steer.ts <chat session id> <job name or session id> <message>");
  process.exit(2);
}
const data = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const { url } = JSON.parse(readFileSync(join(data, "instance.json"), "utf8")) as { url: string };
const token = /data-chat-token="([a-f0-9]+)"/.exec(await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).text())?.[1];
if (!token) throw new Error(`no write token on ${url}`);
const response = await fetch(`${url}api/threads/${encodeURIComponent(chat)}/job-steer`, {
  method: "POST", body: JSON.stringify({ job, message }), signal: AbortSignal.timeout(180_000),
  headers: { "content-type": "application/json", "x-chat-token": token, origin: new URL(url).origin } });
const text = await response.text();
if (!response.ok) { console.error(`job-steer: ${response.status} ${text}`); process.exit(1); }
const { act, session } = JSON.parse(text) as { act: string; session: string };
console.log(act === "relay" ? `sent ${job} the message through its chat (session ${session}), because the server cannot reach the job` :
  act === "held" ? `${job} sleeps on a board.wake, so the message waits in that wake's note and reaches it when the wake fires (session ${session})` :
  `${act === "restart" ? "restarted" : "steered"} ${job} (session ${session})`);
