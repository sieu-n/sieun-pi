import { readPoolQueue, readSlotPark } from "./slot-park.ts";
import { daemonList, daemonSend, daemonSetModes, listRows, SESSION_MODES, type ModeValue, type SessionMode } from "./daemon-list.ts";

const USAGE = `usage: node src/daemon-cli.mjs <command>
  list [--all]               prints this box's daemon list as {"sessions": [...]}, like prime-agent list --json
  send <session> <message>   sends the message as prime-agent send --json does and prints the daemon's answer
  modes <mode>=<value> ...   sets steeringMode or followUpMode (all or one-at-a-time) on every loaded session and prints the counts
  slot-park <file> ...       prints {"parks": {<session id>: {since, place?, total?, resumeAt?, starting?} or null}} (src/slot-park.ts)
Each waits 30 s for the daemon's hello where prime-agent waits 3 s, and tries a failed hello again once (src/daemon-list.ts).`;

/** The Python scripts' reader of this box's daemon: resume_paused.py, idle-reaper and prime-sync call it instead of the prime-agent CLI. */
export async function runDaemonCommand(args: readonly string[]): Promise<void> {
  const [command, target, ...words] = args;
  if (command === "list" && args.slice(1).every(arg => arg === "--all")) {
    process.stdout.write(`${JSON.stringify({ sessions: listRows(await daemonList({ all: args.includes("--all") })) })}\n`);
  } else if (command === "send" && target && words.length) {
    process.stdout.write(`${JSON.stringify(await daemonSend(target, words.join(" ")))}\n`);
  } else if (command === "modes" && args.length > 1) {
    process.stdout.write(`${JSON.stringify(await daemonSetModes(parseModes(args.slice(1))))}\n`);
  } else if (command === "slot-park" && args.length > 1) {
    const now = Date.now();
    const pool = await readPoolQueue(now);
    const files = args.slice(1);
    const parks = await Promise.all(files.map(file => readSlotPark(file, now, pool)));
    process.stdout.write(`${JSON.stringify({ parks: Object.fromEntries(files.map((file, index) => [file.replace(/^.*\//, "").replace(/\.jsonl$/, ""), parks[index]])) })}\n`);
  } else throw new Error(USAGE);
}

/** `followUpMode=all`-style words as modes; any other word throws the usage. */
export function parseModes(words: readonly string[]): Partial<Record<SessionMode, ModeValue>> {
  return Object.fromEntries(words.map(word => {
    const [mode, value] = word.split("=");
    if (!mode || !(mode in SESSION_MODES) || (value !== "all" && value !== "one-at-a-time")) throw new Error(USAGE);
    return [mode, value];
  }));
}
