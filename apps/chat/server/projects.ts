/**
 * Project folders: the checkouts an agent can run in. A thread's cwd picks the AGENTS.md chain, skills and rules Prime's prompt loads
 * (packages/pi-host/src/durable/prime-prompt.ts), so a thread in the home folder runs with no project's rules. The list is `Config.projects`,
 * kept to the folders that exist on this box; the first one is the default for a new agent.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ProjectList } from "../web/src/lib/api/types.ts";
import type { Config } from "./config.ts";

/** A cwd the server will not give a thread; the HTTP layer answers it with 400. */
export class CwdRefused extends Error {}

const isFolder = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** True for the home folder and every folder above it, where no project's AGENTS.md applies. */
export function isNoProject(cwd: string, home: string): boolean {
  const up = relative(resolve(cwd), resolve(home));
  return up === "" || (!up.startsWith("..") && !isAbsolute(up));
}

export function projectList(config: Pick<Config, "projects" | "home">): ProjectList {
  const projects = [...new Set(config.projects.map(path => resolve(path)))]
    .filter(path => isFolder(path) && !isNoProject(path, config.home))
    .map(path => ({ path, name: basename(path) }));
  return { projects, default: projects[0]?.path ?? null, home: resolve(config.home) };
}

/** The cwd a new or moved thread gets: the given folder once it passes the checks, else the default project. */
export function projectCwd(config: Pick<Config, "projects" | "home">, cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === "") {
    const fallback = projectList(config).default;
    if (!fallback) throw new CwdRefused(`A project folder is needed, and none of the configured ones (${config.projects.join(", ") || "none"}) is on this box. Name one in cwd.`);
    return fallback;
  }
  if (!isAbsolute(cwd)) throw new CwdRefused(`A project folder is an absolute path, got ${JSON.stringify(cwd)}.`);
  const path = resolve(cwd);
  if (isNoProject(path, config.home)) {
    throw new CwdRefused(`A project folder is needed: ${path} is ${path === resolve(config.home) ? "the home folder" : "above the home folder"}, where no project's AGENTS.md, skills or rules load. Pick a checkout such as ${projectList(config).default ?? "a repo folder"}.`);
  }
  if (!isFolder(path)) throw new CwdRefused(`A project folder must exist on this box, and ${path} does not.`);
  return path;
}
