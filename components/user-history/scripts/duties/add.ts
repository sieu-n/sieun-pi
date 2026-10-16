import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatLabels } from "../../src/chat-labels.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { chatPoolPriority } from "../../src/chat-pool-priority.ts";
import { morningTime, upsertDuty } from "../../src/shared/chat-duties.ts";

/**
 * `node --import tsx scripts/duties/add.ts <chatId> <duty.json> [--data-dir <dir>]`: adds the duty to the chat, or updates the definition of the
 * chat's duty with the same name and keeps its run state, so running it twice changes nothing. The server picks it up at its next 30 s tick.
 * A relative `precheck.cwd` is resolved against the duty file's folder, so a checked-in duty names no home path.
 * A duty is named by the system it looks after, in two to four plain words, like "Chat system"; parseDutyInput refuses "<something> health".
 * It has one headline metric (`"headline": true`) and at most 3 supporting ones; parseDutyInput refuses more, and refuses zero or two headlines.
 * Leave out `schedule` and a new duty runs daily at a random free morning minute in its chat's priority band (`morningTime`; the chat's
 * sidebar label in labels.json, none is high), and an update keeps the duty's schedule. Keep a duty daily unless the owner asks for another
 * cadence (c66). It prints the schedule and the chat's priority.
 */
const FLAGS = ["--data-dir"] as const;
const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if ((FLAGS as readonly string[]).includes(arg)) flags.set(arg, args[++index] ?? "");
  else positional.push(arg);
}
const dataDir = flags.has("--data-dir") ? resolve(flags.get("--data-dir")!) : join(homedir(), ".prime/agent/browser-chat");
const [chatId, file] = positional;
if (!chatId || !file) {
  process.stderr.write("usage: add.ts <chatId> <duty.json> [--data-dir <dir>]\n");
  process.exit(2);
}
const definition: unknown = JSON.parse(await readFile(file, "utf8"));
const precheck = (definition as { precheck?: { cwd?: unknown } }).precheck;
if (typeof precheck?.cwd === "string") precheck.cwd = resolve(dirname(resolve(file)), precheck.cwd);
const store = new DutyStore(dataDir);
const priority = chatPoolPriority((await new ChatLabels(join(dataDir, "labels.json")).snapshot()).threads[chatId]?.priority ?? 0);
const taken = new Set<string>();
for (const chat of await store.chats()) for (const duty of await store.list(chat)) if (duty.schedule.kind === "daily") taken.add(duty.schedule.at);
const now = Date.now();
const name = (definition as { name?: string }).name;
const { result, schedule } = await store.update(chatId, duties => {
  const result = upsertDuty(duties, definition, now, morningTime(taken, priority, Math.random));
  return { result, schedule: duties.find(duty => duty.name === name?.trim())!.schedule };
}).catch((error: unknown) => {
  process.stderr.write(`refused ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
const when = schedule.kind === "daily" ? `daily ${schedule.at}` : `every ${schedule.minutes} min`;
process.stdout.write(`${result} "${name}" in ${chatId} ${when}, priority ${priority}\n`);
