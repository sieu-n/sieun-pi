import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { readAgentQueue, setPoolKey, type AgentQueueReading } from "./chat-pool.ts";
import type { AgentQueueInput, AgentQueueView } from "./shared/types.ts";

/**
 * The Mac limit the queue switch writes back when it turns on with nothing remembered. Measured 10-14 07:38 KST: about 6.9 GB of RAM was
 * left for agent work and a p90 working session used 426 MB, so 16 fit (agent-queue-measure.md in the 0735-agent-queue-design session folder).
 * It matches `mac_working_max` in pi-pool's pool/base.py DEFAULTS.
 */
export const DEFAULT_MAC_WORKING_MAX = 16;
/** Input bounds for both limits. A limit above the measured 16 is the owner's call; 999 only catches a typo with extra digits. */
const LIMIT_MAX = 999;

/** `<data dir>/agent-queue.json`: the Mac limit to restore, since turning the queue off writes "off" over the number in pi-pool's config. */
type Remembered = { restoreMax: number };

export interface AgentQueue { view(): Promise<AgentQueueView>; apply(input: AgentQueueInput): Promise<AgentQueueView> }

export function parseAgentQueueInput(body: unknown): AgentQueueInput {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (value.action === "off" || value.action === "on") return { action: value.action };
  if ((value.action === "mac" || value.action === "tree") && typeof value.value === "number" && Number.isInteger(value.value) && value.value >= 1 && value.value <= LIMIT_MAX) {
    return { action: value.action, value: value.value };
  }
  throw new Error(`Use action on or off, or action mac or tree with a whole number from 1 to ${LIMIT_MAX}.`);
}

/** `title` names a session for the Next line; null when the catalog does not know it. `read` and `set` default to the installed pi-pool. */
export function agentQueue(path: string, title: (sessionId: string) => string | null,
  read: () => Promise<AgentQueueReading> = readAgentQueue, set: typeof setPoolKey = setPoolKey): AgentQueue {
  const file: JsonFile<Remembered> = {
    path, label: "Agent queue settings", initial: () => ({ restoreMax: DEFAULT_MAC_WORKING_MAX }),
    parse: value => {
      const restoreMax = typeof value === "object" && value !== null ? (value as { restoreMax?: unknown }).restoreMax : null;
      return { restoreMax: typeof restoreMax === "number" && Number.isInteger(restoreMax) && restoreMax >= 1 ? restoreMax : DEFAULT_MAC_WORKING_MAX };
    },
  };
  const remembered = () => readJsonFile(file).catch(error => { if (missing(error)) return file.initial(); throw error; });
  const remember = (restoreMax: number) => transactJsonFile(file, state => { state.restoreMax = restoreMax; });

  async function view(): Promise<AgentQueueView> {
    const { restoreMax } = await remembered();
    try {
      const reading = await read();
      const next = reading.queued[0];
      return { state: "read", ...reading, restoreMax: reading.macWorkingMax ?? restoreMax, nextTitle: next ? title(next.session) : null };
    } catch (error) { return { state: "unread", error: error instanceof Error ? error.message : String(error), restoreMax }; }
  }

  async function apply(input: AgentQueueInput): Promise<AgentQueueView> {
    switch (input.action) {
      case "off": {
        const current = await read().then(reading => reading.macWorkingMax, () => null);
        if (current !== null) await remember(current);
        await set("mac_working_max", "off");
        break;
      }
      case "on": await set("mac_working_max", (await remembered()).restoreMax); break;
      case "mac": await set("mac_working_max", input.value); await remember(input.value); break;
      case "tree": await set("tree_working_max", input.value); break;
      default: { const never: never = input; throw new Error(`Unknown action ${String(never)}`); }
    }
    return view();
  }

  return { view, apply };
}
