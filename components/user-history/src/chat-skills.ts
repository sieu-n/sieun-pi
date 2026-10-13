import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, matchesGlob, relative } from "node:path";
import { frontmatter } from "../scripts/duties/skills-and-tools.ts";
import type { SkillInfo, SkillSource, SkillsView } from "./shared/types.ts";

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

type Found = { file: string; source: SkillSource; from: string; enabled: boolean };

async function readSkill(found: Found): Promise<SkillInfo | null> {
  const path = await realpath(found.file).catch(() => null);
  const text = path && await readFile(path, "utf8").catch(() => null);
  if (!path || text == null) return null;
  const fields = frontmatter(text);
  const description = (fields.description ?? "").replace(/\\(["\\])/g, "$1").replace(/\s+/g, " ").trim();
  const name = fields.name || basename(dirname(found.file));
  return { name, description, source: found.source, from: found.from, path, enabled: found.enabled && description !== "" };
}

/** Prime loads the enabled skills in order and keeps the first of each name and of each real file, so a global skill hides a built-in one with its name. */
function dropShadowed(skills: SkillInfo[]): SkillInfo[] {
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
 * `enableBuiltinSkills`, a missing description, and name shadowing.
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
    files.map(file => ({ file, source: "global", from: tilde(root), enabled: enabledBySettings(file, userPatterns, agentDir) }));
  const repoFound = (files: string[], patterns: string[]): Found[] =>
    files.map(file => ({ file, source: "repo", from: repoFrom, enabled: enabledBySettings(file, patterns, projectDir ?? "") }));
  const read = (group: Found[]) => Promise.all(group.map(readSkill)).then(skills => dropShadowed(skills.filter(skill => skill !== null)));
  const groups = await Promise.all([
    read([
      ...globalFound(global, join(agentDir, "skills")),
      ...globalFound(agents, agentsSkills),
      ...builtin.map(file => ({ file, source: "built-in" as const, from: builtinFrom, enabled: builtinsOn && enabledBySettings(file, builtinPatterns, builtinDir ?? "") })),
    ]),
    read(repoFound([...repoPrime, ...repoAgents], skillPatterns(projectSettings))),
    read(repoFound(repoNative, [])),
  ]);
  const skills = groups.flat();
  return { skills: skills.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name)) };
}
