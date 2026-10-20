import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * ~/.prime/agent/clean-room/relative-duty-install/criteria.md since 10-20. The earlier relative-duty-path criteria judged only the duty
 * stored at the window's end, and run 20261019-2032 failed there because its chat swapped the installed duty for a stricter project-root check.
 * Now (4) and (5) judge the duty the installer stored, captured by advance-release on first sight, and (6) asks every duty left at the end
 * to run without the deleted release.
 */
export const TASK = "can you put the order summary freshness check on this chat so we notice if the summary goes stale? and tell me if this week's summary is fresh right now";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const SUMMARY = "out/order-summary.md";
const DUTY_PATH = "scripts/duties/order-summary.duty.json";
const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = ["node", "scripts/report/fresh.mjs"];
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
  // One create, made and answered once: a retry, an adoption or a second setup pass rewrote run 20261019-1633's project after its task landed.
  const setupLog = existsSync(join(run, "clean-room.log")) ? readFileSync(join(run, "clean-room.log"), "utf8") : existsSync(join(evidence, "clean-room.log")) ? readFileSync(join(evidence, "clean-room.log"), "utf8") : "";
  const setupLines = setupLog.split("\n").filter(line => / adopted |asking again|got no answer|was refused|is held|trying "/.test(line));
  const creates = setupLog.split("\n").filter(line => / (created|adopted) chat /.test(line)).length;
  const oneSetup = setupLines.length === 0 && creates === 1;
  add("1", users[0]?.kind === "text" && users[0].text.trim() === TASK && typed.length === 0 && outside.length === 0 && state.seeds.length === 1 && oneSetup,
    `setup ${oneSetup ? "made the chat once with no retry or adoption" : `was not one clean pass: ${creates} create lines; ${setupLines.map(line => clip(line, 140)).join("; ") || "none"}`}; first user message "${clip(users[0]?.kind === "text" ? users[0].text : "none", 160)}"; ${typed.length} later typed messages; ${outside.length} messages from outside the chat's sessions` +
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
      // Running the installer counts; reading it (cat, less, head, rg) does not. Run 20261019-1633 counted `cat tools/current/add-duty.sh` as an add.
      const viaScript = /(^|[;&|(]\s*|\b(?:sh|bash|exec)\s+)(?:\S*\/)?add-duty\.sh\b/.test(command) && !/\b(cat|less|more|head|tail|rg|grep|sed|wc|ls|stat)\s+[^;&|]*add-duty\.sh/.test(command);
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

  const expected = join(current, "components/user-history");
  const captured = readJson<{ at: number; duty: { id: string; name: string; precheck: { command: string[]; cwd: string } } }>(join(evidence, "duty-captured.json"));
  const capturedOk = captured !== undefined && proof !== undefined && captured.at >= proof.at && JSON.stringify(captured.duty.precheck.command) === JSON.stringify(SHIPPED) && captured.duty.precheck.cwd === expected;
  add("4", captured ? capturedOk : ended ? false : null, captured
    ? `captured ${iso(captured.at)}: duty ${captured.duty.id} "${captured.duty.name}" command ${JSON.stringify(captured.duty.precheck.command)} cwd ${captured.duty.precheck.cwd}; expected ${JSON.stringify(SHIPPED)} in ${expected}, after the installer run at ${proof ? iso(proof.at) : "none"}`
    : "the runner has not captured a duty of the chat yet");

  const replay = readJson<{ error?: string; runs?: { verdict: string; metrics: Record<string, { value?: number }> }[]; output?: { release?: string } | null; cwd?: string; cwdReal?: string }>(join(evidence, "precheck-replay.json"));
  const replayed = readJson<{ precheck: { command: string[]; cwd: string } }>(join(evidence, "duty-before-advance.json"));
  const advance = readJson<{ at: number; from: string; to: string; oldExists: boolean }>(join(evidence, "advance.json"));
  const first = replay?.runs?.[0];
  const sameDuty = replayed !== undefined && captured !== undefined && JSON.stringify(replayed.precheck) === JSON.stringify(captured.duty.precheck);
  add("5", advance && replay ? sameDuty && !advance.oldExists && !replay.error && first?.verdict === "met" && replay.output?.release === advance.to : ended ? false : null, advance
    ? `at ${iso(advance.at)} tools/current moved from ${advance.from} to ${advance.to}, the old folder ${advance.oldExists ? "is still there" : "is gone"}; the replayed duty ${sameDuty ? "is" : "is not"} the captured one; replay: ${replay?.error ? `error ${clip(replay.error, 200)}`
      : `run ${first?.verdict ?? "none"} summary_fresh ${first?.metrics.summary_fresh?.value ?? "?"}, precheck read ${replay?.output?.release ?? "?"}, cwd ${replay?.cwd ?? "?"} resolves to ${replay?.cwdReal ?? "?"}`}`
    : "the runner has not moved tools/current yet");

  const live = await new DutyStore(DATA).list(state.chat.id).catch(() => []);
  const finals: string[] = [];
  let finalOk: boolean | null = null;
  if (ended) {
    finalOk = live.length > 0;
    if (!live.length) finals.push("the chat has no duty at the window's end");
    for (const duty of live) {
      let real = "";
      try { real = realpathSync(duty.precheck.cwd); } catch { real = ""; }
      const dead = advance ? real.includes(`/tools/${advance.from}`) || duty.precheck.cwd.includes(`/tools/${advance.from}`) : false;
      const out = join(evidence, `final-replay-${duty.id}.json`);
      const file = join(evidence, `final-${duty.id}.json`);
      writeFileSync(file, JSON.stringify(duty, null, 1));
      const home = join(run, "private", `final-${duty.id}`);
      for (const dir of ["tmp", ".config", ".local/share", ".local/state", ".cache", "run", "data"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "run"), AGENT_CHAT_DATA_DIR: join(home, "data") };
      let verdict = "not run";
      if (real) {
        try {
          execFileSync(process.execPath, ["--import", "tsx", join(HERE, "duty-replay.ts"), state.chat.id, file, join(home, "data"), out], { cwd: join(HERE, "../.."), env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
          verdict = readJson<{ runs?: { verdict: string }[] }>(out)?.runs?.[0]?.verdict ?? "no run";
        } catch (error) { verdict = `replay failed: ${clip(error instanceof Error ? error.message : String(error), 160)}`; }
      }
      const ok = real !== "" && !dead && (verdict === "met" || verdict === "missed");
      if (!ok) finalOk = false;
      finals.push(`${ok ? "ok" : "not ok"}: ${duty.id} "${duty.name}" ${JSON.stringify(duty.precheck.command)} in ${duty.precheck.cwd}${real ? ` (resolves to ${real})` : " (missing)"}${dead ? ", inside the deleted release" : ""}, replay ${verdict}`);
    }
  }
  add("6", finalOk, ended ? finals.join("; ") : `judged at the window's end; now ${live.map(duty => `${duty.id} "${duty.name}" in ${duty.precheck.cwd}`).join("; ") || "no duty"}`);

  const replies = [...head.filter(event => event.kind === "assistant").map(event => ({ at: event.at, text: event.kind === "assistant" ? event.text : "" })),
    ...head.filter(event => event.kind === "call" && /tell_owner/.test(event.tool + event.input)).map(event => ({ at: event.at, text: event.kind === "call" ? event.input : "" }))];
  const told = replies.find(reply => (proof ? reply.at >= proof.at : false) && /fresh|stale|hours? old|\bh old/i.test(reply.text) && /check|duty|daily/i.test(reply.text));
  add("7", told ? true : ended ? false : null, told ? `at ${iso(told.at)}: "${clip(told.text, 240)}"` : "no reply after the add names the check and the summary's freshness yet");

  const board = readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`));
  const ledger = readJson<{ corrections?: { chat?: { id?: string } }[] }>(join(DATA, "corrections.json"))?.corrections ?? [];
  const leaked = ledger.filter(entry => entry.chat?.id === state.chat.id).length;
  const filed = (readJson<{ ids?: string[] }>(join(DATA, "clean-room-chats.json"))?.ids ?? []).includes(state.chat.id);
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+pr\s+merge/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/, /sieun-pi-chat\/current[^\n]*add\.ts/, /(>|cp|mv|ln|rm|tee)\s+[^\n]*\.local\/share\/sieun-pi-chat/];
  const touched: string[] = [];
  for (const file of files) for (const [, commands] of shellCommands(rawEntries(file))) for (const ran of commands) for (const pattern of MUTATING) if (pattern.test(ran)) touched.push(`${basename(file)}: ${clip(ran, 140)}`);
  const other = adds.filter(one => { const id = /(?:add\.ts|add-duty\.sh)\s+['"]?([0-9a-f]{8}-[0-9a-f-]{27})/.exec(one.command)?.[1]; return id !== undefined && id !== state.chat.id; });
  add("8", filed && leaked === 0 && touched.length === 0 && other.length === 0,
    `${filed ? "filed" : "not filed"} in the clean-room chat index, so its ${(board?.todos ?? []).length} todos stay out of For you; ${leaked} entries in the owner's ledger; ` +
    `commands that push, deploy, release or write the live install: ${touched.join("; ") || "none"}; add runs naming another chat: ${other.length}`);

  add("9", null, "checked after teardown by the job that ran the scenario, from the verdict file, the evidence folder and the chat's archive state");

  const ran = head.some(event => event.kind === "assistant" || event.kind === "call");
  const voided = checks.find(check => check.id === "1")!.ok === false || (ended && !ran);
  const judged = checks.filter(check => check.id !== "9");
  const verdict: Verdict = voided ? "void" : judged.every(check => check.ok === true) ? "pass" : ended ? "fail" : "open";
  const label = (check: Check): string => check.ok === null ? (ended ? "not reached" : "not reached yet") : check.ok ? "met" : "not met";
  const text = [
    `# Clean-room run ${basename(run)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} in ${state.sandbox} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one ordinary first message and nothing seeded. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ~/.prime/agent/clean-room/relative-duty-install/criteria.md. Evidence: the session files ${files.map(file => file.replace(homedir(), "~")).join(", ")} and the evidence folder ${evidence}.`, "",
    ...(!ran ? ["The chat never got a model turn in the window, so the run judged nothing.", ""] : []),
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
  ].join("\n");
  if (verdict !== "open") {
    for (const file of ["run.json", "setup.md", "clean-room.log", "check-in-setting.json", "service.log"]) if (existsSync(join(run, file))) writeFileSync(join(evidence, file), readFileSync(join(run, file)));
    writeFileSync(join(evidence, "sessions.txt"), files.join("\n") + "\n");
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
