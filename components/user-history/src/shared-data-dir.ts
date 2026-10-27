import { resolve } from "node:path";

/**
 * The live chat's data dir, which a second chat and the pi-host that serves it read for the owner's corrections ledger and the Grafana viewer
 * token, and never write (AGENT_CHAT_SHARED_DIR). Unset, each chat reads its own data dir. The :5183 canary on pi-host had an empty ledger of its
 * own, so its sessions got no corrections block, and no grafana-alerts.json, so its footer read "err tok/s".
 */
export const sharedDataDir = (dataDir: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.AGENT_CHAT_SHARED_DIR ? resolve(env.AGENT_CHAT_SHARED_DIR) : dataDir;

/** Whether this chat reads another chat's ledger, which it may not change. */
export const sharedLedgerOnly = (dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  sharedDataDir(dataDir, env) !== resolve(dataDir);

/** correction_add's answer in a chat that reads another chat's ledger. */
export const SHARED_LEDGER_REFUSAL = "Not recorded: this chat runs on the pi-host canary, which reads the owner's corrections ledger and does not " +
  "write it, so only chats on the main chat (:5182) add to it. Apply the correction in this chat from now on.";
