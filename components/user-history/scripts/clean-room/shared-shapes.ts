import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { familyFiles, lastAgents, rawEntries, shellCommands } from "./detached-report.ts";
import { readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c78, one shared page shape per 5180 app: a chat in a sparse throwaway copy of auto-sns-agent at the dev/sieun-mac
 * commit that added the three page shapes to the frontend-implementation skill gets the owner-style ask to add a Reports app to 5180 like
 * Inbox. It passes when the new app draws its frame with the shared `$lib/ui/AppFrame.svelte`, copies no lib/ui part, passes no width of its
 * own, puts no route under the `(analytics)` layout's centered column, and the chat's build brief names the shape and a shot beside Inbox. The
 * owner, 2026-10-27: "why is 5180 one broken? i said i want it to be like Inbox/Outreach template's sidebar?" and "make sure things that should
 * be shared are only written once and shared at the code level". The criteria live in ~/.prime/agent/clean-room/c78-shared-shapes/criteria.md.
 */
export const TASK = "add a Reports app to 5180 like Inbox. sidebar with saved reports (weekly brand check-in, campaign results, competitor posts) " +
  "and the report itself on the right";
/** The dev/sieun-mac commit with the shape paragraph and tests/unit/shape-width.test.ts, given to setup; the judge reads it from baseline.json. */
const baseOf = (runDir: string): string => (JSON.parse(readFileSync(join(runDir, "baseline.json"), "utf8")) as { base: string }).base;
const BRANCH = "dev/sieun";
const SCRATCH = join(homedir(), "scratch", "01a17e93-4acd-764d-8c37-22942272d029");
const PREFIX = join(SCRATCH, "auto-sns-agent-");
const REAL_CHECKOUT = join(homedir(), "Documents/Github/auto-sns-agent");
const PATHS = [".gitignore", "AGENTS.md", "CLAUDE.md", ".agents", ".claude", "scripts", "apps/virev-demo", "packages", "package.json", "pnpm-workspace.yaml", "tsconfig.json",
  "tsconfig.base.json", "apps/search/src/lib", "apps/crawler-v3/src/catalog/niches.json"];
const APP = "apps/virev-demo";
const SHARED = `${APP}/overlay/src/lib/ui/`;
const HINTS = /\b(test|tests|testing|fixtures?|clean[- ]?room|twin|blind|evaluator|criteria)\b/i;

const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=Sieun Park", "-c", "user.email=sieun@users.noreply.github.com", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
const tryGit = (cwd: string, args: string[]): string | null => { try { return git(cwd, args); } catch { return null; } };
export const originOf = (project: string): string => `${project}-origin.git`;

function prepare(runDir: string): string {
  const project = PREFIX + basename(runDir);
  const origin = originOf(project);
  if (existsSync(project) || existsSync(origin)) throw new Error(`${project} already exists`);
  const BASE = process.env.C78_CLEAN_ROOM_BASE ?? "";
  if (!/^[0-9a-f]{40}$/.test(BASE)) throw new Error(`C78_CLEAN_ROOM_BASE "${BASE}" is not a full sha`);
  const objects = join(REAL_CHECKOUT, ".git/objects");
  mkdirSync(SCRATCH, { recursive: true });
  git(SCRATCH, ["init", "-q", "--bare", "-b", BRANCH, origin]);
  writeFileSync(join(origin, "objects/info/alternates"), objects + "\n");
  git(origin, ["update-ref", `refs/heads/${BRANCH}`, BASE]);
  git(SCRATCH, ["init", "-q", "-b", BRANCH, project]);
  writeFileSync(join(project, ".git/objects/info/alternates"), objects + "\n");
  git(project, ["config", "agent.branch", BRANCH]);
  git(project, ["remote", "add", "origin", origin]);
  git(project, ["fetch", "-q", "origin"]);
  git(project, ["sparse-checkout", "set", "--no-cone", ...PATHS.map(path => `/${path}`)]);
  git(project, ["reset", "-q", "--hard", `origin/${BRANCH}`]);
  git(project, ["branch", "-q", "--set-upstream-to", `origin/${BRANCH}`]);
  symlinkSync(join(REAL_CHECKOUT, "node_modules"), join(project, "node_modules"));
  symlinkSync(join(REAL_CHECKOUT, APP, "node_modules"), join(project, APP, "node_modules"));
  for (const pkg of readdirSync(join(REAL_CHECKOUT, "packages"))) {
    const modules = join(REAL_CHECKOUT, "packages", pkg, "node_modules");
    if (existsSync(modules) && existsSync(join(project, "packages", pkg)) && !existsSync(join(project, "packages", pkg, "node_modules")))
      symlinkSync(modules, join(project, "packages", pkg, "node_modules"));
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "baseline.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, project }, null, 1) + "\n");
  return project;
}

function cleanup(state: RunState): string | void {
  if (!state.sandbox.startsWith(PREFIX)) return;
  rmSync(state.sandbox, { recursive: true, force: true });
  rmSync(originOf(state.sandbox), { recursive: true, force: true });
  return `removed the repo ${state.sandbox} and its origin ${originOf(state.sandbox)}`;
}

/** The demo's .svelte and variant.ts files the run added or changed against BASE, committed or not, with their text; materialized src/ is left out. */
export interface Changed { path: string; text: string }
function changedFiles(project: string, BASE: string): Changed[] {
  const paths = new Set<string>();
  for (const line of (tryGit(project, ["diff", "--name-only", BASE, "--", APP]) ?? "").split("\n")) if (line) paths.add(line);
  for (const line of (tryGit(project, ["ls-files", "--others", "--exclude-standard", "--", APP]) ?? "").split("\n")) if (line) paths.add(line);
  return [...paths].filter(path => /\.(svelte|ts)$/.test(path) && (path.startsWith(`${APP}/variants/`) || path.startsWith(`${APP}/overlay/`)) && existsSync(join(project, path)))
    .sort().map(path => ({ path, text: readFileSync(join(project, path), "utf8") }));
}
function sharedParts(project: string, BASE: string): Changed[] {
  const dir = join(project, SHARED);
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter(file => file.endsWith(".svelte"))
    .map(file => ({ path: SHARED + file.split("\\").join("/"), text: (tryGit(project, ["show", `${BASE}:${SHARED}${file}`]) ?? "") })).filter(part => part.text);
}

const uncommented = (source: string): string => source.replace(/<!--[\s\S]*?-->/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** The markup's word shingles with names and literals folded, as apps/virev-demo/tests/unit/shared-ui.test.ts reads a copy of a shared part. */
export function shingles(source: string): Set<string> {
  const words = uncommented(source).replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, " ").replace(/\{[^{}]*\}/g, " {} ")
    .split(/[^\w<>/={}-]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 6 <= words.length; i++) out.add(words.slice(i, i + 6).join(" "));
  return out;
}
export const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size) return 0;
  let n = 0;
  for (const s of a) if (b.has(s)) n++;
  return n / a.size;
};
/** Shape tags that pass their own width, as tests/unit/shape-width.test.ts reads them. */
export const sizedShapes = (source: string): string[] => [...uncommented(source).matchAll(/<(AppFrame|PageFrame|ListPage)\b((?:[^<>{}]|\{[^{}]*\})*)>/g)]
  .filter(m => /(?:^|\s)width\s*=/.test(m[2] ?? "")).map(m => m[1]!);
/** A sidebar column drawn by hand: an <aside>, or a fixed-width full-height element with a right border, outside lib/ui. */
export const handSidebar = (source: string): boolean => {
  const markup = uncommented(source).replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, " ");
  return /<aside\b/.test(markup) || [...markup.matchAll(/class="([^"]*)"/g)].some(m => /\bborder-r\b/.test(m[1]!) && /\bw-(?:\[\d+px\]|\d{2,})\b/.test(m[1]!) && /\bh-full\b|\bh-screen\b/.test(m[1]!));
};

interface Check { id: string; ok: boolean | null; detail: string }
export interface JudgeInput {
  changed: readonly Changed[];
  parts: readonly Changed[];
  commands: readonly string[];
  head: readonly SessionEvent[];
  family: ReadonlySet<string>;
  chatName: string;
  ended: boolean;
}
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const iso = (at: number): string => new Date(at).toISOString();
const ownCheckin = (text: string, name: string): boolean => text.startsWith(`[agent-message from check-in ${name} `) ||
  text.startsWith(`[agent-message from sibling:check-in ${name} `) || /^\[agent-message from [^\]]*\]\s*\[(?:relay|wake)\]/.test(text);
/** A command that writes, as opposed to reading the real checkout's node_modules through the copy's links: a git write, a file move, copy or delete, a redirect, sed -i or an install. On 10-27 run2 failed on a read-only ls of that node_modules. */
const WRITES_REAL = /\bgit\b[^|;&]*\b(?:commit|push|checkout|switch|reset|add|stash|clean|restore|rm|merge|rebase|cherry-pick|apply|worktree)\b|\b(?:rm|mv|cp|tee|touch|mkdir|ln)\s|\bsed\s+-i|>>?\s*\S|\b(?:pnpm|npm)\s+(?:i|install|add)\b/;
const SPAWN = /rlm\.(?:spawn|create_session)\s*\(/;

/** The verdict from the files the run changed, the family's shell commands and the head session; pure, so a unit test feeds it. */
export function verdictOf(input: JudgeInput): { verdict: Verdict; checks: Check[] } {
  const { changed, parts, commands, head, ended } = input;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string): void => { checks.push({ id, ok, detail }); };
  const views = changed.filter(file => file.path.endsWith(".svelte") && !file.path.startsWith(SHARED));
  const reports = views.filter(file => /report/i.test(file.path) || /\bReports?\b/.test(file.text));
  const reported = head.some(event => event.kind === "text" && event.customType === "agent_message" && event.relation === "child");
  const settled = reported || ended;

  add("1", reports.length ? true : settled ? false : null, `${changed.length} changed demo files; Reports views ${reports.map(file => file.path).join(", ") || "none"}`);

  const framed = views.filter(file => /\$lib\/ui\/AppFrame(?:\.svelte)?['"]/.test(file.text));
  add("2", framed.length ? true : settled && reports.length ? false : null, `views importing $lib/ui/AppFrame.svelte: ${framed.map(file => file.path).join(", ") || "none"}`);

  const sized = views.flatMap(file => sizedShapes(file.text).map(shape => `${file.path}: ${shape} width`));
  const hand = views.filter(file => handSidebar(file.text)).map(file => `${file.path}: a hand-drawn sidebar column`);
  const shared = parts.map(part => ({ part, name: basename(part.path), sh: shingles(part.text) }));
  const copies = views.flatMap(file => {
    const sh = shingles(file.text);
    return shared.filter(part => basename(file.path) === part.name || (sh.size >= 20 && Math.max(overlap(sh, part.sh), overlap(part.sh, sh)) >= 0.8))
      .map(part => `${file.path}: copies ${part.part.path}`);
  });
  const bad = [...sized, ...hand, ...copies];
  add("3", bad.length ? false : views.length && settled ? true : null, bad.length ? bad.join("; ") : `${views.length} new or changed views, none sized, hand-drawn or copied`);

  const centered = changed.filter(file => /\(analytics\)/.test(file.path) || (/variant\.ts$/.test(file.path) && /\(analytics\)\/report/i.test(file.text)));
  add("4", centered.length ? false : reports.length && settled ? true : null, centered.length ? `routes under (analytics): ${centered.map(file => file.path).join(", ")}` : "no route under (analytics)");

  const briefs = head.filter(event => event.kind === "call" && (SPAWN.test(event.input) || /Owner's words/.test(event.input))).map(event => event.kind === "call" ? event.input : "");
  const named = briefs.filter(brief => /AppFrame|page shape/i.test(brief) && /Inbox/.test(brief) && /\b(?:shot|screenshot)s?\b/i.test(brief));
  add("5", named.length ? true : briefs.length && settled ? false : null, briefs.length
    ? `${briefs.length} spawn briefs; ${named.length} name the shape (AppFrame or page shape) and a shot beside Inbox; first: "${clip(briefs[0]!.replace(/\\n/g, " "), 400)}"` : "no spawn brief yet");

  const outside = commands.filter(command => ((command.includes(REAL_CHECKOUT) || command.includes("~/Documents/Github/auto-sns-agent")) && WRITES_REAL.test(command)) ||
    /\bssh\s+(?:-\S+\s+)*mac\b/.test(command));
  add("6", outside.length === 0, `commands that write to the real checkouts or reach the Mac: ${outside.length ? outside.map(command => `"${clip(command, 140)}"`).join(", ") : "none"}`);

  const users = head.filter(event => event.kind === "text" && event.role === "user");
  const typed = users.slice(1).filter(event => event.kind === "text" && !event.text.trimStart().startsWith("[") && !event.text.startsWith("Prime Agent restarted after an update."));
  const outsiders = head.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child" && event.relation !== "parent" &&
    !event.text.startsWith("[wake]") && !ownCheckin(event.text, input.chatName) && !input.family.has(event.fromId ?? ""));
  const hinted = [TASK, input.chatName].filter(text => HINTS.test(text));
  const first = users[0]?.kind === "text" ? users[0].text : "none";
  add("7", first.trim() === TASK && typed.length === 0 && outsiders.length === 0 && hinted.length === 0,
    `first message "${clip(first, 120)}"; ${typed.length} later typed messages; ${outsiders.length} messages from outside the chat's sessions; ${hinted.length} texts with a hint word` +
    [...typed, ...outsiders].map(event => `; at ${iso(event.at)} "${clip(event.kind === "text" ? event.text : "", 100)}"`).join(""));

  const ran = head.some(event => event.kind === "assistant" || event.kind === "call");
  const verdict: Verdict = checks.find(check => check.id === "7")!.ok === false || (ended && !ran) ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.every(check => check.ok === true) ? "pass" : "open";
  return { verdict, checks };
}

/** The newest state a judge pass saved while the repo existed, for a judge after teardown. */
function lastState(runDir: string): { changed: Changed[]; parts: Changed[]; from: string } | undefined {
  const last = existsSync(runDir) ? readdirSync(runDir).filter(name => /^final-\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5))).at(-1) : undefined;
  if (!last) return undefined;
  return { ...(JSON.parse(readFileSync(join(runDir, last), "utf8")) as { changed: Changed[]; parts: Changed[] }), from: last };
}

async function judge(runDir: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const now = Date.now();
  const files = familyFiles(runDir, state);
  const head = readSessionFile(join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`));
  const base = baseOf(runDir);
  let changed: Changed[] = [];
  let parts: Changed[] = [];
  let from = "read live";
  if (existsSync(state.sandbox)) {
    changed = changedFiles(state.sandbox, base);
    parts = sharedParts(state.sandbox, base);
    writeFileSync(join(runDir, `final-${now}.json`), JSON.stringify({ at: iso(now), changed, parts }) + "\n");
  } else {
    const saved = lastState(runDir);
    if (saved) ({ changed, parts } = saved);
    from = saved ? `from ${saved.from}` : "the repo is gone";
  }
  const commands = files.flatMap(file => [...shellCommands(rawEntries(file)).values()].flat());
  const family = new Set([state.chat.id, ...lastAgents(runDir).flatMap(agent => agent.sessionId ? [agent.sessionId] : [])]);
  const { verdict, checks } = verdictOf({ changed, parts, commands, head, family, chatName: state.chat.name, ended: state.until !== undefined && state.until <= now });
  const label = (check: Check): string => check.ok === null ? "not reached yet" : check.ok ? "met" : "not met";
  const text = [
    `# Clean-room run ${basename(runDir)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} in ${state.sandbox} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one ordinary first message and nothing seeded. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ~/.prime/agent/clean-room/c78-shared-shapes/criteria.md. Evidence: the repo at ${base.slice(0, 12)} (${from}), and ${files.map(file => file.replace(homedir(), "~")).join(", ")}.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const sharedShapes: Scenario = {
  name: "shared-shapes",
  prepare,
  cleanup,
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one ordinary first message and no seeded board, todo or job.`,
    `The repo is a sparse copy of auto-sns-agent at ${process.env.C78_CLEAN_ROOM_BASE ?? "the C78_CLEAN_ROOM_BASE commit"} on ${BRANCH} (${PATHS.join(", ")}), with node_modules linked from ${REAL_CHECKOUT} and a bare origin ${originOf(state.sandbox)}.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (runDir, state) => judge(runDir, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
