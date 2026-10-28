/**
 * The system prompt of a durable thread, built from the same sources and by the same code as a Prime chat's: Prime's own
 * `buildSystemPrompt` (prime-agent `core/system-prompt.js`), its resource loader for skills and AGENTS.md files, the legacy chat's
 * brief and poteto-mode line (`legacy/prime/user-history/src/chat-brief.ts`), its corrections block (`chat-corrections.ts`),
 * claude-rules' start-up rules (`packages/pi-claude-rules`) and Prime's harness digest formatter. Nothing here retypes Prime's text,
 * so the two cannot drift; `docs/prime-pi-prompt-parity.md` maps every part and its gaps.
 *
 * The parts render as pi-durable sections in Prime's order. pi-ai joins sections with a blank line, so `preamble` through `skills`
 * join to the exact string Prime's builder returns for the same inputs (`primeSystemPrompt`); `rules`, `harness` and `corrections`
 * follow them, where Prime sends the same texts as messages.
 */
import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineExtension, ROOT_CONVERSATION_ID, section, type Extension, type PromptInput } from "@earendil-works/pi-durable";
import { BRIEF_CORRECTIONS, CHAT_BRIEF, jobReplyGuideline, personaGuideline } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { jobLedgerPrompt, ledgerPrompt, parseLedger, type Ledger } from "../../../../legacy/prime/user-history/src/chat-corrections.ts";
import { SessionRules } from "../../../pi-claude-rules/src/core/rules.ts";

/**
 * Which tools Prime's builder is told the session has. It gates the REPL parts of Prime's text on `ipython`.
 * `prime`: a Prime browser chat's tools, so the text is byte for byte what a Prime chat gets, including the parts about the
 * `ipython` REPL, `rlm.*` and Python skills that a pi thread does not have (the doc lists them). `pi`: the tools a pi thread has
 * (`read`, `bash`, `edit`, `write`), so Prime's builder leaves the REPL parts out as it does for a Prime session without ipython.
 */
export type PromptTools = "prime" | "pi";
export const PROMPT_TOOLS_ENV = "PI_HOST_PROMPT_TOOLS";
const TOOLS: Record<PromptTools, { root: string[]; child: string[] }> = {
  // A browser chat's active tools (a capture's `tools`), and a chat job's: Prime's builder reads only ipython, bash and edit of them.
  prime: { root: ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"], child: ["ipython", "job_reply", "poteto_mode"] },
  pi: { root: ["read", "bash", "edit", "write"], child: ["read", "bash", "edit", "write"] },
};

/** Section keys in the order they render. `preamble` stays first and keeps its old key, so a thread from before keeps its order. */
export const PRIME_SECTIONS = ["preamble", "delegation", "mcp", "guidance", "context", "skills"] as const;
export const EXTRA_SECTIONS = ["rules", "harness", "corrections"] as const;
export type PromptKey = (typeof PRIME_SECTIONS)[number] | (typeof EXTRA_SECTIONS)[number];
/**
 * Sections that keep the text a conversation first got, as Prime pins them: the chat brief (`pinnedBrief`), the corrections block and the
 * harness digest go in once per context. The others follow their files at each request.
 */
export const PINNED_SECTIONS: ReadonlySet<PromptKey> = new Set(["guidance", "harness", "corrections"]);

export interface PromptPart { key: PromptKey; text: string; source: string }

export interface PrimePromptInput {
  agentDir: string;
  cwd: string;
  /** Prime's "Conversation log:" line: the session file, here the thread's SQLite file. */
  messagesPath?: string;
  /** 0 for a thread's root conversation (a chat), 1 for a subagent's child conversation (a chat's job). */
  depth: number;
  /** The chat's name: a child's "spawned by" line and its job_reply guideline. */
  parentName?: string;
  /** The session a child's job_reply guideline names for its scratch folder. */
  session?: string;
  tools?: PromptTools;
  /** Prime's bundled skills folder; default `bundledSkillsDir()`. */
  bundledSkillsDir?: string;
  /** The chat brief bullets; default the legacy chat's CHAT_BRIEF. */
  brief?: readonly string[];
  /** The folder of the corrections ledger (`corrections.json`); default `chatDataDir(agentDir)`. */
  ledgerDir?: string;
  /** Leave out the parts Prime sends as messages: claude-rules, the harness digest and the corrections block. */
  primeOnly?: boolean;
  /** Extra parts not to build, such as pinned ones a conversation already shows. */
  skip?: ReadonlySet<PromptKey>;
  /** The conversation's newest user text, which ranks the harness digest's entries by relevance as Prime's first digest does. */
  query?: string;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Prime's own code, from the prime-agent package this repo installs. Its `exports` names only the index, which lacks
// buildSystemPrompt and the harness formatter, so the modules are loaded by their path next to the index.

interface Skill { name: string; filePath: string; disableModelInvocation?: boolean }
interface ContextFile { path: string; content: string }
interface PrimeModules {
  buildSystemPrompt(options: Record<string, unknown>): string;
  formatSkillsForPrompt(skills: Skill[]): string;
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void>; getSkills(): { skills: Skill[] }; getAgentsFiles(): { agentsFiles: ContextFile[] } };
  loadHarnessState(dir: string, scope: string): unknown;
  formatHarnessStateForPrompt(state: unknown, options: Record<string, unknown>): string;
  harnessQueryTerms(text: string): Iterable<string>;
  HARNESS_DIGEST_PREFIX: string;
  HARNESS_DIGEST_SUFFIX: string;
}
let modules: Promise<PrimeModules> | undefined;
export function primeModules(): Promise<PrimeModules> {
  modules ??= (async () => {
    const index = import.meta.resolve("prime-agent");
    const load = (path: string) => import(new URL(path, index).href) as Promise<Record<string, unknown>>;
    const [prompt, loader, skills, refinement, messages] = await Promise.all([load("./core/system-prompt.js"), load("./core/resource-loader.js"),
      load("./core/skills.js"), load("./core/refinement/index.js"), load("./core/messages.js")]);
    return { ...prompt, ...loader, ...skills, ...refinement, ...messages } as unknown as PrimeModules;
  })();
  return modules;
}

/** The prime-agent package folder, whose `skills` is the bundled set when no installed release is found. */
export function primePackageDir(): string {
  return dirname(dirname(new URL(import.meta.resolve("prime-agent")).pathname));
}

/**
 * The skills folder of the Prime release the daemon runs, so a skill's `<location>` is the path a Prime chat sees: the release
 * `~/.local/share/prime-agent/bin/prime-agent` points to, then the prime-agent package's own.
 */
export function bundledSkillsDir(home = homedir()): string {
  try {
    const dir = join(dirname(realpathSync(join(home, ".local/share/prime-agent/bin/prime-agent"))), "skills");
    if (existsSync(dir)) return dir;
  } catch {
    // No installed release: the package's copy.
  }
  return join(primePackageDir(), "skills");
}

/** The legacy chat's data dir that holds the corrections ledger: AGENT_CHAT_SHARED_DIR, AGENT_CHAT_DATA_DIR, then `<agentDir>/browser-chat`. */
export function chatDataDir(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENT_CHAT_SHARED_DIR || env.AGENT_CHAT_DATA_DIR || join(agentDir, "browser-chat"));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Skills and context files, loaded by Prime's resource loader and kept until one of the files it read changes.

interface Resources { skills: Skill[]; contextFiles: ContextFile[]; mcpServers: string[] }

/**
 * Prime runs as a Bun binary, whose readdir returns entries in directory order, while Node's sorts them by name. Prime's
 * skills list follows that order, so the loaded skills are put back in it: a walk of each skills folder in directory order
 * (`opendir` does not sort), descending like Prime's loader until a folder holds a SKILL.md.
 */
function directoryOrder(dir: string, out: string[]): void {
  const entries: { name: string; dir: boolean; file: boolean }[] = [];
  try {
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          const stat = statSync(join(dir, entry.name), { throwIfNoEntry: false });
          if (!stat) continue;
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        }
        entries.push({ name: entry.name, dir: isDir, file: isFile });
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return;
  }
  if (entries.some(entry => entry.name === "SKILL.md" && entry.file)) {
    out.push(join(dir, "SKILL.md"));
    return;
  }
  for (const entry of entries) if (entry.dir && !entry.name.startsWith(".") && entry.name !== "node_modules") directoryOrder(join(dir, entry.name), out);
}

export function inDirectoryOrder<T extends { filePath: string }>(skills: readonly T[], roots: readonly string[]): T[] {
  const out = [...skills];
  // Each root's skills are put in its directory order within the places they hold, so the loader's order of roots stays.
  for (const root of roots) {
    const order: string[] = [];
    directoryOrder(root, order);
    const rank = new Map(order.map((path, index) => [path, index]));
    const slots = out.flatMap((skill, index) => (rank.has(skill.filePath) ? [index] : []));
    const sorted = slots.map(index => out[index]!).sort((a, b) => rank.get(a.filePath)! - rank.get(b.filePath)!);
    slots.forEach((slot, at) => { out[slot] = sorted[at]!; });
  }
  return out;
}

/** Every file whose change would change the loaded resources: settings, the skill folders and files, and each AGENTS.md candidate. */
function watchedPaths(agentDir: string, cwd: string, bundled: string, skills: readonly Skill[]): string[] {
  const paths = [join(agentDir, "settings.json"), join(agentDir, "skills"), bundled, join(cwd, ".prime"), join(cwd, ".agents"), join(homedir(), ".agents", "skills")];
  for (const skill of skills) paths.push(skill.filePath, dirname(skill.filePath));
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) paths.push(join(dir, name));
    if (dirname(dir) === dir) break;
  }
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) paths.push(join(agentDir, name));
  return paths;
}
const stampOf = (paths: readonly string[]): string => paths.map(path => {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
}).join("|");

const loaded = new Map<string, { paths: string[]; stamp: string; resources: Resources }>();

/** Prime's skills, context files and MCP servers for one cwd, read again only when a file it read changed. */
export async function primeResources(agentDir: string, cwd: string, bundled: string): Promise<Resources> {
  const key = `${agentDir}\0${cwd}\0${bundled}`;
  const kept = loaded.get(key);
  if (kept && stampOf(kept.paths) === kept.stamp) return kept.resources;
  const prime = await primeModules();
  const loader = new prime.DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundled, noExtensions: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const skills = inDirectoryOrder(loader.getSkills().skills, [join(agentDir, "skills"), bundled, join(homedir(), ".agents", "skills"), join(cwd, ".agents", "skills"), join(cwd, ".prime", "skills")]);
  const resources: Resources = { skills, contextFiles: loader.getAgentsFiles().agentsFiles, mcpServers: mcpServers(agentDir) };
  const paths = watchedPaths(agentDir, cwd, bundled, skills);
  loaded.set(key, { paths, stamp: stampOf(paths), resources });
  return resources;
}

/** Prime's enabled generic MCP servers: the servers in settings.json, as its MCP manager lists them once configured. */
function mcpServers(agentDir: string): string[] {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { mcpServers?: Record<string, { enabled?: boolean; disabled?: boolean }> };
    return Object.entries(settings.mcpServers ?? {}).filter(([name, server]) => /^[A-Za-z0-9_-]+$/.test(name) && server?.enabled !== false && server?.disabled !== true)
      .map(([name]) => name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The parts.

/** Prime's promptGuidelines for the session: a chat's board brief and poteto-mode line, or a chat job's job_reply and poteto-mode lines. */
export function guidelines(input: Pick<PrimePromptInput, "agentDir" | "depth" | "parentName" | "session" | "brief">): string[] {
  const persona = personaGuideline(join(input.agentDir, "skills", "poteto-mode", "SKILL.md"));
  if (input.depth === 0) return [...input.brief ?? CHAT_BRIEF, ...persona ? [persona] : []];
  return [jobReplyGuideline({ chat: input.parentName ?? "", root: false }, input.session ?? ""), ...persona ? [persona] : []];
}

const SPLIT_ERROR = "Prime's prompt layout changed; sent as one section";

/**
 * Prime's system prompt for the input, cut into its parts. Each part after the first is the text Prime appends after a blank line,
 * so `parts.map(p => p.text).join("\n\n")` is the builder's string. Should Prime's layout ever not cut this way, the whole prompt is one
 * `preamble` part, still exact.
 */
export async function primePromptParts(input: PrimePromptInput): Promise<PromptPart[]> {
  const prime = await primeModules();
  const bundled = input.bundledSkillsDir ?? bundledSkillsDir();
  const resources = await primeResources(input.agentDir, input.cwd, bundled);
  const tools = TOOLS[input.tools ?? "prime"][input.depth === 0 ? "root" : "child"];
  const options = {
    cwd: input.cwd,
    messagesPath: input.messagesPath,
    skills: resources.skills,
    contextFiles: resources.contextFiles,
    selectedTools: tools,
    promptGuidelines: guidelines(input),
    allowRecursion: true,
    rlmDepth: input.depth,
    ...(input.depth > 0 ? { rlmParentAgent: input.parentName || undefined } : {}),
    genericMcpServers: resources.mcpServers,
  };
  const full = prime.buildSystemPrompt(options);
  const parts = splitParts(prime, options, full, tools);
  if (input.primeOnly) return parts;
  return [...parts, ...await extraParts(prime, input, tools)];
}

function splitParts(prime: PrimeModules, options: Record<string, unknown> & { skills: Skill[] }, full: string, tools: readonly string[]): PromptPart[] {
  const skills = (tools.includes("ipython") || tools.includes("bash")) && options.skills.length > 0 ? prime.formatSkillsForPrompt(options.skills) : "";
  const bare = prime.buildSystemPrompt({ ...options, promptGuidelines: [], contextFiles: [] });
  const guided = prime.buildSystemPrompt({ ...options, contextFiles: [] });
  const head = bare.slice(0, bare.length - skills.length);
  const guidance = guided.slice(head.length, guided.length - skills.length);
  const context = full.slice(head.length + guidance.length, full.length - skills.length);
  const mcpAt = head.indexOf("\n\n# Generic MCP Connections\n\n");
  const delegationAt = head.indexOf("\n\n# Delegating to sub-agents\n\n");
  const baseEnd = [delegationAt, mcpAt].filter(at => at >= 0)[0] ?? head.length;
  const raw: [PromptKey, string, string][] = [
    ["preamble", head.slice(0, baseEnd), "prime-agent buildRlmPrompt (core/prompts/rlm.js)"],
    ["delegation", delegationAt >= 0 ? head.slice(delegationAt, mcpAt >= 0 ? mcpAt : head.length) : "", "prime-agent buildSubagentGuidance"],
    ["mcp", mcpAt >= 0 ? head.slice(mcpAt) : "", "prime-agent formatGenericMcpGuidance, settings.json mcpServers"],
    ["guidance", guidance, "Additional Guidance: chat-brief.ts CHAT_BRIEF or jobReplyGuideline, and personaGuideline"],
    ["context", context, "Project Context: Prime's loadProjectContextFiles"],
    ["skills", skills, "prime-agent formatSkillsForPrompt over Prime's loaded skills"],
  ];
  const whole: PromptPart[] = [{ key: "preamble", text: full, source: SPLIT_ERROR }];
  if (!bare.endsWith(skills) || !full.startsWith(head + guidance) || !full.endsWith(skills) || !guided.startsWith(head)) return whole;
  const parts: PromptPart[] = [];
  for (const [key, text, source] of raw) {
    if (!text) continue;
    if (parts.length > 0 && !text.startsWith("\n\n")) return whole;
    parts.push({ key, text: parts.length > 0 ? text.slice(2) : text, source });
  }
  return parts.map(part => part.text).join("\n\n") === full ? parts : whole;
}

const claudeRules = new SessionRules({ cellStart: () => "", cellSteps: (code, start) => [{ code, cwd: start }] });

/** The parts Prime sends as messages rather than in its system prompt, in the order they reach the model there. */
async function extraParts(prime: PrimeModules, input: PrimePromptInput, tools: readonly string[]): Promise<PromptPart[]> {
  const out: PromptPart[] = [];
  // claude-rules' context hook puts the cwd repo's unscoped .claude/rules first in every request.
  let rules: string | null = null;
  try {
    rules = claudeRules.startup(input.cwd).text;
  } catch {
    rules = null;
  }
  if (rules && !input.skip?.has("rules")) out.push({ key: "rules", text: rules, source: "packages/pi-claude-rules SessionRules.startup (Prime: first user message)" });
  // Prime's harness digest, the first custom message of a session: the global continual harness state through Prime's formatter.
  if (!input.skip?.has("harness")) {
    const hasIpython = tools.includes("ipython");
    const state = prime.loadHarnessState(join(input.agentDir, "harness"), "global");
    const digest = prime.formatHarnessStateForPrompt(state, { includeIpythonExamples: hasIpython, includeShellExamples: tools.includes("bash"), includeRefineExamples: hasIpython,
      ...(input.query ? { queryTerms: queryTerms(prime, input.query) } : {}) });
    out.push({ key: "harness", text: prime.HARNESS_DIGEST_PREFIX + digest + prime.HARNESS_DIGEST_SUFFIX, source: "prime-agent formatHarnessStateForPrompt over <agentDir>/harness (Prime: [harness-digest] message)" });
  }
  // The legacy chat's corrections block, which its context hook puts in once per context.
  if (input.skip?.has("corrections")) return out;
  const ledger = readLedger(input.ledgerDir ?? chatDataDir(input.agentDir));
  const corrections = input.depth === 0 ? ledger && ledgerPrompt(ledger, BRIEF_CORRECTIONS) : jobLedgerPrompt(ledger);
  if (corrections) out.push({ key: "corrections", text: corrections, source: "chat-corrections.ts ledgerPrompt or jobLedgerPrompt (Prime: [corrections] message)" });
  return out;
}

/**
 * Prime's relevance terms for a session's first digest (`_buildHarnessDigestQueryTerms`): the terms of its newest user message at weight 2,
 * at most 48. Prime adds the goal objective and the last four messages; a pi thread's first request has only the owner's message.
 */
function queryTerms(prime: PrimeModules, text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const term of prime.harnessQueryTerms(text)) {
    if (terms.size >= 48 && !terms.has(term)) break;
    if (!terms.has(term)) terms.set(term, 2);
  }
  return terms;
}

function readLedger(dir: string): Ledger | null {
  try {
    return parseLedger(JSON.parse(readFileSync(join(dir, "corrections.json"), "utf8")));
  } catch {
    return null;
  }
}

/** The string Prime's builder returns for the input: the Prime parts joined as pi-ai joins sections. */
export async function primeSystemPrompt(input: Omit<PrimePromptInput, "primeOnly">): Promise<string> {
  return (await primePromptParts({ ...input, primeOnly: true })).map(part => part.text).join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------------------
// The extension.

export interface PrimePromptOptions {
  agentDir: string;
  tools?: PromptTools;
  bundledSkillsDir?: string;
  ledgerDir?: string;
  /** The thread the registry serves: its file for "Conversation log:", its name for a child's lines, its cwd when a conversation has none. */
  thread?: { id: string; file: string; name: () => string; cwd: string; query?: () => string | undefined };
  log?: (line: string) => void;
}

export function promptTools(env: NodeJS.ProcessEnv = process.env): PromptTools {
  return env[PROMPT_TOOLS_ENV] === "pi" ? "pi" : "prime";
}

/**
 * The pi-durable extension that renders Prime's prompt as sections. All sections of one request share one build. A pinned section keeps
 * the text the conversation already shows; every other section is rebuilt, and pi-durable sends only a changed section again.
 */
export function primePrompt(options: PrimePromptOptions): Extension {
  const builds = new WeakMap<object, Promise<Map<PromptKey, string>>>();
  const build = (input: PromptInput): Promise<Map<PromptKey, string>> => {
    let pending = builds.get(input);
    if (!pending) {
      const depth = input.conversationId === ROOT_CONVERSATION_ID ? 0 : 1;
      const cwd = input.agent.cwd ?? (input.env as { cwd?: string } | undefined)?.cwd ?? options.thread?.cwd ?? process.cwd();
      const thread = options.thread;
      pending = primePromptParts({
        agentDir: options.agentDir,
        cwd,
        ...(thread ? { messagesPath: thread.file, parentName: thread.name(), session: `${thread.id}-${input.conversationId}` } : {}),
        ...(depth === 0 && thread?.query?.() ? { query: thread.query()! } : {}),
        depth,
        tools: options.tools ?? "prime",
        skip: new Set([...PINNED_SECTIONS].filter(key => input.shown[key] !== undefined)),
        ...(options.bundledSkillsDir ? { bundledSkillsDir: options.bundledSkillsDir } : {}),
        ...(options.ledgerDir ? { ledgerDir: options.ledgerDir } : {}),
      }).then(parts => new Map(parts.map(part => [part.key, part.text])));
      pending.catch(error => options.log?.(`prime prompt failed: ${error instanceof Error ? error.message : String(error)}`));
      builds.set(input, pending);
    }
    return pending;
  };
  const render = (key: PromptKey) => async (input: PromptInput): Promise<string | undefined> => {
    if (PINNED_SECTIONS.has(key) && input.shown[key] !== undefined) return input.shown[key];
    return (await build(input)).get(key);
  };
  return defineExtension({ name: "prime-prompt", sections: [...PRIME_SECTIONS, ...EXTRA_SECTIONS].map(key => section(key, render(key), { tag: false })) });
}
