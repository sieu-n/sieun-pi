import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KernelCwd } from "../core/rules.ts";

// A load-time throw in a global extension stops every Prime session, so a failed import only logs. Prime loads this file through
// its link in ~/.prime/agent/extensions, so the modules are found from the link's real path.
//
// An ipython cell's paths are read against the cwd each part of the cell runs in, which sieun-rules works out: its kernel prelude writes
// the kernel's cwd to kernel-cwd.json, and its kernel-cwd.ts follows each os.chdir the cell spells out. Without sieun-rules next to this
// package, as in a stock Pi install, a cell is read as one part in the session cwd.
export const SIEUN_RULES_KERNEL_CWD = "../../../sieun-rules/src/kernel-cwd.ts";

export const sessionCwd: KernelCwd = {
	cellStart: (ctx) => (ctx as { cwd?: string } | null | undefined)?.cwd ?? process.cwd(),
	cellSteps: (code, start) => [{ code, cwd: start }],
};

export async function kernelCwd(dir: string): Promise<KernelCwd> {
	const path = join(dir, SIEUN_RULES_KERNEL_CWD);
	if (!existsSync(path)) return sessionCwd;
	const cwd: typeof import("../../../sieun-rules/src/kernel-cwd.ts") = await import(path);
	return cwd;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (["off", "0", "false"].includes((process.env.CLAUDE_RULES || "").toLowerCase())) return;
	try {
		const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
		const rules: typeof import("../core/rules.ts") = await import(join(dir, "../core/rules.ts"));
		rules.register(pi, await kernelCwd(dir));
	} catch (error) {
		try {
			appendFileSync(process.env.GLOBAL_RULES_LOG || join(tmpdir(), "global-rules.log"), `${new Date().toISOString()} [claude-rules] load failed: ${error instanceof Error ? error.message : String(error)}\n`);
		} catch {
			// A log that cannot be written must not stop the session.
		}
	}
}
