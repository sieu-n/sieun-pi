import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Step owners duty's precheck: the open steps on one chat's board, sent to that chat as one server notice per run, the way the check-in hands
 * a chat its stuck steps while its job waits (chat-duty-run.ts handToChat). The notice text carries no server prefix; the chat service adds one
 * (`asServerNote`), so the turn it starts is not the owner's (c117). The c117 clean room notice-turns puts it on its test chat.
 *
 *   OUTPUT_FILE=<file> PRECHECK_MODE=run node --import tsx scripts/duties/step-owners.ts <chat id>
 */
type Step = { id?: string; text?: string; status?: string; children?: Step[] };
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const chat = process.argv[2];
const out = process.env.OUTPUT_FILE;
if (!chat || !out) { process.stderr.write("usage: OUTPUT_FILE=<file> step-owners.ts <chat id>\n"); process.exit(2); }

const board = ((): { plan?: Step[] } => { try { return JSON.parse(readFileSync(join(DATA, "boards", `${chat}.json`), "utf8")); } catch { return {}; } })();
const open: Step[] = [];
const walk = (steps: readonly Step[] = []): void => {
  for (const step of steps) {
    const children = step.children ?? [];
    if (!children.length && (step.status === "todo" || step.status === "doing")) open.push(step);
    walk(children);
  }
};
walk(board.plan);
const at = new Date().toISOString().slice(11, 16);
const plural = open.length === 1 ? "" : "s";
const text = [`The Step owners run of ${at}Z read ${open.length} open step${plural} on your board. Give each a live owner in this turn: ` +
  "steer its job, start one, link a For you todo, or close it on evidence.", ...open.map(step => `- ${step.id} "${(step.text ?? "").slice(0, 80)}"`)].join("\n");
const tells = open.length && process.env.PRECHECK_MODE === "run" ? [{ chat, text }] : [];
writeFileSync(out, JSON.stringify({ metrics: { open_steps: open.length }, tells }, null, 2) + "\n");
