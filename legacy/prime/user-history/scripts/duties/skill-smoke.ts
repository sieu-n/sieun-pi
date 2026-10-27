import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadSkillsFromDir, parseFrontmatter } from "prime-agent";
import type { Skill, SkillRoot, SkillSmoke } from "./harness-health.ts";

/**
 * Skill smoke checks for the Skills and harness precheck. Each one fails when an agent would hit a broken skill, with no model call:
 * Prime's own loader must load the SKILL.md with a name and a description, every relative path its markdown names must exist, a Python skill
 * must import in the Prime kernel venv and each CLI its pyproject.toml declares must answer `--help`, and a repo skill must read through the
 * repo's `node scripts/skills/read-skill.mjs`. Never a size or word count (owner 10-10, c39).
 */

/** The session id the smoke's skill reads carry in the llm-wiki views, so unread_14d leaves them out. */
export const SMOKE_SESSION = "harness-skill-smoke";
const RUN_MS = 60_000;
const CONCURRENCY = 4;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__"]);
/** A backticked path with one of these prefixes always names a file in the skill or next to the file that names it. */
const STRICT = ["./", "../", "references/", "scripts/", "playbooks/"];
const FILE_EXT = /\.(?:md|mjs|cjs|js|ts|tsx|py|sh|json|toml|ya?ml|txt|sql|svelte)$/;

/** The Prime kernel venv python; the skill CLIs live next to it in its bin directory. */
export interface SmokeEnv { python: string }
interface Run { code: number | null; out: string; err: string }

const run = (file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> => new Promise(resolve => {
  execFile(file, args, { ...options, timeout: RUN_MS, maxBuffer: 16 * 1024 * 1024 }, (error, out, err) => {
    const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
    resolve({ code, out: String(out), err: String(err) || (error && typeof error.code !== "number" ? error.message : "") });
  });
});
const lastLine = (text: string): string => text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? "";
const exists = (path: string) => stat(path).then(() => true, () => false);

async function gitRoot(dir: string): Promise<string | null> {
  for (let at = dir; ; at = dirname(at)) {
    if (await exists(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

/** Every .md file in a skill, leaving out dependencies, build output, dot directories and skills nested inside it. */
async function markdownFiles(dir: string, top = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (dir !== top && entries.some(entry => entry.name === "SKILL.md")) return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(path, top));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

/**
 * The relative paths a markdown file names: markdown link targets outside code, and backticked paths that start with a skill folder prefix
 * (STRICT) or that end in a file extension under a folder that exists. URLs, anchors, home and absolute paths, and placeholders are left out,
 * and so is a link to a bare slug with no slash or dot, such as `[snippet](snippet)` in docs copied from a docs site.
 */
export function namedPaths(markdown: string): { path: string; strict: boolean }[] {
  const prose = markdown.replace(/^([ \t]*)(```|~~~)[\s\S]*?^\1\2/gm, "");
  const found: { path: string; strict: boolean }[] = [];
  const add = (raw: string, link: boolean) => {
    const path = raw.split("#")[0]!.split("?")[0]!.replace(/:\d+(?:-\d+)?$/, "");
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || /^[/~$]/.test(path) || /[<>{}*$|[\]]|\.\.\./.test(path)) return;
    if (link) return /[/.]/.test(path) ? found.push({ path, strict: true }) : undefined;
    if (!path.replace(/\/$/, "").includes("/")) return;
    const strict = STRICT.some(prefix => path.startsWith(prefix));
    if (strict || FILE_EXT.test(path)) found.push({ path, strict });
  };
  for (const match of prose.replace(/`[^`\n]*`/g, "").matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(match[1]!, true);
  for (const match of prose.matchAll(/`([^`\s]+)`/g)) add(match[1]!, false);
  return found;
}

/** The paths a skill's markdown names that resolve against none of: the naming file's folder, the skill folder, the repo root. */
export async function missingPaths(dir: string): Promise<string[]> {
  const repo = await gitRoot(dir);
  const missing: string[] = [];
  for (const file of await markdownFiles(dir)) {
    const bases = [dirname(file), dir, ...(repo ? [repo] : [])];
    const seen = new Set<string>();
    for (const { path, strict } of namedPaths(await readFile(file, "utf8"))) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!strict && !(await Promise.all(bases.map(base => exists(join(base, path.split("/")[0]!))))).some(Boolean)) continue;
      if (!(await Promise.all(bases.map(base => exists(join(base, path))))).some(Boolean)) missing.push(`${relative(dir, file)} names ${path}`);
    }
  }
  return missing;
}

/** The script names in a pyproject.toml's [project.scripts] table. */
export function declaredScripts(pyproject: string): string[] {
  const table = /^\[project\.scripts\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
  return [...table.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/gm)].map(match => match[1]!);
}

/** One skill's smoke result: every problem an agent would hit, joined, or a pass. */
export async function smokeSkill(skill: Skill, root: SkillRoot | undefined, env: SmokeEnv): Promise<SkillSmoke> {
  const problems: string[] = [];
  const loaded = loadSkillsFromDir({ dir: skill.dir, source: "path" });
  const prime = loaded.skills[0];
  if (!prime) problems.push(`Prime does not load it: ${loaded.diagnostics.map(diagnostic => diagnostic.message).join(", ") || "no SKILL.md"}`);
  else if (!String(parseFrontmatter(await readFile(prime.filePath, "utf8")).frontmatter.name ?? "").trim()) problems.push("the frontmatter has no name");
  for (const diagnostic of loaded.diagnostics) if (prime && diagnostic.message.startsWith("python skill")) problems.push(diagnostic.message);
  problems.push(...(await missingPaths(skill.dir)).map(line => `missing path: ${line}`));
  if (prime?.kind === "python") {
    const module = prime.python.importName;
    const imported = await run(env.python, ["-c", `import ${module}`]);
    if (imported.code !== 0) problems.push(`import ${module} fails in the kernel venv: ${lastLine(imported.err) || `exit ${imported.code}`}`);
    for (const script of declaredScripts(await readFile(prime.python.pyprojectPath, "utf8"))) {
      const help = await run(join(dirname(env.python), script), ["--help"]);
      if (help.code !== 0) problems.push(`${script} --help exits ${help.code ?? "without a code"}: ${lastLine(help.err) || lastLine(help.out)}`);
    }
  }
  if (root?.repo) {
    const id = relative(root.repo, join(root.dir, skill.id.slice(root.name.length + 1)));
    const read = await run("node", ["scripts/skills/read-skill.mjs", id], { cwd: root.repo, env: { ...process.env, RLM_SESSION_DIR: join("/", SMOKE_SESSION) } });
    if (read.code !== 0 || !read.out.trim()) problems.push(`node scripts/skills/read-skill.mjs ${id} exits ${read.code}: ${lastLine(read.err)}`);
  }
  return { skill: skill.id, pass: problems.length === 0, ...(problems.length ? { detail: problems.join("; ") } : {}) };
}

/** Smoke results for every skill, CONCURRENCY at a time, in the skills' order. */
export async function smokeSkills(skills: readonly Skill[], roots: readonly SkillRoot[], env: SmokeEnv): Promise<SkillSmoke[]> {
  const results: SkillSmoke[] = new Array(skills.length);
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < skills.length; at = next++) results[at] = await smokeSkill(skills[at]!, roots.find(root => root.name === skills[at]!.root), env);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}
