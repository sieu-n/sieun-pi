import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { judgeShellText, type Verdict } from "./guard.ts";
import { applyOwnerOk, httpSend, mcpSend, ownerOkToken, refusal } from "./send-guard.ts";
import { recordSend, sendReason, sessionOf } from "./send-log.ts";
import { judgeKernelShell } from "./auto-sns-agent.ts";

/*
 * The runtime half of the send guard (c37), the cap guard (c107), the Mac browser guard (c177) and auto-sns-agent's repo guard. kernel-guard.py runs this for a send or cap it sees at run time in the Python kernel:
 * a subprocess, an HTTP write or an MCP call whose text the tool_call guard could not read. It prints one JSON line,
 * {"block": false} or {"block": true, "reason": "..."}, and judges with the same rules as the tool_call guard.
 */

export type Check =
	| { kind: "shell"; text: string; cwd: string; approval?: string; repo?: boolean }
	| { kind: "http"; method: string; url: string; body?: string; approval?: string }
	| { kind: "mcp"; server: string; tool: string; args: string; approval?: string };

export function judgeCheck(check: Check, record = false): { block: false } | { block: true; reason: string } {
	const push = (what: string | null, command: string): Verdict[] =>
		what ? [{ rule: "send", command, reason: refusal(what) }] : [];
	const verdicts =
		check.kind === "shell"
			? judgeShellText(check.text, check.cwd).filter((v) => v.rule === "send" || v.rule === "cap" || v.rule === "browser")
			: check.kind === "http"
				? push(httpSend(check.method, check.url, check.body ?? ""), `${check.method} ${check.url}`)
				: push(mcpSend(check.server, check.tool, check.args), `mcp ${check.server} ${check.tool} ${check.args.slice(0, 300)}`);
	const approval = `${check.approval ?? ""}\n${check.kind === "shell" ? check.text : ""}`;
	const left = applyOwnerOk(verdicts, approval);
	if (record) {
		// The kernel's send-log line (c37), once per checked call, with the kernel's RLM_SESSION_DIR.
		const token = ownerOkToken(approval);
		for (const v of verdicts.filter((v) => v.rule === "send")) {
			const refused = left.some((l) => l.command === v.command);
			recordSend({ decision: refused ? "refused" : "allowed", layer: "kernel", ...sessionOf(process.env.RLM_SESSION_DIR), target: v.command, reason: sendReason(v.reason), ownerOk: token });
		}
	}
	return left.length ? { block: true, reason: left[0].reason } : { block: false };
}

/** A git write the kernel starts (`repo: true`) also goes through auto-sns-agent's repo guard with the kernel's real cwd. */
export async function judgeKernelCheck(check: Check): Promise<{ block: false } | { block: true; reason: string }> {
	const result = judgeCheck(check, true);
	if (result.block || check.kind !== "shell" || !check.repo) return result;
	return (await judgeKernelShell(check.text, check.cwd, process.env.RLM_SESSION_DIR)) ?? result;
}

/*
 * --serve judges one check per stdin line, {"id": n, "cwd": "...", "check": {...}}, and answers {"id": n, "block": ...} on one stdout line,
 * in order. It stays for kernels that loaded kernel-guard.py before --serve-socket, which live for hours. It exits after IDLE_MS (or argv[3] ms) with no check. A check that throws answers {"id": n, "error": ...}, which the kernel
 * lets through, as it lets through a one-shot run that prints nothing.
 * --serve-socket <path> answers the same lines on a unix socket for every process on the box whose rules and environment hash to that path
 * (kernel-guard.py Judge). Each line also carries the asking process's "env", which becomes process.env before the check, so the verdict,
 * the child processes a rule starts and the send-log line read that process's environment, as a fresh run in it would. On 10-18 each
 * kernel kept its own --serve judge, 88 of them at about 55 MB each. Checks run one at a time, since process.env and the cwd are shared.
 */
async function answer(line: string): Promise<string | null> {
	if (!line.trim()) return null;
	let id: unknown = null;
	try {
		const request = JSON.parse(line) as { id: unknown; cwd?: string; env?: Record<string, string>; check: Check };
		id = request.id;
		if (request.env) useEnv(request.env);
		if (request.cwd) {
			try {
				process.chdir(request.cwd);
			} catch {
				// A cwd that is gone leaves the last one; every rule reads check.cwd, not process.cwd().
			}
		}
		return `${JSON.stringify({ id, ...(await judgeKernelCheck(request.check)) })}\n`;
	} catch (error) {
		return `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`;
	}
}

/** Makes process.env exactly `env`. */
export function useEnv(env: Record<string, string>): void {
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
}

export async function serve(input: NodeJS.ReadableStream = process.stdin, write = (line: string) => process.stdout.write(line), idleMs = IDLE_MS): Promise<void> {
	const { createInterface } = await import("node:readline");
	// A judge with no check for idleMs exits, so an idle kernel does not hold its 55 to 65 MB; the next check starts a fresh one.
	let idle = setTimeout(() => process.exit(0), idleMs);
	for await (const line of createInterface({ input, crlfDelay: Infinity })) {
		clearTimeout(idle);
		idle = setTimeout(() => process.exit(0), idleMs);
		const out = await answer(line);
		if (out) write(out);
	}
	clearTimeout(idle);
}

/**
 * Serves `path` until no check came for idleMs, then removes the socket if it is still its own and exits. Resolves once it listens, or
 * false at once when another judge already answers on `path`.
 */
export async function serveSocket(path: string, idleMs = IDLE_MS, exit = () => process.exit(0)): Promise<boolean> {
	const { createConnection, createServer } = await import("node:net");
	const { createInterface } = await import("node:readline");
	const { rmSync, statSync } = await import("node:fs");
	const answers = await new Promise<boolean>((resolve) => {
		const probe = createConnection(path, () => { probe.destroy(); resolve(true); });
		probe.on("error", () => resolve(false));
	});
	if (answers) return false;
	rmSync(path, { force: true });
	let queue: Promise<unknown> = Promise.resolve();
	let idle: NodeJS.Timeout | undefined;
	let own = 0;
	const arm = () => {
		clearTimeout(idle);
		idle = setTimeout(() => {
			void queue.then(() => {
				try {
					if (statSync(path).ino === own) rmSync(path, { force: true });
				} catch {
					// Gone already.
				}
				server.close();
				exit();
			});
		}, idleMs);
	};
	const server = createServer((socket) => {
		socket.on("error", () => {});
		createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
			arm();
			queue = queue.then(() => answer(line)).then((out) => { if (out && !socket.destroyed) socket.write(out); }, () => {});
		});
	});
	const listening = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(path, () => resolve(true));
	});
	if (!listening) return false;
	own = statSync(path).ino;
	arm();
	return true;
}

const IDLE_MS = 120_000;

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	if (process.argv[2] === "--serve-socket" && process.argv[3]) {
		console.log = console.info = console.warn = console.error;
		if (!(await serveSocket(process.argv[3], Number(process.argv[4]) || IDLE_MS))) process.exit(0);
	} else if (process.argv[2] === "--serve") {
		// stdout carries only answers, so a stray console.log in a rule module cannot read as a verdict.
		console.log = console.info = console.warn = console.error;
		await serve(process.stdin, (line) => process.stdout.write(line), Number(process.argv[3]) || IDLE_MS);
	} else {
		const result = await judgeKernelCheck(JSON.parse(readFileSync(0, "utf8")) as Check);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
}
