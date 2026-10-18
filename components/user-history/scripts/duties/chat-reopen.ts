import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Chat reopen duty's precheck (chat-reopen.duty.json): it reads the newest verdict that `clean-room.ts reopen-check` left in --dir and
 * runs no chat itself. The duty job runs the check, and the server's after-job measure reads its verdict. Only a verdict written since the
 * newest run in LAST_RUNS_FILE started counts: a scheduled run reads the check of the run before it, and the after-job measure, whose runs
 * include its own, reads the check its job ran. A missing or older verdict, an open or void one, and a criterion not reached all read 0,
 * because an incomplete check is no pass. A run folder with a run.json and no verdict yet is a check still going: it reads 0 and is flagged
 * `pending` with its window's end, so the duty job waits for it and starts no second check.
 *
 *   OUTPUT_FILE=<file> node --import tsx scripts/duties/chat-reopen.ts [--dir <dir>]
 */
const KEYS = ["followup_answered", "tools_after_reopen", "chat_listed_after_reopen"] as const;
/**
 * How old the newest verdict may be: a daily slot comes 24 h after the last, its run may start up to CATCH_UP_MS (6 h) late
 * (src/chat-duty-run.ts), and the check itself has a 60 min window (clean-room.ts REOPEN_WINDOW_MIN).
 */
const MAX_AGE_H = 31;
const VERDICT = /^(\d{8}-\d{4})\.(pass|fail|open|void)\.md$/;

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1]! : join(homedir(), ".prime/agent/clean-room/chat-reopen");
const out = process.env.OUTPUT_FILE;
if (!out) { process.stderr.write("OUTPUT_FILE is not set\n"); process.exit(2); }
const lastRuns = process.env.LAST_RUNS_FILE && existsSync(process.env.LAST_RUNS_FILE)
  ? JSON.parse(readFileSync(process.env.LAST_RUNS_FILE, "utf8")) as { at?: number }[] : [];
const since = Math.max(0, ...lastRuns.map(run => run.at ?? 0));

const zero = Object.fromEntries(KEYS.map(key => [key, 0])) as Record<string, number>;
const flagged: FlaggedSlice[] = [];
const files = existsSync(dir) ? readdirSync(dir).filter(name => VERDICT.test(name)).sort() : [];
const newest = files.at(-1);
let metrics = zero;
const pending = existsSync(dir) ? readdirSync(dir).filter(name => /^\d{8}-\d{4}$/.test(name) && existsSync(join(dir, name, "run.json")) &&
  !files.some(file => file.startsWith(`${name}.`))).sort().at(-1) : undefined;
if (pending) {
  const until = (JSON.parse(readFileSync(join(dir, pending, "run.json"), "utf8")) as { until?: number }).until;
  flagged.push({ kind: "pending", excerpt: `the reopen check ${pending} is still going${until ? ` until ${new Date(until).toISOString()}` : ""}: ${join(dir, pending)}` });
}
if (!newest) flagged.push({ kind: "gap", excerpt: `no reopen check has run yet: no verdict file in ${dir}` });
else {
  const file = join(dir, newest);
  const [, stamp, verdict] = VERDICT.exec(newest)!;
  const at = Math.round(statSync(file).mtimeMs);
  const text = readFileSync(file, "utf8");
  const readings = /^Readings: (.+)$/m.exec(text)?.[1] ?? "";
  const read = Object.fromEntries(readings.split(", ").map(part => part.split(" ")).filter(([key, value]) => KEYS.includes(key as never) && /^[01]$/.test(value ?? ""))
    .map(([key, value]) => [key!, Number(value)]));
  if (at < since) flagged.push({ kind: "gap", at, excerpt: `no reopen check ran since the last run started at ${new Date(since).toISOString()}; the newest is ${newest}` });
  else if (verdict === "open" || verdict === "void") flagged.push({ kind: "incomplete", at, excerpt: `the reopen check ${stamp} ended ${verdict}: ${file}` });
  else if (Object.keys(read).length !== KEYS.length) flagged.push({ kind: "gap", at, excerpt: `${file} has no full Readings line` });
  else if (!pending || pending < stamp!) metrics = { ...zero, ...read };
  const chat = /^Chat ([0-9a-f-]{36}) /m.exec(text)?.[1];
  for (const line of text.split("\n").filter(line => /^- \w+: (not met|not reached yet): /.test(line))) {
    flagged.push({ kind: "criterion", at, ...chat ? { chat } : {}, excerpt: line.slice(2, 400) });
  }
  flagged.push({ kind: "verdict", at, ...chat ? { chat } : {}, excerpt: `${verdict}: ${file}; evidence in ${join(dir, `${stamp}.evidence`)}` });
  const cleanup = join(dir, `${stamp}.evidence`, "cleanup.md");
  const left = existsSync(cleanup) ? readFileSync(cleanup, "utf8").split("\n").filter(line => /still there|not archived|has [1-9]\d* todos|Teardown failed/.test(line)) : ["no cleanup.md"];
  for (const line of left) flagged.push({ kind: "cleanup", at, excerpt: `${stamp}: ${line.replace(/^- /, "")}` });
}
writeFileSync(out, JSON.stringify({ metrics, flagged } satisfies PrecheckOutput, null, 1));
process.stdout.write(`${JSON.stringify(metrics)}\n`);
