import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { appsChatDuties, dutiesCall } from "./apps-chat.ts";

/**
 * `node --import tsx scripts/duties/remove.ts --name <duty name> [--chat <chatId>] [--data-dir <dir>]`: deletes the duty with that name from one
 * chat, or from every chat with a duties file: its definition, its run records and its saved outputs and state. Running it twice changes
 * nothing. The counterpart of add.ts. A `--chat` the new chat holds (a :5184 agent or thread, `apps-chat.ts`) loses the duty through its
 * `POST /api/agents/:id/duties {action: "remove"}`; with `--data-dir`, remove.ts reads that Prime store only.
 */
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const name = arg("--name");
if (!name) { process.stderr.write("usage: remove.ts --name <duty name> [--chat <chatId>] [--data-dir <dir>]\n"); process.exit(2); }
const chat = arg("--chat");
const appsChat = chat && !arg("--data-dir") ? await appsChatDuties(chat) : null;
if (appsChat) {
  const { duties } = await dutiesCall(appsChat);
  const matches = duties.filter(row => row.duty.name === name);
  for (const row of matches) process.stdout.write(`${(await dutiesCall(appsChat, { action: "remove", duty: row.duty.id })).result} "${name}" from ${chat}, on the new chat\n`);
  process.stdout.write(matches.length ? `${matches.length} removed\n` : `no duty named "${name}"\n`);
  process.exit(0);
}
const store = new DutyStore(arg("--data-dir") ? resolve(arg("--data-dir")!) : join(homedir(), ".prime/agent/browser-chat"));
let removed = 0;
for (const chatId of chat ? [chat] : await store.chats()) {
  for (const duty of (await store.list(chatId)).filter(entry => entry.name === name)) {
    if (await store.remove(chatId, duty.id)) { removed++; process.stdout.write(`removed ${duty.id} "${name}" from ${chatId}\n`); }
  }
}
process.stdout.write(removed ? `${removed} removed\n` : `no duty named "${name}"\n`);
