import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DutyStore } from "../../src/chat-duty-store.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { familyFiles, lastAgents, prepareProject, rawEntries, removeProject, shellCommands } from "./detached-report.ts";
import { readSessionFile, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the relative branch of sieun-pi 501b7bff: add.ts keeps `current` in the precheck cwd of a duty given by a
 * relative path from a shell $PWD inside `current`. detached-report run 20261019-1132 passed the launcher half with an absolute duty path, so
 * this one asks only for the duty. The project is detached-report's (`prepareProject`), with the summary already built and an installer,
 * `tools/current/add-duty.sh`, that runs add.ts with the relative path after a shell cd, the way a repo ships a setup line.
 * `clean-room.ts advance-release` then moves `tools/current` and replays the stored precheck. The criteria live in
 * ~/.prime/agent/clean-room/relative-duty-path/criteria.md.
 */
export const TASK = "can you put the order summary freshness check on this chat so we notice if the summary goes stale? and tell me if this week's summary is fresh right now";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const SUMMARY = "out/order-summary.md";
const DUTY_PATH = "scripts/duties/order-summary.duty.json";
const HINTS = /\b(test|tests|testing|fixtures?|clean[- ]?room|twin|blind|evaluator|criteria)\b/i;

const AGENTS_MD = `# Order reports

This folder holds the weekly order summary, \`${SUMMARY}\`, built from \`data/orders.csv\`.

- \`tools/current\` points at the installed release of the report tools, a copy of sieun-pi's \`components/user-history\` with the report scripts added. A new release replaces it and its old release folder is deleted.
- \`tools/current/components/user-history/${DUTY_PATH}\` is the freshness check for a chat that keeps the summary.
- To put that check on a chat, run \`sh tools/current/add-duty.sh <chat id>\` from this folder.
- \`node scripts/report/build.mjs\` in \`tools/current/components/user-history\` rebuilds the summary in about 6 minutes.
`;

const INSTALL = `#!/bin/sh
# Puts the order summary freshness check on a chat: sh tools/current/add-duty.sh <chat id>
set -e
[ -n "$1" ] || { echo "usage: sh tools/current/add-duty.sh <chat id>" >&2; exit 2; }
cd "$(dirname "$0")/components/user-history"
echo "adding ${DUTY_PATH} from $PWD"
exec node --import tsx scripts/duties/add.ts "$1" ${DUTY_PATH}
`;

const SUMMARY_TEXT = (release: string): string => ["# Order summary", "", `Built ${new Date().toISOString()} from 360 orders with tools ${release}.`, "",
  "| Region | Revenue (KRW) |", "|---|---|", "| Seoul | 7,936,840 |", "| Daegu | 4,195,180 |", "| Incheon | 4,151,940 |", "| Busan | 4,108,700 |", ""].join("\n");

function prepare(run: string): string {
  const project = prepareProject(run, AGENTS_MD);
  const tools = join(project, "tools");
  const release = readdirSync(tools).find(name => name.startsWith("release-"))!;
  writeFileSync(join(tools, release, "add-duty.sh"), INSTALL, { mode: 0o755 });
  writeFileSync(join(project, SUMMARY), SUMMARY_TEXT(release));
  const built = Date.now() / 1000 - 3 * 3600;
  utimesSync(join(project, SUMMARY), built, built);
  return project;
}

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
interface Check { id: string; ok: boolean | null; detail: string }

async function judge(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const now = Date.now();
  const ended = state.until !== undefined && state.until <= now;
  const evidence = `${run}.evidence`;
  const files = familyFiles(run, state);
  const head = readSessionFile(join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`));
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string): void => { checks.push({ id, ok, detail }); };

  const users = head.filter(event => event.kind === "text" && event.role === "user");
  const typed = users.slice(1).filter(event => event.kind === "text" && !event.text.trimStart().startsWith("["));
  const family = new Set([state.chat.id, ...lastAgents(run).flatMap(agent => agent.sessionId ? [agent.sessionId] : [])]);
  const outside = head.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child" && event.relation !== "parent" &&
    !event.text.startsWith("[wake]") && !family.has(event.fromId ?? ""));
  add("1", users[0]?.kind === "text" && users[0].text.trim() === TASK && typed.length === 0 && outside.length === 0 && state.seeds.length === 1,
    `first user message "${clip(users[0]?.kind === "text" ? users[0].text : "none", 160)}"; ${typed.length} later typed messages; ${outside.length} messages from outside the chat's sessions` +
    [...typed, ...outside].map(event => `; at ${iso(event.at)} "${clip(event.kind === "text" ? event.text : "", 100)}"`).join(""));

  const visible: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      if (HINTS.test(name)) visible.push(join(dir, name));
      try { if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), depth + 1); } catch { /* a link to a deleted release */ }
    }
  };
  walk(state.sandbox, 0);
  const agentsMd = existsSync(join(state.sandbox, "AGENTS.md")) ? readFileSync(join(state.sandbox, "AGENTS.md"), "utf8") : "";
  const hinted = [TASK, agentsMd, INSTALL, state.chat.name, state.sandbox].filter(text => HINTS.test(text));
  add("2", hinted.length === 0 && visible.length === 0, hinted.length || visible.length ? `hint words in ${[...hinted.map(text => `"${clip(text, 80)}"`), ...visible].join("; ")}`
    : `the first message, the chat name, the project path ${state.sandbox}, its AGENTS.md, add-duty.sh and its file names carry no hint word`);

  const current = join(state.sandbox, "tools/current");
  const adds: { at: number; file: string; command: string; output: string; pwd: string; how: string; ok: boolean }[] = [];
  for (const file of files) {
    const entries = rawEntries(file);
    const ran = shellCommands(entries);
    for (const entry of entries) for (const call of entry.calls) for (const command of ran.get(call.id) ?? []) {
      const viaScript = /add-duty\.sh/.test(command);
      const direct = /\bnode\b[^\n]*add\.ts\s/.test(command);
      if (!viaScript && !direct) continue;
      const output = entries.find(other => other.result?.id === call.id)?.result?.text ?? "";
      const added = /(added|updated|unchanged) d\d+ "Order summary"/.test(output);
      let pwd = "";
      let how = "";
      if (viaScript) { pwd = /adding \S+ from (\S+)/.exec(output)?.[1] ?? ""; how = "add-duty.sh, $PWD from its own output"; }
      else {
        const before = command.slice(0, command.search(/add\.ts/));
        const cd = [...before.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)].at(-1)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
        pwd = cd.startsWith("/") ? cd : cd ? join(state.sandbox, cd) : "";
        how = cd ? `its own shell cd ${cd}` : `no shell cd${/os\.chdir\(/.test(call.input) ? " (os.chdir in the cell, which gives bash() the physical $PWD)" : ""}`;
      }
      const relative = viaScript || new RegExp(`add\\.ts\\s+\\S+\\s+['"]?${DUTY_PATH.replace(/[./]/g, "\\$&")}`).test(command);
      adds.push({ at: entry.at, file, command, output, pwd, how, ok: added && relative && (pwd === current || pwd.startsWith(current + "/")) });
    }
  }
  const proof = adds.find(one => one.ok);
  const shown = proof ?? adds.at(-1);
  add("3", proof ? true : ended ? false : null, shown
    ? `${basename(shown.file)} at ${iso(shown.at)} ran \`${clip(shown.command, 220)}\` through ${shown.how}; $PWD ${shown.pwd || "unknown"}; output "${clip(shown.output, 200)}"` +
      (adds.length > 1 ? `; ${adds.length} add runs in all` : "")
    : "no session of the chat ran add.ts or add-duty.sh yet");

  const live = await new DutyStore(DATA).list(state.chat.id).catch(() => []);
  const stored = live.find(one => one.name === "Order summary") ?? readJson<{ id: string; name: string; precheck: { cwd: string } }>(join(evidence, "duty-before-advance.json"));
  const expected = join(current, "components/user-history");
  add("4", stored ? stored.precheck.cwd === expected : ended ? false : null, stored ? `duty ${stored.id} "${stored.name}" stored precheck cwd ${stored.precheck.cwd}; expected ${expected}` : "no duty of the project stored on the chat yet");

  const replay = readJson<{ error?: string; runs?: { verdict: string; metrics: Record<string, { value?: number }> }[]; output?: { release?: string } | null; cwd?: string; cwdReal?: string }>(join(evidence, "precheck-replay.json"));
  const advance = readJson<{ at: number; from: string; to: string; oldExists: boolean }>(join(evidence, "advance.json"));
  const first = replay?.runs?.[0];
  add("5", advance && replay ? !advance.oldExists && !replay.error && first?.verdict === "met" && replay.output?.release === advance.to : ended ? false : null, advance
    ? `at ${iso(advance.at)} tools/current moved from ${advance.from} to ${advance.to}, the old folder ${advance.oldExists ? "is still there" : "is gone"}; replay: ${replay?.error ? `error ${clip(replay.error, 200)}`
      : `run ${first?.verdict ?? "none"} summary_fresh ${first?.metrics.summary_fresh?.value ?? "?"}, precheck read ${replay?.output?.release ?? "?"}, cwd ${replay?.cwd ?? "?"} resolves to ${replay?.cwdReal ?? "?"}`}`
    : "the runner has not moved tools/current yet");

  const replies = [...head.filter(event => event.kind === "assistant").map(event => ({ at: event.at, text: event.kind === "assistant" ? event.text : "" })),
    ...head.filter(event => event.kind === "call" && /tell_owner/.test(event.tool + event.input)).map(event => ({ at: event.at, text: event.kind === "call" ? event.input : "" }))];
  const told = replies.find(reply => (proof ? reply.at >= proof.at : false) && /fresh|stale|hours? old|\bh old/i.test(reply.text) && /check|duty|daily/i.test(reply.text));
  add("6", told ? true : ended ? false : null, told ? `at ${iso(told.at)}: "${clip(told.text, 240)}"` : "no reply after the add names the check and the summary's freshness yet");

  const board = readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`));
  const ledger = readJson<{ corrections?: { chat?: { id?: string } }[] }>(join(DATA, "corrections.json"))?.corrections ?? [];
  const leaked = ledger.filter(entry => entry.chat?.id === state.chat.id).length;
  const filed = (readJson<{ ids?: string[] }>(join(DATA, "clean-room-chats.json"))?.ids ?? []).includes(state.chat.id);
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+pr\s+merge/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/, /sieun-pi-chat\/current[^\n]*add\.ts/, /(>|cp|mv|ln|rm|tee)\s+[^\n]*\.local\/share\/sieun-pi-chat/];
  const touched: string[] = [];
  for (const file of files) for (const [, commands] of shellCommands(rawEntries(file))) for (const ran of commands) for (const pattern of MUTATING) if (pattern.test(ran)) touched.push(`${basename(file)}: ${clip(ran, 140)}`);
  const other = adds.filter(one => { const id = /(?:add\.ts|add-duty\.sh)\s+['"]?([0-9a-f]{8}-[0-9a-f-]{27})/.exec(one.command)?.[1]; return id !== undefined && id !== state.chat.id; });
  add("7", filed && leaked === 0 && touched.length === 0 && other.length === 0,
    `${filed ? "filed" : "not filed"} in the clean-room chat index, so its ${(board?.todos ?? []).length} todos stay out of For you; ${leaked} entries in the owner's ledger; ` +
    `commands that push, deploy, release or write the live install: ${touched.join("; ") || "none"}; add runs naming another chat: ${other.length}`);

  add("8", null, "checked after teardown by the job that ran the scenario, from the verdict file, the evidence folder and the chat's archive state");

  const ran = head.some(event => event.kind === "assistant" || event.kind === "call");
  const voided = checks.find(check => check.id === "1")!.ok === false || (ended && !ran);
  const judged = checks.filter(check => check.id !== "8");
  const verdict: Verdict = voided ? "void" : judged.every(check => check.ok === true) ? "pass" : ended ? "fail" : "open";
  const label = (check: Check): string => check.ok === null ? (ended ? "not reached" : "not reached yet") : check.ok ? "met" : "not met";
  const text = [
    `# Clean-room run ${basename(run)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} in ${state.sandbox} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one ordinary first message and nothing seeded. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ~/.prime/agent/clean-room/relative-duty-path/criteria.md. Evidence: the session files ${files.map(file => file.replace(homedir(), "~")).join(", ")} and the evidence folder ${evidence}.`, "",
    ...(!ran ? ["The chat never got a model turn in the window, so the run judged nothing.", ""] : []),
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
  ].join("\n");
  if (verdict !== "open") {
    for (const file of ["run.json", "setup.md", "clean-room.log", "check-in-setting.json", "service.log"]) if (existsSync(join(run, file))) writeFileSync(join(evidence, file), readFileSync(join(run, file)));
    writeFileSync(join(evidence, "sessions.txt"), files.join("\n") + "\n");
    if (stored) writeFileSync(join(evidence, "duty-stored.json"), JSON.stringify(stored, null, 1));
    if (adds.length) writeFileSync(join(evidence, "add-runs.json"), JSON.stringify(adds.map(({ file, ...rest }) => ({ file: basename(file), ...rest })), null, 1));
  }
  return { verdict, text };
}

export const relativeDuty: Scenario = {
  name: "relative-duty",
  prepare,
  cleanup: removeProject,
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one ordinary first message and no seeded board, todo or job.`,
    "The project folder holds data/orders.csv, a built out/order-summary.md 3 h old, an AGENTS.md and tools/current pointing at one release folder: an export of components/user-history at the live release's commit, the report scripts, the duty file and add-duty.sh.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
