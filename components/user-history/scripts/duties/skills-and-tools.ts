import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Skills and tools duty's precheck (`node --import tsx scripts/duties/skills-and-tools.ts [--only id,id]`): whether every skill and tool agents
 * use on this Mac is installed, signed in and answers a real call. Each check runs a CLI with argv (no shell) or speaks raw MCP over stdio, all in
 * parallel with their own timeouts. No model call, nothing sent outside; the one paid call is a single Virev web search ($0.003 at most).
 * It fixes two things itself, because agents did both by hand on every run that hit them: it installs a newer stable cua-driver (cua_version) and
 * starts a stopped CuaDriver daemon (cua_permissions, cua_version).
 * The research behind each pass rule is in the auto-sns-agent session folder sessions/2026/10/10/1617-skills-and-tools-duty.
 * A `--only` run is the duty job's re-check after a fix; it is also appended to RECHECKS_FILE (RECHECKS_FILE env overrides the path).
 */

export type Group = "computer use" | "web search" | "browser" | "mcp" | "prime skills" | "accounts" | "peers" | "service clis" | "repo skills";
/** Who fixes a failure: the duty job itself, or the owner (a sign-in only he can do, a password, a key, a macOS grant, a paid install). */
export type Fixer = "agent" | "owner";
/** pass; fail with who fixes it; off = installed but not running on purpose (Paper Desktop closed), never a failure. */
export type Outcome = { status: "pass"; detail: string } | { status: "fail"; fixer: Fixer; detail: string; fix: string } | { status: "off"; detail: string };
/** `first` checks run before the rest, because they change what the others read (cua_version installs a new cua-driver and restarts its daemon). */
export interface Check { id: string; group: Group; tool: string; first?: true; run: (deps: Deps) => Promise<Outcome> }

export interface ExecResult { code: number; stdout: string; stderr: string; ms: number }
export interface ExecOptions { cwd?: string; env?: Record<string, string>; timeoutMs: number; input?: string }
export interface McpCall { name: string; arguments: Record<string, unknown> }
export interface McpResult { serverName?: string; tools: string[]; result?: unknown; error?: string }
export type Entry = { name: string; kind: "dir" | "file" | "missing" };
export type SkillResolver = (repo: string, id: string) => Promise<unknown>;
export interface Deps {
  /** Runs a program with argv and no shell. Never throws: ENOENT is code 127 with the message in stderr, a timeout is code 124. */
  exec: (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;
  mcp: (command: string, args: readonly string[], call: McpCall | undefined, timeoutMs: number) => Promise<McpResult>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string | Uint8Array) => Promise<void>;
  rm: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  realpath: (path: string) => Promise<string>;
  /** A folder's entries, symlinks followed; a dangling link is "missing". */
  list: (path: string) => Promise<Entry[]>;
  loadResolver: (repo: string) => Promise<SkillResolver>;
  home: string;
  repo: string;
  scratchDir: string;
  now: () => number;
  /** Waits between polls; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

/** The bare-metal box the repo skills reach as root: an ssh config alias (us-metal01 by default) or METAL_SSH_HOST, so no address lives in this repo. */
const METAL_HOST = process.env.METAL_SSH_HOST || "us-metal01";
const CHECK_TIMEOUT_MS = 90_000;
const MCP_TIMEOUT_MS = 20_000;
/** A fixed 4x4 red PNG for the attach-image check. */
const PNG_4X4 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mP4z8AARwzEcQCukw/xOF6MEQAAAABJRU5ErkJggg==";
const PASS = (detail: string): Outcome => ({ status: "pass", detail });
const FAIL = (fixer: Fixer, detail: string, fix: string): Outcome => ({ status: "fail", fixer, detail, fix });

const paths = (deps: Deps) => ({
  cua: join(deps.home, ".local/bin/cua-driver"),
  prime: join(deps.home, ".local/share/prime-agent/bin/prime-agent"),
  kernelPython: join(deps.home, ".prime/agent/kernel-venv/bin/python"),
  kernelEdit: join(deps.home, ".prime/agent/kernel-venv/bin/edit"),
  settings: join(deps.home, ".prime/agent/settings.json"),
  userSkills: join(deps.home, ".prime/agent/skills"),
  websearch: join(deps.home, ".prime/agent/skills/websearch"),
  pstack: join(deps.home, ".prime/agent/pstack-models.json"),
});
const brief = (text: string, max = 300) => text.replace(/\s+/g, " ").trim().slice(0, max);
const both = (result: ExecResult) => `${result.stdout}\n${result.stderr}`;
const failText = (result: ExecResult) => result.code === 124 ? `timed out after ${result.ms} ms` : `exit ${result.code}: ${brief(result.stderr || result.stdout, 200)}`;
const parseJson = (text: string): unknown => JSON.parse(text.slice(Math.min(...["{", "["].map(c => text.indexOf(c)).filter(i => i >= 0))));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface McpServer { command: string; args: string[]; disabledTools?: string[] }
async function mcpServer(deps: Deps, name: string): Promise<McpServer | string> {
  const settings = JSON.parse(await deps.readFile(paths(deps).settings)) as { mcpServers?: Record<string, McpServer> };
  const server = settings.mcpServers?.[name];
  return server?.command ? server : `${paths(deps).settings} has no mcpServers["${name}"] entry with a command`;
}
/**
 * Starts the CuaDriver daemon when it is down, the way `cua-driver permissions status` says to (`open -n -g -a CuaDriver --args serve`), and waits up
 * to 15 s for `cua-driver status` to say it runs. Measured 10-15 08:52Z: `cua-driver update --apply` leaves no daemon, so every computer use call
 * fails until something starts it again.
 */
async function ensureCuaDaemon(deps: Deps): Promise<boolean> {
  const running = async () => /daemon is running/.test((await deps.exec(paths(deps).cua, ["status"], { timeoutMs: 10_000 })).stdout);
  if (await running()) return true;
  await deps.exec("open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], { timeoutMs: 10_000 });
  for (let tries = 0; tries < 15; tries++) {
    if (await running()) return true;
    await (deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms))))(1000);
  }
  return false;
}

const missingServer = (name: string, why: string) => FAIL("agent", why, `re-add the ${name} server with \`prime-agent mcp add\` and the command from its vendor docs`);

/** First `---` block of a SKILL.md: top-level `key: value` pairs, with quoted, folded (`>`/`|`) and indented continuation values joined. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  if (!match) return fields;
  let key = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) { key = top[1]!; fields[key] = /^[>|][-+]?$/.test(top[2]!) ? "" : top[2]!.replace(/^(["'])([\s\S]*)\1$/, "$2"); }
    else if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return fields;
}

/** Every repo skill id from the folders: `.agents/skills/<a>/<b>[/...]` with a SKILL.md (depth 2 or more), plus flat `.claude/skills-native/<name>`. */
async function repoSkillIds(deps: Deps): Promise<string[]> {
  const ids: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await deps.list(join(deps.repo, ".agents/skills", rel));
    if (rel.split("/").length >= 2 && entries.some(entry => entry.name === "SKILL.md" && entry.kind === "file")) { ids.push(rel); return; }
    await Promise.all(entries.filter(entry => entry.kind === "dir" && !entry.name.startsWith(".")).map(entry => walk(rel ? `${rel}/${entry.name}` : entry.name)));
  };
  await walk("");
  for (const entry of await deps.list(join(deps.repo, ".claude/skills-native")))
    if (entry.kind === "dir" && await deps.exists(join(deps.repo, ".claude/skills-native", entry.name, "SKILL.md"))) ids.push(entry.name);
  return ids.sort();
}
async function skillMapIds(deps: Deps): Promise<string[]> {
  const map = await deps.readFile(join(deps.repo, ".agents/skills/repo/skill-creation/references/skill-map.md"));
  return [...map.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]!);
}
const setDiff = (a: Iterable<string>, b: Iterable<string>) => { const other = new Set(b); return [...new Set(a)].filter(item => !other.has(item)).sort(); };

async function pool(deps: Deps, provider: "anthropic" | "openai-codex"): Promise<Outcome> {
  const result = await deps.exec("pi-pool", ["ls", "--json", ...(provider === "anthropic" ? [] : ["--provider", provider])], { timeoutMs: 15_000 });
  if (result.code !== 0) return FAIL("agent", `pi-pool ls ${failText(result)}`, "reinstall pi-pool with components/pi-pool/install.py in sieun-pi");
  type Row = { email?: string; usable?: boolean; reason?: string | null; disabled?: boolean; limited_until?: number | null; cooldown_until?: number | null; windows?: { resets_at?: number | null }[] };
  const rows = (parseJson(result.stdout) as { rows?: Row[] }).rows ?? [];
  const live = rows.filter(row => row.disabled !== true);
  const reauth = live.filter(row => row.reason === "needs-reauth").map(row => row.email ?? "?");
  const usable = live.filter(row => row.usable).length;
  const nowSec = deps.now() / 1000;
  const soon = live.some(row => [row.limited_until, row.cooldown_until, ...(row.windows ?? []).map(window => window.resets_at)]
    .some(at => typeof at === "number" && at > nowSec && at - nowSec <= 86_400));
  const counts = `${usable} of ${live.length} usable, ${rows.length - live.length} off`;
  if (reauth.length) return FAIL("agent", `${reauth.join(", ")} need a new sign-in (${counts})`,
    `sign in again with \`pi-pool login <email> --provider ${provider}\` in the owner's Aside browser; a password or 2FA prompt makes it an owner item`);
  if (!usable && !soon) return FAIL("agent", `no ${provider} account is usable and none resets within 24 h (${counts})`, "read `pi-pool ls --json` and find why every account is stuck");
  return PASS(counts);
}

async function liveSessions(deps: Deps): Promise<number> {
  const result = await deps.exec(paths(deps).prime, ["list", "--json"], { timeoutMs: 15_000 });
  if (result.code !== 0) return 0;
  try {
    const sessions = (parseJson(result.stdout) as { sessions?: { activeSessionId?: string; isSessionActive?: boolean }[] }).sessions ?? [];
    return sessions.filter(session => session.activeSessionId && session.isSessionActive).length;
  } catch { return 0; }
}

async function cliLogin(deps: Deps, file: string, args: string[], ok: (result: ExecResult) => boolean, fix: string, cwd?: string): Promise<Outcome> {
  const result = await deps.exec(file, args, { ...(cwd ? { cwd } : {}), timeoutMs: 20_000 });
  return result.code === 0 && ok(result) ? PASS(brief(both(result), 120)) : FAIL("agent", `${file} ${args.join(" ")}: ${failText(result)}`, fix);
}

async function dotenvFiles(deps: Deps): Promise<string[]> {
  const pick = (entries: Entry[]) => entries.filter(entry => entry.kind === "file" && entry.name.startsWith(".env") && entry.name !== ".env.keys" && !entry.name.endsWith(".example")).map(entry => entry.name);
  const files = pick(await deps.list(deps.repo));
  for (const app of (await deps.list(join(deps.repo, "apps"))).filter(entry => entry.kind === "dir"))
    files.push(...pick(await deps.list(join(deps.repo, "apps", app.name))).map(name => `apps/${app.name}/${name}`));
  return files.sort();
}
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; out[index] = await fn(items[index]!); } }));
  return out;
}

export const CHECKS: readonly Check[] = [
  { id: "cua_permissions", group: "computer use", tool: "cua-driver", run: async deps => {
    const ask = async () => {
      const result = await deps.exec(paths(deps).cua, ["permissions", "status", "--json"], { timeoutMs: 10_000 });
      let status: { accessibility?: unknown; screen_recording?: unknown; daemon_running?: unknown } = {};
      try { status = parseJson(result.stdout) as typeof status; } catch { /* reported below */ }
      return { result, status };
    };
    let { result, status } = await ask();
    if (result.code === 127) return FAIL("agent", "cua-driver is not installed", "install it with `curl -fsSL https://cua.ai/driver/install.sh | bash`, then run `cua-driver permissions grant`");
    const started = status.daemon_running === false && await ensureCuaDaemon(deps);
    if (started) ({ result, status } = await ask());
    if (status.accessibility === true && status.screen_recording === true) return PASS(`accessibility and screen recording granted${started ? " (started the stopped daemon)" : ""}`);
    if (status.accessibility === false || status.screen_recording === false)
      return FAIL("owner", `accessibility ${status.accessibility}, screen recording ${status.screen_recording}`, "run `cua-driver permissions grant` and click the macOS dialogs");
    return FAIL("agent", `grant status unknown (${status.daemon_running === false ? "the daemon did not start within 15 s" : failText(result)})`,
      "start the daemon with `open -n -g -a CuaDriver --args serve`, read `cua-driver doctor`, and re-check");
  } },
  { id: "cua_mcp", group: "computer use", tool: "cua-driver MCP", run: async deps => {
    const server = await mcpServer(deps, "cua-driver");
    if (typeof server === "string") return missingServer("cua-driver", server);
    const answer = await deps.mcp(server.command, server.args ?? [], { name: "health_report", arguments: {} }, MCP_TIMEOUT_MS);
    if (answer.error) return FAIL("agent", `MCP ${answer.error}`, "start the daemon with `open -a CuaDriver` and re-check");
    const report = (answer.result as { structuredContent?: { overall?: string; checks?: { name?: string; status?: string; message?: string }[] } })?.structuredContent;
    const failing = (report?.checks ?? []).filter(check => check.status !== "pass" && check.status !== "skip");
    const stale = (server.disabledTools ?? []).filter(name => !answer.tools.includes(name));
    if (report?.overall !== "ok" || failing.length) {
      const tcc = failing.some(check => check.name?.startsWith("tcc_"));
      return FAIL(tcc ? "owner" : "agent", `health_report overall ${report?.overall ?? "missing"}: ${failing.map(check => `${check.name} ${check.status} (${brief(check.message ?? "", 80)})`).join("; ")}`,
        tcc ? "run `cua-driver permissions grant` and click the macOS dialogs" : "restart the daemon (`open -a CuaDriver`) and re-check");
    }
    if (stale.length) return FAIL("agent", `settings.json disabledTools names tools cua-driver no longer has: ${stale.join(", ")}`, "remove the stale names from mcpServers[\"cua-driver\"].disabledTools in ~/.prime/agent/settings.json");
    return PASS(`health ok, ${answer.tools.length} tools`);
  } },
  /**
   * A newer stable cua-driver is installed here, then the daemon restarts. Agents did this by hand on 10-14 (0.34.1 to 0.35.2) and 10-15 (0.35.2 to
   * 0.35.4, 8 s): the macOS grants stayed, and the only break was the daemon left stopped. Releases came every 1 to 2 days (0.31.0 on 10-10, 0.35.4 on 10-15).
   */
  { id: "cua_version", group: "computer use", tool: "cua-driver", first: true, run: async deps => {
    const result = await deps.exec(paths(deps).cua, ["check-update", "--json"], { timeoutMs: 15_000 });
    let info: { update_available?: boolean; error?: unknown; current_version?: string; latest_version?: string } = {};
    try { info = parseJson(result.stdout) as typeof info; } catch { return FAIL("agent", `check-update gave no JSON (${failText(result)})`, "run `cua-driver check-update --json` and read the error"); }
    if (info.error) return FAIL("agent", `check-update error: ${brief(String(info.error), 200)}`, "run `cua-driver check-update --json` and read the error");
    if (info.update_available === false) return PASS(`latest ${info.current_version}`);
    const from = `${info.current_version} to ${info.latest_version}`;
    const apply = await deps.exec(paths(deps).cua, ["update", "--apply"], { timeoutMs: 60_000 });
    if (apply.code !== 0) return FAIL("agent", `cua-driver update --apply from ${from}: ${failText(apply)}`, "run `cua-driver update --apply` and read the installer error");
    await deps.exec(paths(deps).cua, ["stop"], { timeoutMs: 10_000 });
    const version = (await deps.exec(paths(deps).cua, ["--version"], { timeoutMs: 10_000 })).stdout.trim();
    if (!await ensureCuaDaemon(deps)) return FAIL("agent", `updated ${from} but the daemon did not start within 15 s`, "run `open -n -g -a CuaDriver --args serve` and read `cua-driver doctor`");
    if (info.latest_version && !version.includes(info.latest_version)) return FAIL("agent", `update --apply exited 0 but the binary says "${brief(version, 60)}", not ${info.latest_version}`,
      "run `cua-driver update --apply` and read the installer output");
    return PASS(`updated ${from} and restarted the daemon`);
  } },
  { id: "websearch_kernel", group: "web search", tool: "websearch skill", run: async deps => {
    const python = paths(deps).kernelPython;
    const result = await deps.exec(python, ["-c", "import websearch,os;print(os.path.realpath(websearch.__file__))"], { timeoutMs: 15_000 });
    const own = `${await deps.realpath(paths(deps).websearch)}/`;
    const where = result.stdout.trim();
    if (result.code === 0 && where.startsWith(own)) return PASS(`kernel loads ${where}`);
    if (/ModuleNotFoundError/.test(result.stderr)) return FAIL("agent", "the kernel has no websearch module", `\`uv pip install --python ${python} -e ${paths(deps).websearch}\`, then re-check in a fresh kernel`);
    if (/prime-agent\/releases\//.test(where)) return FAIL("agent", `the kernel loads the bundled Serper copy ${where}, so \`await websearch(...)\` says it is not set up`,
      `\`uv pip uninstall --python ${python} prime-agent-skill-websearch\`, then re-check in a fresh kernel`);
    return FAIL("agent", `the kernel loads ${where || "nothing"} (${failText(result)})`, `make ${own} the only websearch install in the kernel venv`);
  } },
  { id: "websearch_query", group: "web search", tool: "Virev search API", run: async deps => {
    const skill = paths(deps).websearch;
    const code = `import asyncio,sys; sys.path.insert(0,${JSON.stringify(join(skill, "src"))}); from websearch import run; print(asyncio.run(run('Prime Intellect', num_results=3, timeout=40)))`;
    const result = await deps.exec(join(skill, ".venv/bin/python"), ["-c", code], { timeoutMs: 55_000 });
    const text = both(result);
    if (/no Virev API key|rejected the key \((401|403)|balance is empty \(402/.test(text))
      return FAIL("owner", brief(text.split("\n").find(line => /Virev/.test(line)) ?? text, 200), "put a working Virev API key in ~/.prime/agent/auth.json (virev) or top up its balance");
    const results = /^Result \d+: /m.test(result.stdout);
    if (results && /NOTE: google is unavailable/.test(text)) return FAIL("agent", "Google is down on the Virev search backend; results came from the DuckDuckGo fallback", "report it to the crawler side; the key works");
    if (results && result.code === 0) return PASS(brief(result.stdout.split("\n").find(line => line.startsWith("Result 1:")) ?? "", 100));
    return FAIL("agent", `no results: ${failText(result)}`, "check that api.virev.ai answers and the skill's .venv imports");
  } },
  { id: "aside_tabs", group: "browser", tool: "Aside browser MCP", run: async deps => {
    const server = await mcpServer(deps, "aside");
    if (typeof server === "string") return missingServer("aside", server);
    const answer = await deps.mcp(server.command, server.args ?? [], { name: "repl", arguments: { title: "Skills duty probe",
      code: "const sdTabs = await listBrowserTabs(); console.log(JSON.stringify({count: sdTabs.length}))" } }, MCP_TIMEOUT_MS);
    if (answer.error && /ENOENT/.test(answer.error)) return FAIL("owner", `the Aside CLI is missing: ${answer.error}`, "reinstall Aside");
    const result = answer.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
    const count = Number(/"count"\s*:\s*(\d+)/.exec(result?.content?.[0]?.text ?? "")?.[1] ?? NaN);
    if (!answer.error && result?.isError !== true && count >= 1) return PASS(`${count} tabs`);
    return FAIL("agent", answer.error ? `MCP ${answer.error}` : `repl gave ${brief(result?.content?.[0]?.text ?? "no text", 200)}`, "open Aside with `open -a Aside` and re-check");
  } },
  { id: "aside_account", group: "browser", tool: "Aside account", run: async deps => {
    const result = await deps.exec("aside", ["account", "status"], { timeoutMs: 10_000 });
    const line = /^\*\s+\S+\s+\S+@\S+\s+signed in.*$/m.exec(result.stdout);
    return line ? PASS(brief(line[0], 100)) : FAIL("owner", `aside account status: ${failText(result)}`, "sign in to the Aside account in the Aside app");
  } },
  { id: "paper_mcp", group: "mcp", tool: "Paper MCP", run: async deps => {
    const server = await mcpServer(deps, "paper");
    if (typeof server === "string") return missingServer("paper", server);
    const answer = await deps.mcp(server.command, server.args ?? [], { name: "list_resources", arguments: { limit: 1 } }, MCP_TIMEOUT_MS);
    if (answer.error || !answer.tools.length) return FAIL("agent", `MCP handshake: ${answer.error ?? "no tools"}`, "run `paper mcp` and read why the relay does not start");
    const result = answer.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
    const text = result?.content?.map(item => item.text ?? "").join(" ") ?? "";
    if (result?.isError && /isn't running/.test(text)) return { status: "off", detail: "Paper Desktop is closed; agents must not open it" };
    if (result?.isError) return FAIL("agent", `list_resources: ${brief(text, 200)}`, "open the Paper relay logs and find why the read call fails");
    return PASS(`${answer.tools.length} tools, desktop answers`);
  } },
  { id: "prime_daemon", group: "prime skills", tool: "Prime daemon (agent-message, agent-observe, goal, heartbeat, compact, mcp)", run: async deps => {
    const result = await deps.exec(paths(deps).prime, ["status", "--json"], { timeoutMs: 15_000 });
    let daemons: { isDefault?: boolean; status?: string; version?: string; pid?: number }[] = [];
    try { daemons = parseJson(result.stdout) as typeof daemons; } catch { /* reported below */ }
    const daemon = Array.isArray(daemons) ? daemons.find(entry => entry.isDefault) ?? (daemons.length === 1 ? daemons[0] : undefined) : undefined;
    if (daemon?.status === "stale" && daemon.pid) {
      const live = await liveSessions(deps);
      if (live > 0) return PASS(`daemon pid ${daemon.pid} serves ${live} live sessions; status said stale because a busy daemon misses the hello (prime-agent#1222)`);
    }
    if (daemon?.status !== "current") return FAIL("agent", `no current default daemon (${daemon ? `status ${daemon.status}` : failText(result)})`,
      "run `prime-agent doctor --json` (read-only) and report; never doctor --fix or shutdown");
    const release = basename(dirname(await deps.realpath(paths(deps).prime))).split("-")[0];
    if (release && daemon.version !== release) return FAIL("owner", `the daemon runs ${daemon.version} and the installed release is ${release}`, "restart Prime Agent when no work is running");
    return PASS(`daemon ${daemon.version} pid ${daemon.pid}`);
  } },
  { id: "edit_cli", group: "prime skills", tool: "edit skill", run: async deps => {
    const file = join(deps.scratchDir, `skills-duty-edit-${process.pid}.txt`);
    await deps.writeFile(file, "skills-duty probe ALPHA\n");
    try {
      const result = await deps.exec(paths(deps).kernelEdit, ["--path", file, "--old-str", "ALPHA", "--new-str", "BETA"], { timeoutMs: 15_000 });
      const after = (await deps.readFile(file)).trim();
      return result.code === 0 && after === "skills-duty probe BETA" ? PASS("edited a scratch file")
        : FAIL("agent", `edit ${failText(result)}; the file reads "${brief(after, 60)}"`, "start a fresh Prime session so the runtime reinstalls the kernel skills, then re-check");
    } finally { await deps.rm(file); }
  } },
  { id: "attach_image", group: "prime skills", tool: "attach-image skill", run: async deps => {
    const file = join(deps.scratchDir, `skills-duty-${process.pid}.png`);
    await deps.writeFile(file, Buffer.from(PNG_4X4, "base64"));
    try {
      const result = await deps.exec(paths(deps).kernelPython, ["-c", `from attach_image.attach_image import _validate_image as v; p,m,s,d=v(${JSON.stringify(file)}); print(m,s,d)`], { timeoutMs: 15_000 });
      return /^image\/png \d+ \(4, 4\)/.test(result.stdout) ? PASS(result.stdout.trim())
        : FAIL("agent", `image check: ${failText(result)}`, "start a fresh Prime session so the runtime reinstalls the kernel skills, then re-check");
    } finally { await deps.rm(file); }
  } },
  { id: "skill_files", group: "prime skills", tool: "Prime skill folders", run: async deps => {
    const releaseSkills = join(dirname(await deps.realpath(paths(deps).prime)), "skills");
    const problems: string[] = [];
    for (const root of [paths(deps).userSkills, releaseSkills]) {
      for (const entry of await deps.list(root)) {
        if (entry.name.startsWith(".") || entry.name === "skills" || entry.kind === "file") continue;
        const folder = join(root, entry.name);
        if (entry.kind === "missing") { problems.push(`${folder} is a dangling link`); continue; }
        const text = await deps.readFile(join(folder, "SKILL.md")).catch(() => undefined);
        if (text === undefined) { problems.push(`${folder} has no SKILL.md`); continue; }
        const fields = frontmatter(text);
        if (fields.name !== entry.name) problems.push(`${folder}: frontmatter name "${fields.name ?? ""}" is not the folder name`);
        if (!fields.description?.trim()) problems.push(`${folder}: empty description`);
      }
    }
    // `-path` turns a skill off and `!glob` hides a pattern, so either one naming a folder that is gone changes nothing today and keeps the owner's
    // choice if the folder comes back (10-15: nine `-` entries for poteto skills the pack had removed). Only a `+path` or plain path must exist.
    const settings = JSON.parse(await deps.readFile(paths(deps).settings)) as { skills?: string[] };
    const stale: string[] = [];
    let offForGone = 0;
    for (const raw of settings.skills ?? []) {
      if (raw.startsWith("!")) continue;
      const entry = raw.replace(/^[-+]/, "");
      const full = entry.startsWith("/") ? entry : entry.startsWith("~/") ? join(deps.home, entry.slice(2)) : join(releaseSkills, entry);
      if (await deps.exists(full)) continue;
      if (raw.startsWith("-")) offForGone++;
      else stale.push(raw);
    }
    if (stale.length) problems.push(`settings.json skills entries that load nothing: ${stale.join(", ")}`);
    return problems.length ? FAIL("agent", problems.join("; "), "fix the broken SKILL.md (commit in its repo) and delete the stale skills entries from ~/.prime/agent/settings.json")
      : PASS(`every skill folder and settings entry is valid${offForGone ? ` (${offForGone} off-switches name skills that are gone)` : ""}`);
  } },
  { id: "model_policy", group: "prime skills", tool: "pstack model policy", run: async deps => {
    const policy = JSON.parse(await deps.readFile(paths(deps).pstack)) as { roles?: Record<string, unknown>; policy?: { allowed?: string[] } };
    const selectors = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === "string") selectors.add(value);
      else if (Array.isArray(value)) value.forEach(add);
      else if (isRecord(value) && typeof value.model === "string") selectors.add(value.model);
    };
    Object.values(policy.roles ?? {}).forEach(add);
    (policy.policy?.allowed ?? []).filter(name => name !== "inherit-parent").forEach(add);
    const result = await deps.exec(paths(deps).prime, ["--offline", "model", "list"], { timeoutMs: 20_000 });
    if (result.code !== 0) return FAIL("agent", `model list ${failText(result)}`, "run `prime-agent --offline model list` and read the error");
    const listed = new Set(result.stdout.split("\n").slice(1).map(line => line.trim().split(/\s+/)).filter(cols => cols.length >= 2).map(([provider, model]) => `${provider}/${model}`));
    const missing = [...selectors].filter(selector => !listed.has(selector));
    return missing.length ? FAIL("agent", `pstack-models.json names models this Mac cannot reach: ${missing.join(", ")}`, "point those roles at a listed allowed model with the setup-pstack skill")
      : PASS(`${selectors.size} models listed`);
  } },
  { id: "pool_claude", group: "accounts", tool: "pi-pool Claude accounts", run: deps => pool(deps, "anthropic") },
  { id: "pool_codex", group: "accounts", tool: "pi-pool Codex accounts", run: deps => pool(deps, "openai-codex") },
  { id: "claude_cli", group: "peers", tool: "claude CLI", run: async deps => {
    const result = await deps.exec("claude", ["auth", "status"], { timeoutMs: 15_000 });
    let status: { loggedIn?: boolean; email?: string; subscriptionType?: string } = {};
    try { status = parseJson(result.stdout) as typeof status; } catch { /* reported below */ }
    return status.loggedIn === true ? PASS(`${status.email} ${status.subscriptionType}`)
      : FAIL("agent", `claude auth status: ${failText(result)}`, "sign in with `claude auth login` in the owner's Aside browser; a password prompt makes it an owner item");
  } },
  { id: "claude_peer", group: "peers", tool: "claude-in-codex helper", run: async deps => {
    const result = await deps.exec("uv", ["run", "--script", "scripts/claude-sdk-session.py", "--help"], { cwd: deps.repo, timeoutMs: 60_000 });
    return result.code === 0 && result.stdout.includes("usage: claude-sdk-session.py") ? PASS("--help starts")
      : FAIL("agent", `claude-sdk-session.py --help: ${failText(result)}`, "fix the script's inline dependency or the uv cache");
  } },
  { id: "codex_cli", group: "peers", tool: "codex CLI", run: deps => cliLogin(deps, "codex", ["login", "status"], result => both(result).includes("Logged in"),
    "sign in with the `codex login` device flow in the owner's Aside browser; a password prompt makes it an owner item") },
  { id: "gh_auth", group: "service clis", tool: "gh", run: deps => cliLogin(deps, "gh", ["auth", "status"], result => both(result).includes("Logged in to github.com"), "run `gh auth login --web` in the owner's Aside browser") },
  { id: "vercel_auth", group: "service clis", tool: "vercel", run: deps => cliLogin(deps, "vercel", ["whoami"], () => true, "run `vercel login` in the owner's Aside browser") },
  { id: "railway_auth", group: "service clis", tool: "railway", run: deps => cliLogin(deps, "railway", ["whoami"], result => both(result).includes("Logged in as"), "run `railway login --browserless` in the owner's Aside browser") },
  { id: "convex_auth", group: "service clis", tool: "convex", run: deps => cliLogin(deps, join(deps.repo, "node_modules/.bin/convex"), ["login", "status"],
    result => both(result).includes("Status: Logged in"), "run `npx convex login` in auto-sns-agent through the owner's Aside browser", deps.repo) },
  { id: "ssh_metal", group: "service clis", tool: "ssh us-metal01", run: async deps => {
    const result = await deps.exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", METAL_HOST, "true"], { timeoutMs: 15_000 });
    if (result.code === 0) return PASS(`${METAL_HOST} answers`);
    if (/Permission denied/.test(result.stderr)) return FAIL("owner", `ssh ${METAL_HOST}: ${brief(result.stderr, 200)}`, "put this Mac's ssh key on us-metal01");
    return FAIL("agent", `ssh ${METAL_HOST}: ${failText(result)}`, "check the network path to us-metal01");
  } },
  { id: "dotenvx_keys", group: "service clis", tool: "dotenvx keys", run: async deps => {
    const files = await dotenvFiles(deps);
    const counts = await mapLimit(files, 6, async file => {
      const result = await deps.exec("dotenvx", ["get", "-f", file], { cwd: deps.repo, timeoutMs: 20_000 });
      try {
        const values = parseJson(result.stdout);
        if (!isRecord(values)) throw new Error("not an object");
        return { file, encrypted: Object.values(values).filter(value => typeof value === "string" && value.startsWith("encrypted:")).length };
      } catch { return { file, error: result.code === 124 ? "timed out" : `exit ${result.code}, no JSON object` }; }
    });
    const locked = counts.filter(count => count.encrypted);
    const broken = counts.filter(count => count.error);
    if (locked.length) return FAIL("owner", `values still encrypted: ${locked.map(count => `${count.file} (${count.encrypted})`).join(", ")}`, "restore the matching .env.keys file; it is the only copy of the private key");
    if (broken.length) return FAIL("agent", `dotenvx get failed: ${broken.map(count => `${count.file} (${count.error})`).join(", ")}`, "run `dotenvx get -f <file>` in auto-sns-agent and read the error");
    return PASS(`${files.length} files decrypt`);
  } },
  { id: "skill_reader", group: "repo skills", tool: "read-skill.mjs", run: async deps => {
    const result = await deps.exec("node", ["scripts/skills/read-skill.mjs", "apps/llm-wiki"], { cwd: deps.repo, timeoutMs: 20_000 });
    const read = result.code === 0 && result.stdout.startsWith("---\nname: llm-wiki");
    if (read && !result.stderr.trim()) return PASS("read apps/llm-wiki and recorded the view");
    // The reader keeps the view in wiki.db when the llm-wiki server does not answer, so the skill read works and no view is lost (10-12 and 10-15 runs).
    // The wiki server being down is the Local dev servers duty's miss, not a skill fault.
    if (read && /recorded offline/.test(result.stderr)) return PASS(`read apps/llm-wiki; the view waits in wiki.db (${brief(result.stderr.replace(/^\[read-skill\]\s*/, ""), 120)})`);
    return FAIL("agent", `read-skill.mjs apps/llm-wiki: ${failText(result)}`, "fix the skill reader (a missing import usually needs `pnpm install`)");
  } },
  { id: "skill_ids", group: "repo skills", tool: "skill resolver", run: async deps => {
    const resolve = await deps.loadResolver(deps.repo);
    const links = (await deps.list(join(deps.repo, ".claude/skills"))).map(entry => entry.name).filter(name => name !== "README.md");
    const ids = [...links, ...await skillMapIds(deps)];
    const bad: string[] = [];
    for (const id of ids) await resolve(deps.repo, id).catch((error: unknown) => { bad.push(`${id} (${brief(error instanceof Error ? error.message : String(error), 80)})`); });
    return bad.length ? FAIL("agent", `ids that do not resolve: ${bad.join(", ")}`, "run scripts/skills/sync-claude-skills.sh and node scripts/skills/generate-skill-map.mjs, then commit")
      : PASS(`${ids.length} ids resolve`);
  } },
  { id: "claude_skill_links", group: "repo skills", tool: "sync-claude-skills.sh", run: async deps => {
    const result = await deps.exec("bash", ["scripts/skills/sync-claude-skills.sh", "--check"], { cwd: deps.repo, timeoutMs: 20_000 });
    if (result.code === 0) return PASS("links in sync");
    const lines = both(result).split("\n").filter(line => line.startsWith("FAIL"));
    return FAIL("agent", lines.length ? lines.join("; ") : failText(result), "run scripts/skills/sync-claude-skills.sh without --check and commit the links");
  } },
  { id: "claude_links_committed", group: "repo skills", tool: "git HEAD skill links", run: async deps => {
    const skills = await deps.exec("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".agents/skills", ".claude/skills-native"], { cwd: deps.repo, timeoutMs: 10_000 });
    const links = await deps.exec("git", ["ls-tree", "--name-only", "HEAD", "--", ".claude/skills/"], { cwd: deps.repo, timeoutMs: 10_000 });
    if (skills.code !== 0 || links.code !== 0) return FAIL("agent", `git ls-tree: ${failText(skills.code ? skills : links)}`, "run git ls-tree in auto-sns-agent and read the error");
    const expected = skills.stdout.split("\n").flatMap(line => {
      const repoSkill = /^\.agents\/skills\/(.+\/.+)\/SKILL\.md$/.exec(line)?.[1];
      if (repoSkill) return repoSkill === "workflows/common/claude-in-codex" ? [] : [repoSkill.replaceAll("/", "-")];
      return /^\.claude\/skills-native\/([^/]+)\/SKILL\.md$/.exec(line)?.slice(1, 2) ?? [];
    });
    const actual = links.stdout.split("\n").map(line => line.replace(/^\.claude\/skills\//, "").trim()).filter(name => name && name !== "README.md");
    const missing = setDiff(expected, actual);
    const extra = setDiff(actual, expected);
    return missing.length || extra.length ? FAIL("agent", [missing.length && `links missing from HEAD: ${missing.join(", ")}`, extra.length && `links in HEAD with no skill: ${extra.join(", ")}`].filter(Boolean).join("; "),
      "commit the link changes with `node scripts/repo/agent/commit.mjs` (check `node scripts/repo/agent/whose.mjs` first)") : PASS(`${actual.length} committed links match`);
  } },
  { id: "skill_map", group: "repo skills", tool: "skill-map.md", run: async deps => {
    const folders = await repoSkillIds(deps);
    const map = await skillMapIds(deps);
    const missing = setDiff(folders, map);
    const extra = setDiff(map, folders);
    return missing.length || extra.length ? FAIL("agent", [missing.length && `map lacks ${missing.join(", ")}`, extra.length && `map lists removed ${extra.join(", ")}`].filter(Boolean).join("; "),
      "run `node scripts/skills/generate-skill-map.mjs` and commit the map") : PASS(`${map.length} skills mapped`);
  } },
  { id: "skill_paths", group: "repo skills", tool: "check-skill-paths.mjs", run: async deps => {
    const result = await deps.exec("node", ["scripts/ci/check-skill-paths.mjs", "--json"], { cwd: deps.repo, timeoutMs: 20_000 });
    let dead: unknown;
    try { dead = parseJson(result.stdout); } catch { return FAIL("agent", `check-skill-paths: ${failText(result)}`, "run `node scripts/ci/check-skill-paths.mjs` and read the error"); }
    return Array.isArray(dead) && !dead.length ? PASS("no dead paths")
      : FAIL("agent", `dead paths in skills: ${brief(JSON.stringify(dead), 400)}`, "fix the skill text to name paths that exist");
  } },
];

export interface CheckResult { check: Check; outcome: Outcome; ms: number }

/** Runs the `first` checks in parallel, then the rest in parallel, in CHECKS order; a thrown error or a check past its cap is that check's agent failure, never the run's. */
export async function runChecks(deps: Deps, checks: readonly Check[] = CHECKS): Promise<CheckResult[]> {
  const firsts = await Promise.all(checks.filter(check => check.first).map(check => runOne(deps, check)));
  const rest = await Promise.all(checks.filter(check => !check.first).map(check => runOne(deps, check)));
  return checks.map(check => (check.first ? firsts : rest).find(result => result.check === check)!);
}

async function runOne(deps: Deps, check: Check): Promise<CheckResult> {
  const start = deps.now();
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the check ran past ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS); });
  const outcome = await Promise.race([check.run(deps), cap]).catch((error: unknown): Outcome =>
    FAIL("agent", error instanceof Error ? error.message : String(error), "find why the check itself broke")).finally(() => clearTimeout(timer));
  return { check, outcome, ms: deps.now() - start };
}

/** Where a `--only` re-check is recorded, in the chat's duties folder, so Settings can show that a daily run's failures were fixed. */
export const RECHECKS_FILE = "skills-and-tools.rechecks.jsonl";
/** One `--only` re-check: when it ran and each check's outcome. */
export interface Recheck { at: number; results: { id: string; status: Outcome["status"]; detail: string }[] }
export const recheckRecord = (results: readonly CheckResult[], at: number): Recheck =>
  ({ at, results: results.map(({ check, outcome }) => ({ id: check.id, status: outcome.status, detail: outcome.detail })) });

export function toOutput(results: readonly CheckResult[], at: number): PrecheckOutput {
  const failed = results.filter(result => result.outcome.status === "fail");
  const metrics = {
    checks_failed: failed.length,
    owner_fixes: failed.filter(result => result.outcome.status === "fail" && result.outcome.fixer === "owner").length,
    cua_failed: failed.filter(result => result.check.group === "computer use").length,
    websearch_failed: failed.filter(result => result.check.group === "web search").length,
    checks_run: results.length,
  };
  const flagged: FlaggedSlice[] = results.flatMap(({ check, outcome }): FlaggedSlice[] => {
    const name = `${check.id} (${check.tool})`;
    if (outcome.status === "fail") {
      const fix = `. Fix: ${outcome.fix}`.slice(0, 300);
      return [{ at, kind: `fail_${outcome.fixer}`, item: check.id, excerpt: `${`${name}: ${outcome.detail}`.slice(0, 600 - fix.length)}${fix}` }];
    }
    if (outcome.status === "off") return [{ at, kind: "off", item: check.id, excerpt: `${name}: ${outcome.detail}`.slice(0, 600) }];
    return [];
  });
  const passed = results.filter(result => result.outcome.status === "pass").map(result => `${result.check.id} ${result.ms}ms`);
  if (passed.length) flagged.push({ at, kind: "passed", excerpt: passed.join(", ") });
  return { metrics, flagged };
}

/**
 * PATH for every program the checks start: the :5182 server's own PATH is unknown, so it is set here. Kernel CLIs are called by absolute path.
 * tokenmaxxing comes first because ~/.local/bin/claude is the bare binary with no login; agents' shells reach claude through the tokenmaxxing wrapper.
 */
export function searchPath(home: string): string {
  const nvm = join(home, ".nvm/versions/node");
  const nodes = existsSync(nvm) ? readdirSync(nvm).map(version => join(nvm, version, "bin")) : [];
  return [join(home, ".config/tokenmaxxing/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", ...nodes, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

/** Kills the program's whole process group, so a wrapper's children die with it. */
const killGroup = (pid: number | undefined) => { try { if (pid) process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };

export function realExec(path: string): Deps["exec"] {
  return (file, args, options) => new Promise(resolve => {
    const start = Date.now();
    let stdout = "", stderr = "", done = false;
    const finish = (code: number) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - start }); };
    const child = spawn(file, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env, PATH: path }, detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { killGroup(child.pid); finish(124); }, options.timeoutMs);
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => { stderr += error.message; finish(error.code === "ENOENT" ? 127 : 1); });
    child.on("close", code => finish(code ?? 1));
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

/** Raw MCP over stdio: initialize, notifications/initialized, tools/list, then the optional tools/call, then stdin ends. Never throws. */
export function realMcp(path: string): Deps["mcp"] {
  return (command, args, call, timeoutMs) => new Promise(resolve => {
    const out: McpResult = { tools: [] };
    let done = false, buffer = "", nextId = 0;
    const waiting = new Map<number, (message: { result?: Record<string, unknown>; error?: { message?: string } }) => void>();
    const child = spawn(command, [...args], { env: { ...process.env, PATH: path }, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) out.error = error;
      child.stdin!.end();
      setTimeout(() => killGroup(child.pid), error ? 0 : 500).unref();
      resolve(out);
    };
    const timer = setTimeout(() => finish(`no answer within ${timeoutMs} ms`), timeoutMs);
    const send = (method: string, params: unknown) => new Promise<{ result?: Record<string, unknown>; error?: { message?: string } }>(answer => {
      const id = ++nextId;
      waiting.set(id, answer);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    child.stdin!.on("error", () => { /* the server exited; the exit handler reports it */ });
    child.on("error", error => finish(error.message));
    child.on("exit", code => finish(`the server exited with code ${code} before answering`));
    child.stdout!.on("data", chunk => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.id === "number") { waiting.get(message.id)?.(message); waiting.delete(message.id); }
      }
    });
    void (async () => {
      const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "skills-duty", version: "0" } });
      if (init.error) return finish(`initialize: ${init.error.message}`);
      const serverName = (init.result?.serverInfo as { name?: string } | undefined)?.name;
      if (serverName) out.serverName = serverName;
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await send("tools/list", {});
      if (list.error) return finish(`tools/list: ${list.error.message}`);
      out.tools = ((list.result?.tools ?? []) as { name: string }[]).map(tool => tool.name);
      if (call) {
        const answer = await send("tools/call", call);
        if (answer.error) return finish(`tools/call ${call.name}: ${answer.error.message}`);
        out.result = answer.result;
      }
      finish();
    })();
  });
}

export function realDeps(scratchDir: string): Deps {
  const home = homedir();
  const path = searchPath(home);
  return {
    exec: realExec(path),
    mcp: realMcp(path),
    readFile: file => readFile(file, "utf8"),
    writeFile: (file, text) => writeFile(file, text),
    rm: file => rm(file, { force: true }),
    exists: file => stat(file).then(() => true, () => false),
    realpath: file => realpath(file),
    list: async folder => Promise.all((await readdir(folder).catch(() => [] as string[])).map(async name => {
      const info = await stat(join(folder, name)).catch(() => undefined);
      return { name, kind: !info ? "missing" : info.isDirectory() ? "dir" : "file" } as Entry;
    })),
    loadResolver: async repo => ((await import(pathToFileURL(join(repo, "scripts/skills/skill-observability.mjs")).href)) as { resolveSkill: SkillResolver }).resolveSkill,
    home,
    repo: process.env.HARNESS_REPO || join(home, "Documents/Github/auto-sns-agent"),
    scratchDir,
    now: Date.now,
  };
}

async function main(): Promise<void> {
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt >= 0 ? new Set((process.argv[onlyAt + 1] ?? "").split(",").map(id => id.trim()).filter(Boolean)) : undefined;
  const unknown = only ? [...only].filter(id => !CHECKS.some(check => check.id === id)) : [];
  if (unknown.length) { process.stderr.write(`skills-and-tools: unknown check ids ${unknown.join(", ")}; known: ${CHECKS.map(check => check.id).join(", ")}\n`); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const deps = realDeps(stateFile ? dirname(stateFile) : tmpdir());
  const results = await runChecks(deps, only ? CHECKS.filter(check => only.has(check.id)) : CHECKS);
  const output = toOutput(results, deps.now());
  if (only) await appendFile(process.env.RECHECKS_FILE || join(deps.home, ".prime/agent/browser-chat/duties", RECHECKS_FILE), JSON.stringify(recheckRecord(results, deps.now())) + "\n", { mode: 0o600 });
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
