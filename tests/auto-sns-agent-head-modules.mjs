import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo paths auto-sns-agent's guard files load from HEAD through agent-branch.mjs headModule, read from the guard files
// themselves, so a fixture that commits them follows a new import with no hand edit.
export function headModules(guards) {
	const paths = new Set();
	for (const name of readdirSync(guards).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"))) {
		for (const m of readFileSync(join(guards, name), "utf8").matchAll(/headModule\(\s*['"]([^'"]+)['"]/g)) paths.add(m[1]);
	}
	return [...paths].sort();
}
