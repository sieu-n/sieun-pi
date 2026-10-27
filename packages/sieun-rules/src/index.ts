import { appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "prime-agent";

// Each module loads inside its own try/catch: a load-time throw in a global extension stops every Prime session,
// and a broken guard must not take the other modules with it. The modules are .ts because Prime's loader
// re-reads nested .ts files on /reload and keeps nested .mjs files cached for the life of the process.
export default async function (pi: ExtensionAPI): Promise<void> {
	const failed: string[] = [];
	const logPath = process.env.GLOBAL_RULES_LOG || join(tmpdir(), "global-rules.log");
	const loadFailed = (module: string, error: unknown) => {
		failed.push(module);
		try {
			appendFileSync(logPath, `${new Date().toISOString()} [load] ${module} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		} catch {
			// A log that cannot be written must not stop the session.
		}
	};

	let dir: string;
	try {
		dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
	} catch (error) {
		loadFailed("index.ts", error);
		return;
	}

	try {
		const guard: typeof import("./guard.ts") = await import(join(dir, "guard.ts"));
		pi.on("tool_call", (event, ctx) => guard.onToolCall(event, ctx));
	} catch (error) {
		loadFailed("guard.ts", error);
	}

	try {
		const kernelGuard: typeof import("./kernel-guard.ts") = await import(join(dir, "kernel-guard.ts"));
		pi.on("tool_call", (event) => kernelGuard.onToolCall(event));
	} catch (error) {
		loadFailed("kernel-guard.ts", error);
	}

	try {
		const transcriptGuard: typeof import("./transcript-guard.ts") = await import(join(dir, "transcript-guard.ts"));
		pi.on("tool_call", (event, ctx) => transcriptGuard.onToolCall(event, ctx));
	} catch (error) {
		loadFailed("transcript-guard.ts", error);
	}

	// rlm-delete.ts works around a Prime 0.9.8 abort bug that pi-rlm does not have, so it stays off on upstream Pi.
	if (typeof (pi as { registerMcpServer?: unknown }).registerMcpServer !== "function") try {
		const rlmDelete: typeof import("./rlm-delete.ts") = await import(join(dir, "rlm-delete.ts"));
		pi.on("tool_call", (event, ctx) => rlmDelete.onToolCall(event, ctx));
	} catch (error) {
		loadFailed("rlm-delete.ts", error);
	}

	try {
		const autoSnsAgent: typeof import("./auto-sns-agent.ts") = await import(join(dir, "auto-sns-agent.ts"));
		await autoSnsAgent.register(pi);
	} catch (error) {
		loadFailed("auto-sns-agent.ts", error);
	}

	if (failed.length) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`global-rules could not load ${failed.join(", ")}. Read ${logPath}.`, "error");
		});
	}
}
