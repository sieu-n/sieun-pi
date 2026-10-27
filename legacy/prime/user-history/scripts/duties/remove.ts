import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DutyStore } from "../../src/chat-duty-store.ts";

/**
 * `node --import tsx scripts/duties/remove.ts --name <duty name> [--chat <chatId>] [--data-dir <dir>]`: deletes the duty with that name from one
 * chat, or from every chat with a duties file: its definition, its run records and its saved outputs and state. Running it twice changes
 * nothing. The counterpart of add.ts.
 */
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const name = arg("--name");
if (!name) { process.stderr.write("usage: remove.ts --name <duty name> [--chat <chatId>] [--data-dir <dir>]\n"); process.exit(2); }
const store = new DutyStore(arg("--data-dir") ? resolve(arg("--data-dir")!) : join(homedir(), ".prime/agent/browser-chat"));
const chat = arg("--chat");
let removed = 0;
for (const chatId of chat ? [chat] : await store.chats()) {
  for (const duty of (await store.list(chatId)).filter(entry => entry.name === name)) {
    if (await store.remove(chatId, duty.id)) { removed++; process.stdout.write(`removed ${duty.id} "${name}" from ${chatId}\n`); }
  }
}
process.stdout.write(removed ? `${removed} removed\n` : `no duty named "${name}"\n`);
