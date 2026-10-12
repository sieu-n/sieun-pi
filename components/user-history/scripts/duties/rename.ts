import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { dutyNameProblem } from "../../src/shared/chat-duties.ts";

/**
 * `node --import tsx scripts/duties/rename.ts <chatId> <old name> <new name> [--data-dir <dir>]`: renames a chat's duty and keeps its id, runs,
 * saved state and schedule, so the renamed duty file updates it through add.ts instead of adding a second duty. Running it twice changes nothing.
 */
const args = process.argv.slice(2);
const at = args.indexOf("--data-dir");
const dataDir = at >= 0 ? resolve(args[at + 1] ?? "") : join(homedir(), ".prime/agent/browser-chat");
const [chatId, from, to] = at >= 0 ? args.filter((_, index) => index !== at && index !== at + 1) : args;
if (!chatId || !from || !to) { process.stderr.write("usage: rename.ts <chatId> <old name> <new name> [--data-dir <dir>]\n"); process.exit(2); }
const problem = dutyNameProblem(to);
if (problem) { process.stderr.write(problem + "\n"); process.exit(2); }
const result = await new DutyStore(dataDir).update(chatId, duties => {
  const old = duties.find(duty => duty.name === from);
  const renamed = duties.find(duty => duty.name === to.trim());
  if (old && renamed) return `both "${from}" (${old.id}) and "${to}" (${renamed.id}) exist; remove one first`;
  if (renamed) return `unchanged ${renamed.id}`;
  if (!old) return `no duty named "${from}"`;
  Object.assign(old, { name: to.trim(), updatedAt: Date.now() });
  return `renamed ${old.id}`;
});
process.stdout.write(`${result} in ${chatId}\n`);
if (!/^(renamed|unchanged) /.test(result)) process.exit(1);
