/**
 * The global harness store of a clean-room trial. On 10-19 readme-preview run4's job saved a global memory about RefuseManualStop servers with
 * `rlm.harness.create_memory(..., global_=True)`, and the memory then loaded into every other live session, because Prime points each kernel's
 * RLM_GLOBAL_HARNESS_STATE_DIR at the one published store, ~/.prime/agent/harness.
 *
 * Setup copies the published harness_state.json into `<run>/harness` and files that folder under the trial's chats in clean-room-harness.json.
 * Before each ipython cell of a session of a trial chat (the chat, its jobs and their subagents), the extension sets the kernel's
 * RLM_GLOBAL_HARNESS_STATE_DIR to that folder, so the trial starts from the published entries and its global writes stay in the run. Prime's
 * harness digest still reads the published store. Teardown keeps the store next to the verdict file.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachedJsonFile, type JsonFile, transactJsonFile } from "./locked-json.ts";

export const TRIAL_HARNESS_FILE = "clean-room-harness.json";
const STATE = "harness_state.json";

/** Each trial chat by session id: its name, for a person reading the file, and the folder that holds its global harness store. */
interface TrialHarnesses { trials: Record<string, { name: string; dir: string }> }

const file = (dataDir: string): JsonFile<TrialHarnesses> => ({ path: join(dataDir, TRIAL_HARNESS_FILE), label: "Clean-room harness index",
  initial: () => ({ trials: {} }), parse(value: unknown): TrialHarnesses {
    const trials = typeof value === "object" && value !== null && "trials" in value && typeof value.trials === "object" && value.trials !== null
      ? value.trials as Record<string, unknown> : {};
    return { trials: Object.fromEntries(Object.entries(trials).filter((entry): entry is [string, { name: string; dir: string }] => {
      const trial = entry[1] as { name?: unknown; dir?: unknown } | null;
      return typeof trial === "object" && trial !== null && typeof trial.name === "string" && typeof trial.dir === "string";
    })) };
  } });

/** Copies the published store (`<agentDir>/harness/harness_state.json`) into `<run>/harness` once, and returns that folder. */
export function seedTrialHarness(run: string, agentDir: string): string {
  const dir = join(run, "harness");
  mkdirSync(dir, { recursive: true });
  const published = join(agentDir, "harness", STATE);
  if (!existsSync(join(dir, STATE)) && existsSync(published)) copyFileSync(published, join(dir, STATE));
  return dir;
}

/** Files `dir` as the global harness store of each chat in `chats`. */
export async function fileTrialHarness(dataDir: string, chats: readonly { id: string; name: string }[], dir: string): Promise<void> {
  await transactJsonFile(file(dataDir), state => { for (const chat of chats) state.trials[chat.id] = { name: chat.name, dir }; });
}

/** The store filed under the first of the chat session ids `ids` gives, read only once a trial was ever filed on this box. */
export async function trialHarnessDir(dataDir: string, ids: () => Promise<readonly string[]>): Promise<string | undefined> {
  if (!existsSync(join(dataDir, TRIAL_HARNESS_FILE))) return undefined;
  const { trials } = await cachedJsonFile(file(dataDir));
  return (await ids()).map(id => trials[id]?.dir).find(dir => dir !== undefined);
}

/** One line that points the kernel's global harness store at `dir`, before the cell's own code. */
export function withTrialHarness(code: string, dir: string): string {
  const line = `__import__("os").environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = ${JSON.stringify(dir)}\n`;
  return code.startsWith(line) ? code : line + code;
}

/** Teardown's copy of the trial's store, `<run>.harness_state.json` next to the verdict file, or undefined when the run holds no store. */
export function keepTrialHarness(run: string): string | undefined {
  const state = join(run, "harness", STATE);
  if (!existsSync(state)) return undefined;
  const kept = join(dirname(run), `${basename(run)}.${STATE}`);
  copyFileSync(state, kept);
  return kept;
}
