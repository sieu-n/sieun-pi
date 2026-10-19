import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DutyStore } from "../../src/chat-duty-store.ts";
import type { ChatAgent, ChatBoard } from "../../src/shared/types.ts";
import { readSessionFile, type RunState, type Scenario, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for two launcher fixes of 10-18: sieun-pi 7fdadbf, where a long command starts in its own systemd user unit so the
 * turn that started it ends, and 501b7bff, where add.ts keeps `current` in the precheck cwd of a duty given by a relative path from inside
 * `current`. A fresh chat gets one ordinary task in a small project folder outside the run folder: build an order summary with the project's
 * tools, which takes about 6 min, and add the project's shipped freshness duty. The tools sit in `tools/release-<id>` with `tools/current`
 * pointing at it, laid out like ~/.local/share/sieun-pi-chat, and hold an export of `components/user-history` at the live release's commit.
 * `advance-release` then points `tools/current` at a new release, deletes the old one and runs the stored precheck through `Duties` with a
 * private HOME, TMPDIR and XDG dirs. The criteria live in ~/.prime/agent/clean-room/detached-report-duty/criteria.md.
 */
export const TASK = "build this week's order summary here and tell me the top 3 regions by revenue. also add the summary freshness duty to this chat so it stays fresh";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const REPO = join(homedir(), "src/sieun-pi");
const LIVE = join(homedir(), ".local/share/sieun-pi-chat/current");
const SUMMARY = "out/order-summary.md";
const DUTY_FILE = "scripts/duties/order-summary.duty.json";
const HERE = dirname(fileURLToPath(import.meta.url));
const ORDERS = 360;
const REGIONS = ["Seoul", "Busan", "Incheon", "Daegu", "Daejeon", "Gwangju", "Ulsan", "Jeju"];
const HINTS = /\b(test|tests|testing|fixtures?|clean[- ]?room|twin|blind|evaluator|criteria)\b/i;

const AGENTS_MD = `# Order reports

This folder builds the weekly order summary from \`data/orders.csv\`.

- \`tools/current\` points at the installed release of the report tools, a copy of sieun-pi's \`components/user-history\` with the report scripts added. A new release replaces it and its old release folder is deleted.
- Run the tools from \`tools/current/components/user-history\`.
- \`node scripts/report/build.mjs\` builds \`${SUMMARY}\`. It reads every order, so a full build takes about 6 minutes.
- \`${DUTY_FILE}\` is the freshness duty for a chat that keeps the summary. Add it from the project folder with \`cd tools/current/components/user-history && node --import tsx scripts/duties/add.ts <chat id> ${DUTY_FILE}\`.
`;

const BUILD = `import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const release = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const project = join(release, "../..");
const rows = readFileSync(join(project, "data/orders.csv"), "utf8").trim().split("\\n").slice(1);
const totals = new Map();
for (const [index, row] of rows.entries()) {
  const [, , region, amount] = row.split(",");
  totals.set(region, (totals.get(region) ?? 0) + Number(amount));
  await new Promise(done => setTimeout(done, 1000));
  if ((index + 1) % 60 === 0) console.log(\`\${index + 1} of \${rows.length} orders read\`);
}
const ranked = [...totals].sort((a, b) => b[1] - a[1]);
const text = ["# Order summary", "", \`Built \${new Date().toISOString()} from \${rows.length} orders with tools \${readFileSync(join(release, "RELEASE"), "utf8").trim()}.\`, "",
  "| Region | Revenue (KRW) |", "|---|---|", ...ranked.map(([region, total]) => \`| \${region} | \${total.toLocaleString("en-US")} |\`), ""].join("\\n");
mkdirSync(join(project, "out"), { recursive: true });
writeFileSync(join(project, "out/.order-summary.md.next"), text);
renameSync(join(project, "out/.order-summary.md.next"), join(project, "${SUMMARY}"));
console.log(\`done: \${join(project, "${SUMMARY}")}\`);
`;

const FRESH = `import { readFileSync, statSync, writeFileSync } from "node:fs";

const release = readFileSync("../../RELEASE", "utf8").trim();
let ageHours = -1;
try { ageHours = (Date.now() - statSync("../../../../${SUMMARY}").mtimeMs) / 3_600_000; } catch {}
const fresh = ageHours >= 0 && ageHours <= 26 ? 1 : 0;
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { summary_fresh: fresh }, release, ageHours: Math.round(ageHours * 100) / 100 }));
`;

const DUTY = {
  name: "Order summary", ownerWords: "keep the weekly order summary fresh", goal: "The order summary in out/ is rebuilt at least once a day.",
  metrics: [{ key: "summary_fresh", label: "Order summary rebuilt in the last 26 h", op: ">=", target: 1, headline: true }],
  precheck: { command: ["node", "scripts/report/fresh.mjs"], cwd: "../..", timeoutMs: 30_000 },
  onMiss: "Rebuild the order summary with node scripts/report/build.mjs from tools/current/components/user-history, started detached, and read its output on a board wake.",
};

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };
const log = (run: string, line: string): void => { const text = `${new Date().toISOString()} ${line}\n`; appendFileSync(join(run, "clean-room.log"), text); process.stdout.write(text); };
const releaseId = (): string => randomBytes(4).toString("hex").slice(0, 7);
const evidenceDir = (run: string): string => `${run}.evidence`;

/** The commit of the live chat release, read from its `current` link; the project's tools are an export of it. */
function liveCommit(): string {
  const id = basename(readlinkSync(LIVE)).replace(/^release-/, "");
  return execFileSync("git", ["-C", REPO, "rev-parse", `${id}^{commit}`], { encoding: "utf8" }).trim();
}

export function writeRelease(tools: string, id: string, commit: string): void {
  const root = join(tools, `release-${id}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = ["package.json", "components/prime-relay", ...["src", "package.json", "tsconfig.json", "scripts/duties/add.ts"].map(path => `components/user-history/${path}`)];
  const tar = execFileSync("git", ["-C", REPO, "archive", commit, "--", ...paths], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", root], { input: tar });
  const tool = join(root, "components/user-history");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  symlinkSync(join(REPO, "components/user-history/node_modules"), join(tool, "node_modules"));
  mkdirSync(join(tool, "scripts/report"), { recursive: true });
  writeFileSync(join(tool, "scripts/report/build.mjs"), BUILD);
  writeFileSync(join(tool, "scripts/report/fresh.mjs"), FRESH);
  writeFileSync(join(tool, DUTY_FILE), JSON.stringify(DUTY, null, 2) + "\n");
  writeFileSync(join(root, "RELEASE"), `release-${id}\n`);
}

/** The project folder the chat works in, outside the run folder, so the chat sees no run file. Its name carries the run's time only. */
export function prepareProject(run: string, agentsMd: string = AGENTS_MD): string {
  const project = join(homedir(), "work", `order-reports-${basename(run)}`);
  if (existsSync(project)) throw new Error(`${project} already exists`);
  mkdirSync(join(project, "data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(project, "out"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), agentsMd);
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const lines = ["order_id,day,region,amount_krw"];
  for (let index = 0; index < ORDERS; index++) {
    const day = new Date(monday.getTime() + (index % 7) * 86_400_000).toISOString().slice(0, 10);
    lines.push(`A${String(10_000 + index)},${day},${REGIONS[(index * 7 + Math.floor(index / 9)) % REGIONS.length]},${12_000 + ((index * 7919) % 180_000)}`);
  }
  writeFileSync(join(project, "data/orders.csv"), lines.join("\n") + "\n");
  const tools = join(project, "tools");
  const id = releaseId();
  writeRelease(tools, id, liveCommit());
  symlinkSync(`release-${id}`, join(tools, "current"));
  return project;
}

export function removeProject(state: RunState): void {
  if (state.sandbox.startsWith(join(homedir(), "work", "order-reports-"))) rmSync(state.sandbox, { recursive: true, force: true });
}

/**
 * The release move a later release makes: waits for the chat's duty and the built summary, then points `tools/current` at a new release folder
 * with one rename, deletes the old folder, and runs the stored duty's precheck through `Duties` in a child with a private HOME, TMPDIR and XDG
 * dirs (duty-replay.ts). Each step's record goes to `<run>.evidence/`, which teardown keeps.
 */
export async function advanceRelease(run: string, until: number): Promise<void> {
  const state = readJson<RunState>(join(run, "run.json"))!;
  const tools = join(state.sandbox, "tools");
  const evidence = evidenceDir(run);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  let seenAt = 0;
  let duty: Awaited<ReturnType<DutyStore["list"]>>[number] | undefined;
  while (Date.now() < until) {
    duty = (await new DutyStore(DATA).list(state.chat.id).catch(() => [])).find(one => one.precheck.cwd.startsWith(state.sandbox) || one.name === DUTY.name);
    if (duty && !seenAt) { seenAt = Date.now(); log(run, `advance-release: the chat's duty ${duty.id} "${duty.name}" is stored with precheck cwd ${duty.precheck.cwd}`); }
    if (duty && (existsSync(join(state.sandbox, SUMMARY)) || Date.now() - seenAt > 15 * 60_000)) break;
    await new Promise(done => setTimeout(done, 15_000));
  }
  if (!duty) { log(run, "advance-release: the chat stored no duty of the project before the window ended"); return; }
  writeFileSync(join(evidence, "duty-before-advance.json"), JSON.stringify(duty, null, 1));
  const old = readlinkSync(join(tools, "current"));
  const id = releaseId();
  cpSync(join(tools, old), join(tools, `release-${id}`), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(tools, `release-${id}`, "RELEASE"), `release-${id}\n`);
  symlinkSync(`release-${id}`, join(tools, "current.next"));
  renameSync(join(tools, "current.next"), join(tools, "current"));
  rmSync(join(tools, old), { recursive: true, force: true });
  const moved = { at: Date.now(), from: old, to: `release-${id}`, oldExists: existsSync(join(tools, old)), current: readlinkSync(join(tools, "current")) };
  writeFileSync(join(evidence, "advance.json"), JSON.stringify(moved, null, 1));
  log(run, `advance-release: tools/current now points at release-${id}; deleted ${old}`);
  const home = join(run, "private", "home");
  for (const dir of ["tmp", ".config", ".local/share", ".local/state", ".cache", "run"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "run"), AGENT_CHAT_DATA_DIR: join(run, "private", "data") };
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(HERE, "duty-replay.ts"), state.chat.id, join(evidence, "duty-before-advance.json"), join(run, "private", "data"), join(evidence, "precheck-replay.json")],
      { cwd: join(HERE, "../.."), env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    log(run, `advance-release: replayed the stored precheck through Duties; ${join(evidence, "precheck-replay.json")}`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    writeFileSync(join(evidence, "precheck-replay.json"), JSON.stringify({ error: clip(text, 600) }, null, 1));
    log(run, `advance-release: the replay failed: ${clip(text, 300)}`);
  }
}

export interface Raw { at: number; type?: string; role?: string; stopReason?: string; customType?: string; text: string; calls: { id: string; name: string; input: string }[]; result?: { id: string; error: boolean; text: string } }
const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";
export function rawEntries(file: string): Raw[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    if (!line.trim()) return [];
    let entry: { type?: string; customType?: string; timestamp?: string; content?: unknown; message?: { role?: string; stopReason?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try { entry = JSON.parse(line); } catch { return []; }
    const message = entry.message ?? {};
    const calls = Array.isArray(message.content) ? (message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]).filter(block => block.type === "toolCall")
      .map(block => ({ id: String(block.id ?? ""), name: String(block.name ?? ""), input: JSON.stringify(block.arguments ?? {}) })) : [];
    const text = blockText(message.content ?? entry.content);
    return [{ at: Date.parse(entry.timestamp ?? "") || 0, ...(entry.type ? { type: entry.type } : {}), ...(entry.customType ? { customType: entry.customType } : {}),
      ...(message.role ? { role: message.role } : {}), ...(message.stopReason ? { stopReason: message.stopReason } : {}), text, calls,
      ...(message.role === "toolResult" ? { result: { id: String(message.toolCallId ?? ""), error: message.isError === true, text } } : {}) }];
  });
}

/** Undoes the escapes of a Python string literal's body; raw literals keep their backslashes. */
const unescapePy = (body: string, raw: boolean): string => raw ? body : body.replace(/\\(["'\\nt])/g, (_all, char: string) => char === "n" ? "\n" : char === "t" ? "\t" : char);
/** The Python string literal at `at` in `code` (any prefix of f, r, b, any quote), its body and where it ends; undefined when none starts there. */
function pyLiteral(code: string, at: number): { body: string; f: boolean; end: number } | undefined {
  const match = /^([rRfFbBuU]{0,2})("{3}|'{3}|"|')/.exec(code.slice(at));
  if (!match) return undefined;
  const quote = match[2]!;
  let index = at + match[0].length;
  let body = "";
  while (index < code.length) {
    if (code[index] === "\\") { body += code.slice(index, index + 2); index += 2; continue; }
    if (code.startsWith(quote, index)) return { body: unescapePy(body, /r/i.test(match[1]!)), f: /f/i.test(match[1]!), end: index + quote.length };
    if (quote.length === 1 && code[index] === "\n") return undefined;
    body += code[index++];
  }
  return undefined;
}
/** Fills `{name}` in an f-string from the string variables the session set so far; an unknown name stays as written. */
const fill = (text: string, names: ReadonlyMap<string, string>): string => text.replace(/\{([A-Za-z_]\w*)\}/g, (all, name: string) => names.get(name) ?? all);

/**
 * The shell commands a session ran, per tool call id: a `bash` tool call's command, and in an `ipython` call each `bash(...)` whose first
 * argument is a string literal or a variable set to one, with f-string names filled from the string variables of the session's earlier cells.
 * A brief or note that only names a command is text in a variable or a spawn call, so it never counts as run.
 */
export function shellCommands(entries: readonly Raw[]): Map<string, string[]> {
  const names = new Map<string, string>();
  const out = new Map<string, string[]>();
  for (const entry of entries) for (const call of entry.calls) {
    let args: { code?: unknown; command?: unknown };
    try { args = JSON.parse(call.input) as typeof args; } catch { continue; }
    if (call.name === "bash" && typeof args.command === "string") { out.set(call.id, [args.command]); continue; }
    if (call.name !== "ipython" || typeof args.code !== "string") continue;
    const code = args.code;
    const commands: string[] = [];
    for (let index = 0; index < code.length; index++) {
      const assign = /^([A-Za-z_]\w*)\s*=\s*/.exec(code.slice(index, index + 200));
      if (assign && (index === 0 || /[\n;]/.test(code[index - 1]!))) {
        const literal = pyLiteral(code, index + assign[0].length);
        if (literal) names.set(assign[1]!, literal.f ? fill(literal.body, names) : literal.body);
      }
      if (code[index] === "#") { const end = code.indexOf("\n", index); index = end < 0 ? code.length : end; continue; }
      if (/["']/.test(code[index]!) || (/[rRfFbBuU]/.test(code[index]!) && /^[rRfFbBuU]{1,2}["']/.test(code.slice(index, index + 3)) && (index === 0 || !/\w/.test(code[index - 1]!)))) {
        const literal = pyLiteral(code, index);
        if (literal) { index = literal.end - 1; continue; }
      }
      if (!code.startsWith("bash(", index) || (index > 0 && /[\w.]/.test(code[index - 1]!))) continue;
      const at = index + 5 + (/^\s*/.exec(code.slice(index + 5))?.[0].length ?? 0);
      const literal = pyLiteral(code, at);
      if (literal) commands.push(literal.f ? fill(literal.body, names) : literal.body);
      else { const name = /^([A-Za-z_]\w*)\s*[,)]/.exec(code.slice(at, at + 200))?.[1]; if (name && names.has(name)) commands.push(names.get(name)!); }
    }
    if (commands.length) out.set(call.id, commands);
  }
  return out;
}

export function lastAgents(run: string): ChatAgent[] {
  const dir = join(run, "agents");
  const last = existsSync(dir) ? readdirSync(dir).sort().at(-1) : undefined;
  return last ? readJson<ChatAgent[]>(join(dir, last)) ?? [] : [];
}
/** Every session file of the chat's tree: the chat, its subagents, and each root job its agents list names. */
export function familyFiles(run: string, state: RunState): string[] {
  const ids = new Set([state.chat.id, ...lastAgents(run).flatMap(agent => agent.sessionId ? [agent.sessionId] : [])]);
  return [...new Set([...ids].flatMap(id => sessionFiles(id)))];
}

interface Check { id: string; ok: boolean | null; detail: string }

async function judge(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const now = Date.now();
  const ended = state.until !== undefined && state.until <= now;
  const files = familyFiles(run, state);
  const head = readSessionFile(join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`));
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string): void => { checks.push({ id, ok, detail }); };

  const users = head.filter(event => event.kind === "text" && event.role === "user");
  const typed = users.slice(1).filter(event => event.kind === "text" && !event.text.trimStart().startsWith("["));
  const familyIds = new Set([state.chat.id, ...lastAgents(run).flatMap(agent => agent.sessionId ? [agent.sessionId] : [])]);
  const outside = head.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child" && event.relation !== "parent" &&
    !event.text.startsWith("[wake]") && !familyIds.has(event.fromId ?? ""));
  add("1", users[0]?.kind === "text" && users[0].text.trim() === TASK && typed.length === 0 && outside.length === 0 && state.seeds.length === 1,
    `first user message "${clip(users[0]?.kind === "text" ? users[0].text : "none", 160)}"; ${typed.length} later typed messages; ${outside.length} messages from outside the chat's sessions` +
    [...typed, ...outside].map(event => `; at ${iso(event.at)} "${clip(event.kind === "text" ? event.text : "", 100)}"`).join(""));

  const visible: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      if (HINTS.test(name)) visible.push(join(dir, name));
      const path = join(dir, name);
      try { if (statSync(path).isDirectory()) walk(path, depth + 1); } catch { /* a link to a deleted release */ }
    }
  };
  walk(state.sandbox, 0);
  const agentsMd = existsSync(join(state.sandbox, "AGENTS.md")) ? readFileSync(join(state.sandbox, "AGENTS.md"), "utf8") : "";
  const hinted = [TASK, agentsMd, state.chat.name, state.sandbox].filter(text => HINTS.test(text));
  add("2", hinted.length === 0 && visible.length === 0, hinted.length || visible.length ? `hint words in ${[...hinted.map(text => `"${clip(text, 80)}"`), ...visible].join("; ")}`
    : `the first message, the chat name, the project path ${state.sandbox}, its AGENTS.md and its file names carry no hint word`);

  const summaryFile = join(state.sandbox, SUMMARY);
  const builtAt = existsSync(summaryFile) ? statSync(summaryFile).mtimeMs : undefined;
  const builtText = existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "";
  type Start = { file: string; entries: Raw[]; callAt: number; resultAt: number; input: string; output: string; index: number };
  const starts: Start[] = [];
  const nohups: string[] = [];
  for (const file of files) {
    const entries = rawEntries(file);
    const ran = shellCommands(entries);
    entries.forEach((entry, index) => {
      for (const call of entry.calls) {
        for (const command of ran.get(call.id) ?? []) {
          if (!/build\.mjs/.test(command)) continue;
          if (/\bnohup\b|[^&>]&\s*$|[^&>]&\s*[;)]/.test(command)) nohups.push(`${basename(file)} at ${iso(entry.at)}: ${clip(command, 160)}`);
          if (!/systemd-run\s+--user/.test(command)) continue;
          const result = entries.find(other => other.result?.id === call.id);
          if (!/Running as unit/.test(result?.result?.text ?? "")) continue;
          starts.push({ file, entries, callAt: entry.at, resultAt: result?.at ?? 0, input: command, output: result?.result?.text ?? "", index });
        }
      }
    });
  }
  const start = starts.find(one => builtAt === undefined || one.callAt < builtAt) ?? starts[0];
  add("3", start ? (builtAt === undefined ? null : start.resultAt > 0 && start.resultAt < builtAt && nohups.length === 0) : ended || nohups.length ? false : null, start
    ? `${basename(start.file)} called systemd-run at ${iso(start.callAt)}, its result came back at ${start.resultAt ? iso(start.resultAt) : "never"} ("${clip(start.output, 160)}"); the summary was written ${builtAt ? iso(builtAt) : "not yet"}; call: ${clip(start.input, 260)}` +
      (nohups.length ? `; nohup or & starts: ${nohups.join("; ")}` : "")
    : `no session of the chat started build.mjs with systemd-run --user${nohups.length ? `; nohup or & starts: ${nohups.join("; ")}` : ""}`);

  let turnEnd: Raw | undefined;
  let wakeCall: { at: number; input: string } | undefined;
  if (start) {
    for (const entry of start.entries.slice(start.index)) {
      for (const call of entry.calls) if (/board\.wake\(|board wake/.test(call.input) && !wakeCall) wakeCall = { at: entry.at, input: call.input };
      if (entry.role === "assistant" && entry.stopReason === "stop") { turnEnd = entry; break; }
    }
  }
  add("4", start && turnEnd ? (builtAt === undefined ? null : turnEnd.at < builtAt && wakeCall !== undefined && wakeCall.at <= turnEnd.at) : start && ended ? false : null, start
    ? `the starter's turn ended ${turnEnd ? iso(turnEnd.at) : "not yet"}${turnEnd ? ` ("${clip(turnEnd.text, 140)}")` : ""}; board.wake ${wakeCall ? `at ${iso(wakeCall.at)}: ${clip(wakeCall.input, 200)}` : "not called in that turn"}; summary written ${builtAt ? iso(builtAt) : "not yet"}`
    : "no build start to read");

  let wakeTurn: Raw | undefined;
  let readCall: { at: number; input: string } | undefined;
  let foreign: Raw | undefined;
  if (start && turnEnd && builtAt !== undefined) {
    const after = start.entries.filter(entry => entry.at > turnEnd!.at);
    wakeTurn = after.find(entry => entry.at >= builtAt && (entry.text.startsWith("[wake]") || /\[wake\]/.test(entry.text.slice(0, 200))) && entry.role !== "assistant");
    // The chat's own check-in and job notes ("[check-in] ...", "[job] ...") are the system; anything else before the wake is someone stepping in.
    foreign = after.find(entry => entry.at < (wakeTurn?.at ?? Infinity) && (entry.role === "user" || entry.type === "custom_message") && !/\[wake\]/.test(entry.text.slice(0, 200)) &&
      !/^\[(check-in|job|harness-digest)\]/.test(entry.text) && !/^\[agent-message from [^\]]*(parent|child)/.test(entry.text));
    if (wakeTurn) for (const entry of after.filter(one => one.at >= wakeTurn!.at)) {
      const hit = entry.calls.find(call => /order-summary|systemctl\s+--user\s+status|journalctl|\.out\b|\.log\b/.test(call.input));
      if (hit) { readCall = { at: entry.at, input: hit.input }; break; }
    }
  }
  const replies = [
    ...head.filter(event => event.kind === "text" && event.role === "custom" && event.relation === "child").map(event => ({ at: event.at, text: event.kind === "text" ? event.text : "" })),
    ...head.filter(event => event.kind === "assistant").map(event => ({ at: event.at, text: event.kind === "assistant" ? event.text : "" })),
    ...head.filter(event => event.kind === "call" && event.tool === "tell_owner").map(event => ({ at: event.at, text: event.kind === "call" ? event.input : "" })),
    ...head.filter(event => event.kind === "call" && /tell_owner|agent_message/.test(event.input)).map(event => ({ at: event.at, text: event.kind === "call" ? event.input : "" })),
  ];
  const told = builtAt === undefined ? undefined
    : replies.find(reply => reply.at >= builtAt && REGIONS.filter(region => reply.text.includes(region)).length >= 3)?.text;
  add("5", wakeTurn && readCall && told ? true : ended || (wakeTurn && !readCall && foreign) ? false : null, start
    ? `wake turn ${wakeTurn ? `at ${iso(wakeTurn.at)}: "${clip(wakeTurn.text, 160)}"` : "not seen"}; read ${readCall ? `at ${iso(readCall.at)}: ${clip(readCall.input, 200)}` : "not seen"}; ` +
      `${foreign ? `a message before the wake: "${clip(foreign.text, 120)}"; ` : ""}the chat ${told ? `got "${clip(told, 200)}"` : "has no message with the regions yet"}`
    : "no build start to read");

  const live = await new DutyStore(DATA).list(state.chat.id).catch(() => []);
  const stored = live.find(one => one.name === DUTY.name) ?? readJson<{ precheck: { cwd: string } } & { id: string; name: string }>(join(evidenceDir(run), "duty-before-advance.json"));
  const addCalls: { at: number; input: string; output: string; chdir: boolean }[] = [];
  for (const file of files) {
    const entries = rawEntries(file);
    const ran = shellCommands(entries);
    for (const entry of entries) for (const call of entry.calls) for (const command of ran.get(call.id) ?? []) {
      if (!/\bnode\b[^\n]*add\.ts\s/.test(command)) continue;
      const result = entries.find(other => other.result?.id === call.id);
      addCalls.push({ at: entry.at, input: command, output: result?.result?.text ?? "", chdir: /os\.chdir\(/.test(call.input) });
    }
  }
  const good = addCalls.filter(call => /added|updated|unchanged/.test(call.output));
  const lastAdd = good.at(-1) ?? addCalls.at(-1);
  const command = lastAdd?.input ?? "";
  const relative = /add\.ts\s+\S+\s+['"]?scripts\/duties\/order-summary/.test(command);
  const shellCd = /\bcd\s+[^\n;&|]*tools\/current/.test(command.slice(0, Math.max(0, command.search(/add\.ts/))));
  const expected = join(state.sandbox, "tools/current/components/user-history");
  const cwd = stored?.precheck.cwd ?? "";
  // A relative path must keep tools/current (501b7bff); an absolute one is kept as given, so its cwd is a plain resolve of it under tools/.
  const cwdOk = relative ? cwd === expected : cwd.startsWith(join(state.sandbox, "tools") + "/") && !cwd.includes("..");
  const viaCurrent = /tools\/current/.test(command) || cwd.startsWith(join(state.sandbox, "tools/current"));
  add("6", stored && lastAdd ? viaCurrent && cwdOk : ended ? false : null, stored
    ? `duty ${stored.id} "${stored.name}" stored precheck cwd ${cwd}; ${relative ? `relative duty path given, from ${shellCd ? "a shell cd into tools/current" : `the kernel's working folder with no cd in the command${lastAdd?.chdir ? " (os.chdir in the same cell: a Prime kernel's os.chdir through a link gives bash() the physical $PWD, so add.ts cannot see current)" : ""}`}` : "absolute duty path given"}; add call at ${lastAdd ? iso(lastAdd.at) : "?"}: ${clip(lastAdd?.input ?? "none", 260)} -> "${clip(lastAdd?.output ?? "", 120)}"`
    : `no duty of the project stored on the chat; ${addCalls.length} add.ts calls on the duty file`);

  const replay = readJson<{ error?: string; runs?: { verdict: string; metrics: Record<string, { value?: number }>; summary?: string }[]; output?: { release?: string } | null; cwd?: string; cwdReal?: string }>(join(evidenceDir(run), "precheck-replay.json"));
  const advance = readJson<{ at: number; from: string; to: string; oldExists: boolean }>(join(evidenceDir(run), "advance.json"));
  const replayRun = replay?.runs?.[0];
  add("7", advance && replay ? !advance.oldExists && !replay.error && replayRun?.verdict === "met" && replay.output?.release === advance.to : ended ? false : null, advance
    ? `at ${iso(advance.at)} tools/current moved from ${advance.from} to ${advance.to}, the old folder ${advance.oldExists ? "is still there" : "is gone"}; replay: ${replay?.error ? `error ${clip(replay.error, 200)}`
      : `run ${replayRun?.verdict ?? "none"} summary_fresh ${replayRun?.metrics.summary_fresh?.value ?? "?"}, precheck read ${replay?.output?.release ?? "?"}, cwd ${replay?.cwd ?? "?"} resolves to ${replay?.cwdReal ?? "?"}`}`
    : "the runner has not moved tools/current yet");

  const board = readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`));
  const ledger = readJson<{ corrections?: { chat?: { id?: string } }[] }>(join(DATA, "corrections.json"))?.corrections ?? [];
  const leaked = ledger.filter(entry => entry.chat?.id === state.chat.id).length;
  const filed = (readJson<{ ids?: string[] }>(join(DATA, "clean-room-chats.json"))?.ids ?? []).includes(state.chat.id);
  const touched: string[] = [];
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+pr\s+merge/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/, /sieun-pi-chat\/current[^"]*add\.ts/, /(>|cp|mv|ln|rm|tee)\s+[^"]*\.local\/share\/sieun-pi-chat/];
  for (const file of files) { const entries = rawEntries(file); for (const [, commands] of shellCommands(entries)) for (const ran of commands) for (const pattern of MUTATING) if (pattern.test(ran)) touched.push(`${basename(file)}: ${clip(ran, 140)}`); }
  const otherChat = addCalls.filter(call => { const id = /add\.ts\s+([0-9a-f]{8}-[0-9a-f-]{27})/.exec(call.input)?.[1]; return id !== undefined && id !== state.chat.id; });
  add("8", filed && leaked === 0 && touched.length === 0 && otherChat.length === 0,
    `${filed ? "filed" : "not filed"} in the clean-room chat index, so its ${(board?.todos ?? []).length} todos stay out of For you; ${leaked} entries in the owner's ledger; ` +
    `commands that push, deploy, release or write the live install: ${touched.join("; ") || "none"}; add.ts calls naming another chat: ${otherChat.length}`);

  add("9", null, "checked after teardown by the job that ran the scenario, from the verdict file, the evidence folder and the chat's archive state");

  const ran = head.some(event => event.kind === "assistant" || event.kind === "call");
  const voided = checks.find(check => check.id === "1")!.ok === false || (ended && !ran);
  const judged = checks.filter(check => check.id !== "9");
  // Only the window's end turns an unmet line into a fail, so an evaluate in the middle of the run never tears it down early.
  const verdict: Verdict = voided ? "void" : judged.every(check => check.ok === true) ? "pass" : ended ? "fail" : "open";
  const label = (check: Check): string => check.ok === null ? (ended ? "not reached" : "not reached yet") : check.ok ? "met" : "not met";
  const text = [
    `# Clean-room run ${basename(run)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} in ${state.sandbox} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one ordinary first message and nothing seeded. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ~/.prime/agent/clean-room/detached-report-duty/criteria.md. Evidence: the session files ${files.map(file => file.replace(homedir(), "~")).join(", ")}, the evidence folder ${evidenceDir(run)} and the summary ${builtAt ? `written ${iso(builtAt)}` : "not written"}.`, "",
    ...(builtText ? ["The summary the build wrote:", "", ...builtText.split("\n").map(line => `> ${line}`), ""] : []),
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
  ].join("\n");
  if (verdict !== "open") {
    mkdirSync(evidenceDir(run), { recursive: true });
    for (const file of ["run.json", "setup.md", "clean-room.log", "check-in-setting.json", "service.log"]) if (existsSync(join(run, file))) writeFileSync(join(evidenceDir(run), file), readFileSync(join(run, file)));
    writeFileSync(join(evidenceDir(run), "sessions.txt"), files.join("\n") + "\n");
    if (builtText) writeFileSync(join(evidenceDir(run), "order-summary.md"), builtText);
    if (stored) writeFileSync(join(evidenceDir(run), "duty-stored.json"), JSON.stringify(stored, null, 1));
  }
  return { verdict, text };
}

export const detachedReport: Scenario = {
  name: "detached-report",
  prepare: prepareProject,
  cleanup: removeProject,
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one ordinary first message and no seeded board, todo or job.`,
    `The project folder holds data/orders.csv, an AGENTS.md and tools/current pointing at one release folder, an export of components/user-history at the live release's commit plus the report scripts and the duty file.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
