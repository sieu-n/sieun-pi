import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The roots every clean-room judge reads its inputs under. Live, they are the owner's home, the chat service's data dir and the Prime dir.
 * `rejudge` sets CLEAN_ROOM_INPUT_ROOT to an unpacked run archive, and then every root sits under its home/ folder and AGENT_CHAT_DATA_DIR
 * does not count, so a judge of an archive reads the archive or nothing. On 10-25 rejudging carried-wait run-4 with an empty data dir turned
 * its pass into open, because the judge read the live service.log and pushes file beside the archived session files.
 */
export interface InputRoots { home: string; dataDir: string; primeDir: string }

export const INPUT_ROOT_ENV = "CLEAN_ROOM_INPUT_ROOT";

/** The roots of an archive unpacked at `root`; `rootsUnder(".")` gives the paths a run archive holds its inputs at. */
export function rootsUnder(root: string): InputRoots {
  const home = join(root, "home");
  return { home, primeDir: join(home, ".prime/agent"), dataDir: join(home, ".prime/agent/browser-chat") };
}

export function inputRoots(env: NodeJS.ProcessEnv = process.env): InputRoots {
  const root = env[INPUT_ROOT_ENV];
  if (root) return rootsUnder(root);
  const home = homedir();
  return { home, primeDir: join(home, ".prime/agent"), dataDir: env.AGENT_CHAT_DATA_DIR ?? join(home, ".prime/agent/browser-chat") };
}

export const serviceLogFile = (roots: InputRoots): string => join(roots.dataDir, "service.log");
/** The d9 pushes file the chat system duty writes (`PUSHES_FILE` in scripts/duties/chat-system.ts): one line per push, with its chat and tag. */
export const pushesFile = (roots: InputRoots): string => join(roots.home, "work/plan-audit/pushes.jsonl");
export const precheckDir = (roots: InputRoots, chat: string): string => join(roots.dataDir, "duties", chat);
