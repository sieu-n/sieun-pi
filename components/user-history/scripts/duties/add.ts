import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { upsertDuty } from "../../src/shared/chat-duties.ts";

/**
 * `node --import tsx scripts/duties/add.ts <chatId> <duty.json> [--data-dir <dir>]`: adds the duty to the chat, or updates the definition of the
 * chat's duty with the same name and keeps its run state, so running it twice changes nothing. The server picks it up at its next 30 s tick.
 * A relative `precheck.cwd` is resolved against the duty file's folder, so a checked-in duty names no home path.
 * A duty is named by the system it looks after, in two to four plain words, like "Chat system"; parseDutyInput refuses "<something> health".
 */
const args = process.argv.slice(2);
const at = args.indexOf("--data-dir");
const dataDir = at >= 0 ? resolve(args[at + 1] ?? "") : join(homedir(), ".prime/agent/browser-chat");
const [chatId, file] = at >= 0 ? args.filter((_, index) => index !== at && index !== at + 1) : args;
if (!chatId || !file) { process.stderr.write("usage: add.ts <chatId> <duty.json> [--data-dir <dir>]\n"); process.exit(2); }
const definition: unknown = JSON.parse(await readFile(file, "utf8"));
const precheck = (definition as { precheck?: { cwd?: unknown } }).precheck;
if (typeof precheck?.cwd === "string") precheck.cwd = resolve(dirname(resolve(file)), precheck.cwd);
const store = new DutyStore(dataDir);
const now = Date.now();
const result = await store.update(chatId, duties => upsertDuty(duties, definition, now));
process.stdout.write(`${result} "${(definition as { name?: string }).name}" in ${chatId}\n`);
