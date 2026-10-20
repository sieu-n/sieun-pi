/**
 * The global harness store of a clean-room trial. On 10-19 readme-preview run4's job saved a global memory about RefuseManualStop servers with
 * `rlm.harness.create_memory(..., global_=True)`, and the memory then loaded into every other live session, because Prime points each kernel's
 * RLM_GLOBAL_HARNESS_STATE_DIR at the one published store, ~/.prime/agent/harness.
 *
 * Setup copies the published harness_state.json into `<run>/harness` and files that folder under the trial's chats in clean-room-harness.json.
 * Before each ipython cell of a session of a trial chat (the chat, its jobs and their subagents), the extension sets the kernel's
 * RLM_GLOBAL_HARNESS_STATE_DIR to that folder, so the trial starts from the published entries and its global writes stay in the run. Prime's
 * harness digest still reads the published store. Teardown keeps the store next to the verdict file.
 *
 * A trial session's first turn starts inside its create, before setup knows its id, so setup files each name it asks for before the create's
 * POST, with the time it asked. A root of that name started since then is the one that create made: the daemon refuses a root name any
 * session ever had, and a session older than the ask keeps Prime's store.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachedJsonFile, type JsonFile, transactJsonFile } from "./locked-json.ts";

export const TRIAL_HARNESS_FILE = "clean-room-harness.json";
const STATE = "harness_state.json";

/**
 * Each trial chat by session id: its name, for a person reading the file, and the folder that holds its global harness store. `names` holds
 * each name setup asked a create for, with the store and the time of the ask.
 */
interface TrialHarnesses { trials: Record<string, { name: string; dir: string }>; names: Record<string, { dir: string; since: number }> }

/** A session the store may be filed under: by id, or by its root name and start time while setup did not know its id yet. */
export interface TrialSession { id: string; name?: string; at?: number }

const record = (value: unknown, key: string): Record<string, unknown> => {
  const field = typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === "object" && field !== null ? field as Record<string, unknown> : {};
};

const file = (dataDir: string): JsonFile<TrialHarnesses> => ({ path: join(dataDir, TRIAL_HARNESS_FILE), label: "Clean-room harness index",
  initial: () => ({ trials: {}, names: {} }), parse(value: unknown): TrialHarnesses {
    return { trials: Object.fromEntries(Object.entries(record(value, "trials")).filter((entry): entry is [string, { name: string; dir: string }] => {
      const trial = entry[1] as { name?: unknown; dir?: unknown } | null;
      return typeof trial === "object" && trial !== null && typeof trial.name === "string" && typeof trial.dir === "string";
    })), names: Object.fromEntries(Object.entries(record(value, "names")).filter((entry): entry is [string, { dir: string; since: number }] => {
      const named = entry[1] as { dir?: unknown; since?: unknown } | null;
      return typeof named === "object" && named !== null && typeof named.dir === "string" && typeof named.since === "number";
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

/** Files `dir` under the name a trial create asks for, before its POST, with `since`, the time setup first asked for that create. */
export async function fileTrialName(dataDir: string, name: string, dir: string, since: number): Promise<void> {
  await transactJsonFile(file(dataDir), state => { state.names[name] = { dir, since }; });
}

/** The store filed for the first of the sessions `sessions` gives, by id or by name, read only once a trial was ever filed on this box. */
export async function trialHarnessDir(dataDir: string, sessions: () => Promise<readonly TrialSession[]>): Promise<string | undefined> {
  if (!existsSync(join(dataDir, TRIAL_HARNESS_FILE))) return undefined;
  const { trials, names } = await cachedJsonFile(file(dataDir));
  const named = (session: TrialSession): string | undefined => {
    const entry = session.name && Object.hasOwn(names, session.name) ? names[session.name] : undefined;
    return entry && session.at !== undefined && session.at >= entry.since ? entry.dir : undefined;
  };
  return (await sessions()).map(session => (Object.hasOwn(trials, session.id) ? trials[session.id]!.dir : undefined) ?? named(session)).find(dir => dir !== undefined);
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
