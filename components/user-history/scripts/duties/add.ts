import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatLabels } from "../../src/chat-labels.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { chatPoolPriority } from "../../src/chat-pool-priority.ts";
import { agentScheduleProblem, morningTime, parseSchedule, upsertDuty } from "../../src/shared/chat-duties.ts";

/**
 * `node --import tsx scripts/duties/add.ts <chatId> <duty.json> [--data-dir <dir>]`: adds the duty to the chat, or updates the definition of the
 * chat's duty with the same name and keeps its run state, so running it twice changes nothing. The server picks it up at its next 30 s tick.
 * A relative `precheck.cwd` is resolved against the duty file's folder, so a checked-in duty names no home path.
 * A duty is named by the system it looks after, in two to four plain words, like "Chat system"; parseDutyInput refuses "<something> health".
 * Leave out `schedule` and a new duty runs daily at a random free morning minute in its chat's priority band (`morningTime`; the chat's
 * sidebar label in labels.json, none is high), and an update keeps the duty's schedule. Agents run this, so `every N minutes` under a day is
 * refused (c66); `{ kind: daily, at: HH:MM }` and every 1440 or more pass. It prints the schedule and the chat's priority.
 */
const args = process.argv.slice(2);
const at = args.indexOf("--data-dir");
const dataDir = at >= 0 ? resolve(args[at + 1] ?? "") : join(homedir(), ".prime/agent/browser-chat");
const [chatId, file] = at >= 0 ? args.filter((_, index) => index !== at && index !== at + 1) : args;
if (!chatId || !file) { process.stderr.write("usage: add.ts <chatId> <duty.json> [--data-dir <dir>]\n"); process.exit(2); }
const definition: unknown = JSON.parse(await readFile(file, "utf8"));
const given = (definition as { schedule?: unknown }).schedule;
const refused = given === undefined ? null : agentScheduleProblem(parseSchedule(given));
if (refused) { process.stderr.write(refused + "\n"); process.exit(1); }
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
});
const when = schedule.kind === "daily" ? `daily ${schedule.at}` : `every ${schedule.minutes} min`;
process.stdout.write(`${result} "${name}" in ${chatId} ${when}, priority ${priority}\n`);
