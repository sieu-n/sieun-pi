import { daemonList, daemonSend, listRows } from "./daemon-list.ts";

const USAGE = `usage: node src/daemon-cli.mjs <command>
  list [--all]               prints this box's daemon list as {"sessions": [...]}, like prime-agent list --json
  send <session> <message>   sends the message as prime-agent send --json does and prints the daemon's answer
Both wait 30 s for the daemon's hello where prime-agent waits 3 s, and try a failed hello again once (src/daemon-list.ts).`;

/** The Python scripts' reader of this box's daemon: resume_paused.py, idle-reaper and prime-sync call it instead of the prime-agent CLI. */
export async function runDaemonCommand(args: readonly string[]): Promise<void> {
  const [command, target, ...words] = args;
  if (command === "list" && args.slice(1).every(arg => arg === "--all")) {
    process.stdout.write(`${JSON.stringify({ sessions: listRows(await daemonList({ all: args.includes("--all") })) })}\n`);
  } else if (command === "send" && target && words.length) {
    process.stdout.write(`${JSON.stringify(await daemonSend(target, words.join(" ")))}\n`);
  } else throw new Error(USAGE);
}
