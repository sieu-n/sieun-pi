import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "prime-agent";

type Impl = typeof import("../ext-impl/virev/index.mjs");

const LOG_PATH = process.env.VIREV_EXT_LOG || join(tmpdir(), "virev-ext.log");
const WATCH_DEBOUNCE_MS = 150;
const MODULE_DIRS = [join("ext-impl", "virev"), "repo-hooks", "policies", join("policies", "auto-sns-agent")];

function shellLog(message: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} [shell] ${message}\n`);
	} catch {
		// Logging must not prevent tool execution.
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI): void {
	const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
	const sourceDir = resolve(here, "..");
	const implDir = join(sourceDir, "ext-impl", "virev");
	let impl: Impl | null = null;
	let generation = 0;
	let live = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const watchers: ReturnType<typeof watch>[] = [];

	async function loadImpl(why: string): Promise<void> {
		let temp: string | null = null;
		try {
			temp = mkdtempSync(join(tmpdir(), `virev-impl-${process.pid}-`));
			for (const relativeDir of MODULE_DIRS) {
				const destination = join(temp, relativeDir);
				mkdirSync(destination, { recursive: true });
				for (const name of readdirSync(join(sourceDir, relativeDir))) {
					if (name.endsWith(".mjs")) copyFileSync(join(sourceDir, relativeDir, name), join(destination, name));
				}
			}
			// Unique paths also refresh nested imports in Prime Agent's jiti loader.
			const mod: Impl = await import(pathToFileURL(join(temp, "ext-impl", "virev", "index.mjs")).href);
			mod.init({ implDir });
			if (!live) return;
			impl = mod;
			generation += 1;
			shellLog(`impl generation ${generation} live (${why}): ${mod.describe()}`);
		} catch (error) {
			shellLog(`load failed (${why}), keeping previous impl: ${errorText(error)}`);
		} finally {
			if (temp) {
				try {
					rmSync(temp, { recursive: true, force: true });
				} catch (error) {
					shellLog(`temp cleanup failed: ${errorText(error)}`);
				}
			}
		}
	}

	let ready = loadImpl("startup");
	for (const relativeDir of MODULE_DIRS) {
		try {
			watchers.push(watch(join(sourceDir, relativeDir), (_event, filename) => {
				if (!live || (filename && !filename.endsWith(".mjs") && filename !== "standing-rules.md")) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					if (live) ready = ready.then(() => loadImpl(`watch:${filename ?? "?"}`));
				}, WATCH_DEBOUNCE_MS);
			}));
		} catch (error) {
			shellLog(`watcher failed, use /reload: ${errorText(error)}`);
		}
	}

	pi.on("session_start", async (event, ctx) => {
		try {
			await ready;
			await impl?.onSessionStart(event, ctx);
			if (!impl && ctx.hasUI) ctx.ui.notify(`virev failed to load. Read ${LOG_PATH}.`, "error");
		} catch (error) {
			shellLog(`session_start failed open: ${errorText(error)}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			await ready;
			return await impl?.onToolCall(event, ctx);
		} catch (error) {
			shellLog(`tool_call failed open: ${errorText(error)}`);
			return undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			await ready;
			return await impl?.onBeforeAgentStart(event, ctx);
		} catch (error) {
			shellLog(`before_agent_start failed open: ${errorText(error)}`);
			return undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			await ready;
			await impl?.onMessageEnd(event, ctx);
		} catch (error) {
			shellLog(`message_end failed open: ${errorText(error)}`);
		}
	});

	pi.on("session_shutdown", () => {
		live = false;
		if (timer) clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
		shellLog("watchers closed on session_shutdown");
	});

	pi.registerCommand("virev-reload", {
		description: "Reload extensions, skills, prompts, and themes",
		handler: async (_args, ctx) => {
			shellLog("virev-reload requested");
			await ctx.reload();
		},
	});
}
