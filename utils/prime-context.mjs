import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "prime-agent";

function skillKey(file, repoRoot) {
  const relative = path.relative(repoRoot, file);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) && relative !== "..")) return `repo:${relative}`;
  const homeRelative = path.relative(homedir(), file);
  if (homeRelative === "" || (!homeRelative.startsWith(".." + path.sep) && !path.isAbsolute(homeRelative) && homeRelative !== "..")) return `home:${homeRelative}`;
  return `abs:${file}`;
}

function gitRoot(from) {
	let dir = path.resolve(from);
	for (;;) {
		if (existsSync(path.join(dir, '.git'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function primeAgentRoots(cwd) {
	const home = homedir();
	const roots = [];
	const repoGit = gitRoot(cwd);
	let dir = path.resolve(cwd);
	for (;;) {
		roots.push({ dir: path.join(dir, '.agents', 'skills'), rank: 1, kind: 'project-auto' });
		if (repoGit && dir === repoGit) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	roots.unshift({ dir: path.join(cwd, '.prime', 'agent', 'skills'), rank: 0, kind: 'project-settings' });
	roots.push({ dir: path.join(home, '.prime', 'agent', 'skills'), rank: 3, kind: 'user-auto' });
	roots.push({ dir: path.join(home, '.agents', 'skills'), rank: 3, kind: 'user-auto' });
	return roots.filter((r, i) => roots.findIndex((o) => o.dir === r.dir) === i);
}

export async function derivePrimeAgent(cwd, { repoRoot = cwd } = {}) {
	const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("prime-agent"))));
	const roots = primeAgentRoots(cwd);
	const builtin = { dir: path.join(sdkRoot, 'dist', 'skills'), rank: 5, kind: 'builtin' };
	const ordered = [...roots, builtin];

	const seen = new Set();
	const rows = [];
	for (const root of ordered) {
		if (!existsSync(root.dir)) continue;
		const { skills } = loadSkills({ cwd, agentDir: path.join(homedir(), '.prime', 'agent'), skillPaths: [root.dir], includeDefaults: false });
		for (const skill of skills) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			rows.push({
				host: 'prime-agent',
				layer: 'skill',
				skill_key: skillKey(skill.filePath, repoRoot),
				display_id: skill.name,
				name: skill.name,
				description: skill.description,
				description_chars: skill.description.length,
				body_chars: 0,
				visible: !skill.disableModelInvocation,
				root_kind: root.kind,
				precedence_rank: root.rank,
			});
		}
	}
	return { rows };
}
