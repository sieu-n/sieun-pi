import { appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "prime-agent";

// A load-time throw in a global extension stops every Prime session, so a failed import only logs. Prime loads this file through
// its link in ~/.prime/agent/extensions, so the modules are found from the link's real path.
export default async function (pi: ExtensionAPI): Promise<void> {
	if (["off", "0", "false"].includes((process.env.CLAUDE_RULES || "").toLowerCase())) return;
	try {
		const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
		const rules: typeof import("./rules.ts") = await import(join(dir, "rules.ts"));
		const cwd: typeof import("../global-rules/kernel-cwd.ts") = await import(join(dir, "../global-rules/kernel-cwd.ts"));
		rules.register(pi, cwd);
	} catch (error) {
		try {
			appendFileSync(process.env.GLOBAL_RULES_LOG || join(tmpdir(), "global-rules.log"), `${new Date().toISOString()} [claude-rules] load failed: ${error instanceof Error ? error.message : String(error)}\n`);
		} catch {
			// A log that cannot be written must not stop the session.
		}
	}
}
