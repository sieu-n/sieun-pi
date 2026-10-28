#!/usr/bin/env node
// Loads every extension Prime loads (each entry of <agent dir>/extensions) through the real prime-agent binary in a throwaway profile and
// checks that each one loads and registers the tools it owns. On 10-27 at 23:37Z 04b5dc19 made a module of user-history throw at import
// inside Prime's binary (argv[1] is "/$bunfs/root/prime-agent", which realpathSync refuses). Prime logs no error for an extension that fails
// to load, so chat_board, tell_owner and search_history were gone from every chat the chat service reloaded until 3284f484 at 00:30Z.
//
//   node scripts/check-extension-tools.mjs [--agent-dir <dir>] [--bin <prime-agent>] [--json]
//
// Each module loads through a wrapper (see `wrapper`) from an empty profile: PRIME_AGENT_CODING_AGENT_DIR and TMPDIR point into a temp folder, so the daemon the CLI starts there
// listens on its own socket and never sees the live daemon's workers. That daemon is stopped by pid at the end. Exit 1 names each failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The tools each extension entry must register, by its entry name in <agent dir>/extensions. An entry not named here must only load. */
export const OWNED_TOOLS = {
  "user-history": ["chat_board", "tell_owner", "search_history"],
};

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const agentDir = resolve(option("--agent-dir") ?? process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime/agent"));
const bin = option("--bin") ?? process.env.PRIME_AGENT_REAL_BIN ?? join(homedir(), ".local/share/prime-agent/bin/prime-agent");

/** The module file Prime loads for an entry: the entry itself, or a folder's package.json pi.extensions, else its index.ts. */
function entryModules(path) {
  if (!statSync(path).isDirectory()) return [path];
  const pkg = join(path, "package.json");
  const listed = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8"))?.pi?.extensions : undefined;
  if (Array.isArray(listed) && listed.length) return listed.map(file => resolve(path, file));
  return ["index.ts", "index.js"].map(file => join(path, file)).filter(existsSync).slice(0, 1);
}

const PROBE = `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", async () => {
    const tools = pi.getAllTools().map(tool => ({ name: tool.name, path: tool.sourceInfo?.path ?? null }));
    writeFileSync(process.env.EXTENSION_PROBE_OUT, JSON.stringify({ tools }));
  });
}
`;

/**
 * A wrapper Prime loads in place of one module of an entry: it imports the module through Prime's own loader (its aliases for the
 * prime-agent packages included), runs its factory, and only then records the module as loaded. Prime drops a module that throws with no log,
 * so a missing record is the load failure.
 */
const wrapper = (file, key) => `
import { appendFileSync } from "node:fs";
import * as loaded from ${JSON.stringify(file)};
export default async function (pi) {
  await loaded.default(pi);
  appendFileSync(process.env.EXTENSION_PROBE_LOADED, ${JSON.stringify(`${key}\n`)});
}
`;

const dir = mkdtempSync(join(tmpdir(), "ext-tools-"));
const profile = join(dir, "agent"), temp = join(dir, "tmp"), ws = join(dir, "ws"), out = join(dir, "probe.json");
for (const folder of [join(profile, "extensions"), temp, ws]) mkdirSync(folder, { recursive: true });
const entries = readdirSync(join(agentDir, "extensions")).sort();
const modules = {};
for (const name of entries) {
  const live = join(agentDir, "extensions", name);
  let target;
  try { target = realpathSync(live); } catch (error) { modules[name] = { error: `the entry does not resolve: ${error.message}` }; continue; }
  modules[name] = { target, files: entryModules(target), wrappers: [] };
  modules[name].files.forEach((file, index) => {
    const key = `${name}#${index}`, path = join(dir, "wrappers", `${name.replace(/[^\w.-]/g, "_")}.${index}.ts`);
    mkdirSync(join(dir, "wrappers"), { recursive: true });
    writeFileSync(path, wrapper(file, key));
    modules[name].wrappers.push({ key, file, path });
  });
}
writeFileSync(join(dir, "probe.mjs"), PROBE);
const loadedFile = join(dir, "loaded.txt");
writeFileSync(loadedFile, "");

const env = {
  ...process.env, PRIME_AGENT_CODING_AGENT_DIR: profile, TMPDIR: temp, EXTENSION_PROBE_OUT: out, EXTENSION_PROBE_LOADED: loadedFile,
};
for (const key of Object.keys(env)) if (key.startsWith("PRIME_AGENT_INTERNAL_")) delete env[key];

const socket = join(temp, `prime-agent-${process.getuid?.() ?? 0}`, "daemon.sock");
function stopProfileDaemon() {
  // Only processes whose command line names this run's own socket, which lives under the temp folder made above.
  const found = spawnSync("pgrep", ["-f", socket], { encoding: "utf8" });
  for (const pid of (found.stdout ?? "").split("\n").map(Number).filter(pid => pid > 0 && pid !== process.pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
}

const failures = [];
try {
  await new Promise((done, fail) => {
    const child = spawn(bin, ["--mode", "rpc", "--no-session", "--offline", "-e", join(dir, "probe.mjs"),
      ...Object.values(modules).flatMap(entry => (entry.wrappers ?? []).flatMap(item => ["-e", item.path]))], { cwd: ws, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.stdout.on("data", () => {});
    child.on("error", fail);
    child.on("exit", code => (existsSync(out) ? done() : fail(new Error(`prime-agent exited ${code} before session_start: ${stderr.slice(-2000)}`))));
    child.stdin.end(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
  });
  const { tools } = JSON.parse(readFileSync(out, "utf8"));
  const loaded = new Set(readFileSync(loadedFile, "utf8").split("\n").filter(Boolean));
  for (const [name, entry] of Object.entries(modules)) {
    if (entry.error) { failures.push(`${name}: ${entry.error}`); continue; }
    if (!entry.files.length) failures.push(`${name}: no module to load in ${entry.target}`);
    for (const item of entry.wrappers) if (!loaded.has(item.key)) failures.push(`${name}: prime-agent did not load ${item.file} (its import or its factory threw)`);
    const paths = new Set(entry.wrappers.map(item => item.path));
    const own = tools.filter(tool => paths.has(tool.path)).map(tool => tool.name);
    entry.tools = own;
    for (const tool of OWNED_TOOLS[name] ?? []) if (!own.includes(tool)) failures.push(`${name}: tool ${tool} did not register (it registered: ${own.join(", ") || "none"})`);
  }
  for (const name of Object.keys(OWNED_TOOLS)) if (!(name in modules)) failures.push(`${name}: not an entry of ${join(agentDir, "extensions")}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  stopProfileDaemon();
}
if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ agentDir, bin, modules, failures }, null, 2)}\n`);
else {
  for (const [name, entry] of Object.entries(modules)) console.log(`${name} -> ${entry.target ?? "?"}: tools ${entry.tools?.join(", ") || "none"}`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (!failures.length) console.log("Every extension loaded and registered its tools.");
}
rmSync(dir, { recursive: true, force: true });
process.exitCode = failures.length ? 1 : 0;
