import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo paths auto-sns-agent's guard files load from HEAD through agent-branch.mjs headModule, or from the checkout root through a
// '../../../../<path>' require (dev-servers.mjs reads scripts/dev/dev-apps.cjs that way since ff573df47f), read from the guard files
// themselves, so a fixture that commits them follows a new import with no hand edit.
export function headModules(guards) {
	const paths = new Set();
	for (const name of readdirSync(guards).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"))) {
		const text = readFileSync(join(guards, name), "utf8");
		for (const m of text.matchAll(/headModule\(\s*['"]([^'"]+)['"]/g)) paths.add(m[1]);
		for (const m of text.matchAll(/['"]\.\.\/\.\.\/\.\.\/\.\.\/([^'"]+)['"]/g)) paths.add(m[1]);
	}
	return [...paths].sort();
}
