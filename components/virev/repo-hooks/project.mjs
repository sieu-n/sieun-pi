import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** @typedef {{ repoRoot: string, cwd: string, policy: string }} Project */

export function projectsFile() {
  return process.env.VIREV_PROJECTS_FILE || join(homedir(), ".prime/agent/virev-projects.json");
}

export function canonicalDirectory(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalDirectory(parent), relative(parent, absolute));
  }
}

/** @returns {{ repoRoot: string, policy: string }[]} */
export function configuredProjects() {
  let config;
  try {
    config = JSON.parse(readFileSync(projectsFile(), "utf8"));
  } catch {
    return [];
  }
  if (!config || !Array.isArray(config.projects)) return [];
  const projects = [];
  for (const entry of config.projects) {
    if (!entry || typeof entry.root !== "string" || !isAbsolute(entry.root) ||
        typeof entry.policy !== "string" || !entry.policy) continue;
    try {
      const repoRoot = realpathSync(entry.root);
      if (statSync(repoRoot).isDirectory()) projects.push({ repoRoot, policy: entry.policy });
    } catch {
      continue;
    }
  }
  return projects;
}

/** @returns {Project | null} */
export function findProject(cwd = process.cwd()) {
  const directory = canonicalDirectory(cwd);
  let project = null;
  for (const { repoRoot, policy } of configuredProjects()) {
    if (isInsideRepo(directory, repoRoot) && (!project || repoRoot.length > project.repoRoot.length)) {
      project = { repoRoot, cwd: directory, policy };
    }
  }
  return project;
}

export function isInsideRepo(targetDir, repoRoot) {
  let directory = canonicalDirectory(targetDir);
  const root = canonicalDirectory(repoRoot);
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  while (directory !== root) {
    if (existsSync(join(directory, ".git"))) return false;
    directory = dirname(directory);
  }
  return true;
}
