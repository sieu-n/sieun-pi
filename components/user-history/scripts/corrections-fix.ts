import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CorrectionLedger, correctionResult, parseCorrectionCall } from "../src/chat-corrections.ts";

/**
 * `node --import tsx scripts/corrections-fix.ts <id> [--enforced-by brief|code|test] [--ref <text>] [--status active|reopened|retired]
 * [--handoff-to <thread> --topics "<a>,<b>"] [--data-dir <dir>]`: updates one entry of <data dir>/corrections.json through the same path as
 * correction_add with an id. A fix that lands: `<id> --ref <sha> --status active`. Prints the tool's result line.
 */
export function fixArgs(argv: readonly string[]): { dataDir: string; call: Record<string, unknown> } {
  const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const id = argv[0];
  if (!id || id.startsWith("--")) throw new Error("usage: corrections-fix.ts <id> [--enforced-by ...] [--ref ...] [--status ...] [--handoff-to ... --topics ...]");
  const to = flag("--handoff-to");
  const call: Record<string, unknown> = { id };
  for (const [name, key] of [["--enforced-by", "enforcedBy"], ["--ref", "ref"], ["--status", "status"]] as const) {
    const value = flag(name);
    if (value !== undefined) call[key] = value;
  }
  if (to !== undefined) call.handoff = { to, topics: flag("--topics") ?? "" };
  const dir = flag("--data-dir");
  return { dataDir: dir ? resolve(dir) : join(homedir(), ".prime/agent/browser-chat"), call };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const { dataDir, call } = fixArgs(process.argv.slice(2));
  const outcome = await new CorrectionLedger(dataDir).apply(parseCorrectionCall(call), { id: "", name: "corrections-fix script" });
  process.stdout.write(`${correctionResult(outcome)} in ${join(dataDir, "corrections.json")}\n`);
}
