import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duties } from "../../src/chat-duty-run.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { type Duty, upsertDuty } from "../../src/shared/chat-duties.ts";

/**
 * Runs one stored duty's precheck the way the chat server's duty runner does (`Duties`, as test/duty-add-current-path.test.ts does), in a
 * private data folder: `duty-replay.ts <chatId> <stored duty.json> <data dir> <out.json>`. The caller starts it with a private HOME, TMPDIR and
 * XDG dirs. The duty keeps its command and cwd and gets a 30 min schedule, so one tick runs it now. Writes the run records and the precheck output.
 */
const [chat, dutyFile, dataDir, out] = process.argv.slice(2);
if (!chat || !dutyFile || !dataDir || !out) throw new Error("usage: duty-replay.ts <chatId> <duty.json> <data dir> <out.json>");
const stored = JSON.parse(readFileSync(dutyFile, "utf8")) as Duty;
const store = new DutyStore(dataDir);
await store.update(chat, duties => upsertDuty(duties, { name: stored.name, ownerWords: stored.ownerWords, goal: stored.goal, metrics: stored.metrics, onMiss: stored.onMiss,
  precheck: stored.precheck, schedule: { kind: "every", minutes: 30 } }, Date.now()));
const duties = new Duties(store, {
  isChat: async () => true, now: () => Date.now() + 31 * 60_000, tickMs: 0, node: process.execPath,
  jobs: { chat: async id => ({ id, name: "replay", cwd: dataDir, board: id }), working: async () => false, retire: async () => {}, start: async (_chat, name) => ({ id: "replay-job", name }) },
});
await duties.tick();
await duties.settled();
duties.close();
const outputs: unknown[] = [];
const visit = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) visit(path);
    else if (name.endsWith(".json")) { try { const value = JSON.parse(readFileSync(path, "utf8")) as { release?: unknown }; if (value && typeof value.release === "string") outputs.push(value); } catch { /* not an output */ } }
  }
};
visit(store.chatDir(chat));
let cwdReal: string | null = null;
try { cwdReal = realpathSync(stored.precheck.cwd); } catch { cwdReal = null; }
writeFileSync(out, JSON.stringify({ at: Date.now(), cwd: stored.precheck.cwd, cwdReal, command: stored.precheck.command, runs: await store.runs(chat), output: outputs.at(-1) ?? null }, null, 1));
