import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob, relative } from "node:path";
import { frontmatter } from "../scripts/duties/skills-and-tools.ts";
import type { FirstPrompt, SkillInfo, SkillSource, SkillsView } from "./shared/types.ts";
import { fileLines } from "./file-lines.ts";

/**
 * Characters per token of Prime's <skill> blocks. Measured 2026-10-14 with Anthropic's count_tokens for claude-opus-5-5 on the 44 blocks of an
 * auto-sns-agent session: 18,476 chars, 7,552 tokens. Each block came within 10% of chars / 2.45, and the sum within 1%.
 */
export const SKILL_CHARS_PER_TOKEN = 2.45;
/** Tokens of the fixed lines Prime 0.9.8 puts around the blocks (the intro and the <available_skills> tags), measured the same way. */
export const SKILLS_HEADER_TOKENS = 146;
/** How many of the newest session files firstPrompt reads before it gives up. */
const FIRST_PROMPT_SCAN = 200;

/** The folders skillsView reads. `release` is the running Prime release folder (its skills/ and package.json); `repo` is the auto-sns-agent checkout. */
export interface SkillRoots { agentDir: string; agentsSkills: string; release: string | null; repo: string | null }

export async function defaultSkillRoots(home = homedir()): Promise<SkillRoots> {
  const binary = await realpath(join(home, ".local/share/prime-agent/bin/prime-agent")).catch(() => null);
  return {
    agentDir: join(home, ".prime/agent"),
    agentsSkills: join(home, ".agents/skills"),
    release: binary && dirname(binary),
    repo: process.env.HARNESS_REPO || join(home, "Documents/Github/auto-sns-agent"),
  };
}

const tilde = (path: string) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
const readJson = (path: string): Promise<Record<string, unknown>> => readFile(path, "utf8").then(text => JSON.parse(text) as Record<string, unknown>).catch(() => ({}));
const skillPatterns = (settings: Record<string, unknown>) => Array.isArray(settings.skills) ? settings.skills.filter((entry): entry is string => typeof entry === "string") : [];

async function kind(path: string): Promise<"dir" | "file" | null> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ? "dir" : info?.isFile() ? "file" : null;
}

/** Prime's skill walk: a folder with a SKILL.md is one skill and is not entered further; other folders are searched, skipping dot folders and node_modules. */
async function findSkillFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.includes("SKILL.md") && await kind(join(dir, "SKILL.md")) === "file") return [join(dir, "SKILL.md")];
  const found = await Promise.all(names.filter(name => !name.startsWith(".") && name !== "node_modules")
    .map(async name => await kind(join(dir, name)) === "dir" ? findSkillFiles(join(dir, name)) : []));
  return found.flat();
}

/** Flat `<root>/<name>/SKILL.md` folders, as Claude Code reads `.claude/skills-native`. */
async function flatSkillFiles(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const files = await Promise.all(names.map(async name => await kind(join(root, name, "SKILL.md")) === "file" ? [join(root, name, "SKILL.md")] : []));
  return files.flat();
}

/**
 * Prime's settings `skills` overrides for one SKILL.md: `!glob` turns it off, `+path` back on, `-path` off, where a path is the file or its folder,
 * absolute or relative to `baseDir`.
 */
export function enabledBySettings(file: string, patterns: string[], baseDir: string): boolean {
  const dir = dirname(file);
  const exact = [file, relative(baseDir, file), dir, relative(baseDir, dir)];
  const glob = [...exact, basename(file), basename(dir)];
  const hits = (prefix: string, names: string[], match: (pattern: string, name: string) => boolean) =>
    patterns.some(entry => entry.startsWith(prefix) && names.some(name => match(entry.slice(1).replace(/^\.\//, ""), name)));
  let enabled = !hits("!", glob, (pattern, name) => matchesGlob(name, pattern));
  if (hits("+", exact, (pattern, name) => pattern === name)) enabled = true;
  if (hits("-", exact, (pattern, name) => pattern === name)) enabled = false;
  return enabled;
}

/** `prime` is false for a folder Prime never reads (Claude Code's skills-native), so its skill adds no tokens. */
type Found = { file: string; source: SkillSource; from: string; enabled: boolean; prime: boolean };

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** One skill's lines in Prime 0.9.8's <available_skills> list (C7 in the release bundle); `location` is the SKILL.md path as walked, before links. */
export function skillBlock(skill: { name: string; description: string; location: string; pythonImport: string | null }): string {
  return ["  <skill>", `    <name>${xml(skill.name)}</name>`, `    <type>${skill.pythonImport ? "python" : "markdown"}</type>`,
    ...skill.pythonImport ? [`    <python_import>${xml(skill.pythonImport)}</python_import>`] : [],
    `    <description>${xml(skill.description)}</description>`, `    <location>${xml(skill.location)}</location>`, "  </skill>"].join("\n");
}

/** Prime makes a skill a python skill when its folder has pyproject.toml and src/<name with _ for ->/__init__.py. */
async function pythonImport(dir: string, name: string): Promise<string | null> {
  const id = name.replaceAll("-", "_");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return null;
  const [project, init] = await Promise.all([kind(join(dir, "pyproject.toml")), kind(join(dir, "src", id, "__init__.py"))]);
  return project === "file" && init === "file" ? id : null;
}

type Read = SkillInfo & { chars: number; prime: boolean };

async function readSkill(found: Found): Promise<Read | null> {
  const path = await realpath(found.file).catch(() => null);
  const text = path && await readFile(path, "utf8").catch(() => null);
  if (!path || text == null) return null;
  const fields = frontmatter(text);
  const description = (fields.description ?? "").replace(/\\(["\\])/g, "$1").replace(/\s+/g, " ").trim();
  const name = fields.name || basename(dirname(found.file));
  const chars = skillBlock({ name, description, location: found.file, pythonImport: await pythonImport(dirname(found.file), name) }).length;
  return { name, description, source: found.source, from: found.from, path, enabled: found.enabled && description !== "", tokens: 0,
    userOnly: fields["disable-model-invocation"] === "true", chars, prime: found.prime };
}

/** A skill's tokens in each session's prompt: its block's chars over SKILL_CHARS_PER_TOKEN, or 0 when Prime leaves it out of the list. */
function withTokens({ chars, prime, ...skill }: Read): SkillInfo {
  return { ...skill, tokens: prime && skill.enabled && !skill.userOnly ? Math.round(chars / SKILL_CHARS_PER_TOKEN) : 0 };
}

/**
 * The first request of the newest root session started in `cwd` whose first reply has usage, read from Prime's session files (named by time-ordered
 * ids). A child session has a parentSession, and a reply that failed reports 0 tokens; both are skipped.
 */
export async function firstPrompt(sessionsDir: string, cwd: string): Promise<FirstPrompt | null> {
  const names = (await readdir(sessionsDir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl")).sort().reverse().slice(0, FIRST_PROMPT_SCAN);
  for (const name of names) {
    const found = await firstUsage(join(sessionsDir, name), cwd);
    if (found) return { ...found, sessionId: name.slice(0, -".jsonl".length) };
  }
  return null;
}

async function firstUsage(file: string, cwd: string): Promise<{ tokens: number; at: number } | null> {
  const lines = fileLines(file);
  try {
    for await (const line of lines) {
      let entry: { type?: string; cwd?: string; parentSession?: string; message?: { role?: string; timestamp?: number; usage?: Record<string, unknown> } };
      try { entry = JSON.parse(line) as typeof entry; } catch { return null; }
      if (entry.type === "session") { if (entry.cwd !== cwd || entry.parentSession) return null; continue; }
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const usage = entry.message.usage ?? {};
      const tokens = ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (typeof usage[key] === "number" ? usage[key] : 0), 0);
      return tokens > 0 && typeof entry.message.timestamp === "number" ? { tokens, at: entry.message.timestamp } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Prime loads the enabled skills in order and keeps the first of each name and of each real file, so a global skill hides a built-in one with its name. */
function dropShadowed(skills: Read[]): Read[] {
  const names = new Set<string>(), paths = new Set<string>();
  return skills.flatMap(skill => {
    if (paths.has(skill.path)) return [];
    if (!skill.enabled) return [skill];
    paths.add(skill.path);
    if (names.has(skill.name)) return [{ ...skill, enabled: false }];
    names.add(skill.name);
    return [skill];
  });
}

const SOURCE_ORDER: SkillSource[] = ["global", "built-in", "repo"];

/**
 * Every installed skill the way Prime finds it: ~/.prime/agent/skills and ~/.agents/skills (global), the running release's skills/ (built-in), and the
 * auto-sns-agent repo's .agents/skills plus Claude Code's .claude/skills-native (repo). `enabled` follows the settings `skills` overrides, `bundledSkills`,
 * `enableBuiltinSkills`, a missing description, and name shadowing. `tokens` totals what the listed skills add to a fresh session in the repo, next to
 * that session's measured first prompt.
 */
export async function skillsView(roots?: SkillRoots): Promise<SkillsView> {
  const { agentDir, agentsSkills, release, repo } = roots ?? await defaultSkillRoots();
  const projectDir = repo && join(repo, ".prime/agent");
  const [settings, projectSettings, version] = await Promise.all([
    readJson(join(agentDir, "settings.json")),
    projectDir ? readJson(join(projectDir, "settings.json")) : {},
    release ? readJson(join(release, "package.json")).then(pkg => pkg.version) : undefined,
  ]);
  const userPatterns = skillPatterns(settings);
  const builtinDir = release && join(release, "skills");
  const bundled = settings.bundledSkills as { websearch?: boolean } | undefined;
  const builtinPatterns = [...userPatterns, ...(bundled?.websearch === false ? ["-websearch/SKILL.md"] : [])];
  const builtinsOn = settings.enableBuiltinSkills !== false;
  const builtinFrom = typeof version === "string" ? `Prime ${version}` : release ? basename(release) : "Prime";
  const repoFrom = repo ? basename(repo) : "";

  const [global, agents, builtin, repoAgents, repoPrime, repoNative] = await Promise.all([
    findSkillFiles(join(agentDir, "skills")),
    findSkillFiles(agentsSkills),
    builtinDir ? findSkillFiles(builtinDir) : [],
    repo ? findSkillFiles(join(repo, ".agents/skills")) : [],
    projectDir ? findSkillFiles(join(projectDir, "skills")) : [],
    repo ? flatSkillFiles(join(repo, ".claude/skills-native")) : [],
  ]);
  const globalFound = (files: string[], root: string): Found[] =>
    files.map(file => ({ file, source: "global", from: tilde(root), enabled: enabledBySettings(file, userPatterns, agentDir), prime: true }));
  const repoFound = (files: string[], patterns: string[], prime = true): Found[] =>
    files.map(file => ({ file, source: "repo", from: repoFrom, enabled: enabledBySettings(file, patterns, projectDir ?? ""), prime }));
  const read = (group: Found[]) => Promise.all(group.map(readSkill)).then(skills => dropShadowed(skills.filter(skill => skill !== null)));
  const groups = await Promise.all([
    read([
      ...globalFound(global, join(agentDir, "skills")),
      ...globalFound(agents, agentsSkills),
      ...builtin.map(file => ({ file, source: "built-in" as const, from: builtinFrom, enabled: builtinsOn && enabledBySettings(file, builtinPatterns, builtinDir ?? ""),
        prime: true })),
    ]),
    read(repoFound([...repoPrime, ...repoAgents], skillPatterns(projectSettings))),
    read(repoFound(repoNative, [], false)),
  ]);
  const skills = groups.flat().map(withTokens);
  const sum = (source: SkillSource) => skills.reduce((total, skill) => total + (skill.source === source ? skill.tokens : 0), 0);
  const tokenGroups = { global: sum("global"), "built-in": sum("built-in"), repo: sum("repo") };
  const blocks = tokenGroups.global + tokenGroups["built-in"] + tokenGroups.repo;
  const header = blocks > 0 ? SKILLS_HEADER_TOKENS : 0;
  return {
    skills: skills.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name)),
    tokens: { groups: tokenGroups, header, total: blocks + header, charsPerToken: SKILL_CHARS_PER_TOKEN, firstPrompt: repo ? await firstPrompt(join(agentDir, "sessions"), repo) : null },
  };
}
