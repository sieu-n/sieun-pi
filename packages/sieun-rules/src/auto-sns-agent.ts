import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, SHARE_ENV, threadId, Worker, workerData } from "node:worker_threads";
import type { ExtensionAPI, ToolCallEvent } from "prime-agent";
import { cellStart, cellSteps, type CellStep } from "./kernel-cwd.ts";
import { log } from "./log.ts";

/*
 * auto-sns-agent's repo guard for every Prime session, whatever its cwd. The rules live in that repo's
 * scripts/repo/agent/guards/ and judge each command by where it runs (cd, git -C, the push remote's URL), so a session
 * started in /Users/sieunpark that touches the checkout gets the rules a session started there gets.
 * On 2026-10-14 at 14:40Z a job started in /Users/sieunpark pushed sieun/dev from that checkout, and no guard loaded for it.
 * GLOBAL_RULES_AUTO_SNS_AGENT moves the checkout, so a test can point it at a fixture.
 */
export const CHECKOUT = process.env.GLOBAL_RULES_AUTO_SNS_AGENT || join(homedir(), "Documents/Github/auto-sns-agent");

type Verdict = { block: true; reason: string } | undefined;
type Ctx = { cwd?: string; sessionManager?: { getSessionId(): string | null | undefined } };
interface Adapter {
	registerRepoGuard(pi: { on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void }): void;
	onToolCall(event: Pick<ToolCallEvent, "toolName" | "input">, ctx: Ctx): Verdict;
}

/*
 * A worker process keeps every imported .mjs for its life, so a guard imported once stayed stale: c84c6c646e reached
 * us-metal02 at 08:46:35Z on 10-18, and sessions in the 26 workers started before it were refused named-file checks it
 * allows until about 11:00Z. Each call reads HEAD's commit id from .git (two small reads), and a new commit whose guard
 * tree changed imports a copy of that tree's blobs at <checkout>/.cache/repo-guard/<tree id>/guards/, a new URL, so
 * prime.mjs and every module it imports load fresh. Only landed guard code is live: on 10-18 at 11:48Z a session's unsaved
 * edit to the shared tree's guards/git.mjs dropped the hooks-off push check for every session. The copy sits four levels
 * below the checkout like the original, so the guards' REPO_ROOT still names the checkout.
 */
const GUARDS_PATH = "scripts/repo/agent/guards";
/*
 * git runs through execFile, never execFileSync: on 11-03 at 00:10:36Z a worker creating a session sat 7.8 s in this
 * file's sync git calls, and every session on that worker waited.
 */
const git = (...args: string[]): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		execFile("/usr/bin/git", ["-C", CHECKOUT, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
	});

/** HEAD's commit id, from .git/HEAD and its loose ref, else from git. */
async function headId(): Promise<string> {
	try {
		const head = readFileSync(join(CHECKOUT, ".git/HEAD"), "utf8").trim();
		return head.startsWith("ref: ") ? readFileSync(join(CHECKOUT, ".git", head.slice(5)), "utf8").trim() : head;
	} catch {
		return (await git("rev-parse", "--verify", "-q", "HEAD")).toString().trim();
	}
}

let snapshotting: { head: string; prime: Promise<string> } | null = null;

/** One snapshot per HEAD at a time, so concurrent events on a new commit share its git calls. */
function snapshotOnce(head: string): Promise<string> {
	if (snapshotting?.head === head) return snapshotting.prime;
	const prime = snapshot(head);
	snapshotting = { head, prime };
	prime.catch(() => {
		if (snapshotting?.prime === prime) snapshotting = null;
	});
	return prime;
}

let copies = 0;

/** The guard files HEAD holds, copied once per guard tree id; returns the copy's prime.mjs. */
async function snapshot(head: string): Promise<string> {
	const tree = (await git("rev-parse", `${head}:${GUARDS_PATH}`)).toString().trim();
	const dir = join(CHECKOUT, ".cache/repo-guard", tree.slice(0, 16));
	if (!existsSync(join(dir, "guards/prime.mjs"))) {
		const tmp = `${dir}.${process.pid}.${threadId}.${++copies}`;
		mkdirSync(join(tmp, "guards"), { recursive: true });
		for (const entry of (await git("ls-tree", "-z", tree)).toString().split("\0")) {
			const [meta, name] = entry.split("\t");
			const [, type, blob] = meta?.split(" ") ?? [];
			if (type !== "blob" || !name?.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
			writeFileSync(join(tmp, "guards", name), await git("cat-file", "blob", blob!));
		}
		try {
			renameSync(tmp, dir);
		} catch {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	return join(dir, "guards/prime.mjs");
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Guard = { adapter: Adapter; handlers: Map<string, Handler> };

let loaded: { head: string; prime: string; guard: Promise<Guard> } | null = null;

/** One guard version, imported and registered; a module that half ran throws here, so it never becomes the live guard. */
async function importGuard(prime: string): Promise<Guard> {
	const adapter = (await import(pathToFileURL(prime).href)) as Adapter;
	const handlers = new Map<string, Handler>();
	adapter.registerRepoGuard({ on: (name, handler) => handlers.set(name, handler) });
	return { adapter, handlers };
}

/*
 * The guard as HEAD holds it now. A version that fails to read, import or register keeps the last one that loaded.
 * A guard copy is imported once per session: under Prime's jiti a second import() of a copy whose first import threw
 * returns the half-run prime.mjs, whose imports are undefined. On 10-29 from 17:35Z auto-sns-agent's c8a05742e8 guard
 * could not load from its copy, each later commit re-imported that copy, and every tool call failed with
 * "undefined is not an object (evaluating '_log.LOG_FILE')" on both hosts.
 */
async function loadGuard(): Promise<Guard> {
	try {
		const head = await headId();
		if (loaded?.head === head) return await loaded.guard;
		const prime = await snapshotOnce(head);
		if (loaded?.head === head) return await loaded.guard;
		if (loaded?.prime === prime) {
			loaded = { ...loaded, head };
			return await loaded.guard;
		}
		const fallback = loaded?.guard;
		const guard = importGuard(prime).catch(error => fallback ?? Promise.reject(error));
		loaded = { head, prime, guard };
		return await guard;
	} catch (error) {
		if (!loaded) throw error;
		return await loaded.guard;
	}
}

/** The handlers the guard registers now, by event name. */
async function handlers(): Promise<Map<string, Handler>> {
	return (await loadGuard()).handlers;
}

/** Registers the repo guard, which follows HEAD's guard files at each event. A load error reaches index.ts, which logs it. */
export async function register(pi: Pick<ExtensionAPI, "on">): Promise<void> {
	if (!existsSync(CHECKOUT)) return;
	const target = pi as unknown as { on(name: string, handler: Handler): void };
	for (const name of (await handlers()).keys()) {
		target.on(name, async (event, ctx) => {
			const ask = offLoopAsk(name, event, ctx);
			if (ask) {
				const answer = await askWorker(ask);
				if (answer.ok) return answer.verdict;
			}
			return judgeOnLoop(name, event, ctx);
		});
	}
}

async function judgeOnLoop(name: string, event: unknown, ctx: unknown): Promise<unknown> {
	const handler = (await handlers()).get(name);
	return name === "tool_call" ? judgeWhereItRuns(handler, event, ctx) : handler?.(event, ctx);
}

/*
 * The guard's bash and ipython judging runs on a worker thread. In pi-host one process hosts every session, and the guard's sync work
 * held its loop for all of them: on 11-24 at 12:41:17Z a judge held it 1313 ms, in a spawn of git log per path (403 ms), a read of the
 * never-pruned 138 MB write journal (396 ms) and a regex over it (work/pi-host-stalls/u-repo-guard/report.md). The worker loads the same
 * HEAD guard copy with this file's loadGuard and gets a plain copy of the event, the cwd of each cell part and the session's id and file,
 * which is all the guard's callerOf reads from ctx. tool_result goes there too, since the guard keeps a call's warn note in its own module
 * until that call's result. Other tools and events stay on the loop, where the guard answers them at once.
 */
type Caller = { cwd: string | null; sessionId: string | null; sessionFile: string | null };
type Ask = { name: string; event: unknown; caller: Caller; steps: CellStep[] | null };
type Answer = { ok: true; verdict: unknown } | { ok: false };
type Reply = { id: number; verdict: unknown } | { id: number; error: string };

const OFF_LOOP_EVENTS = new Set(["tool_call", "tool_result"]);
const OFF_LOOP_TOOLS = new Set(["bash", "ipython"]);
const WORKER_MARK = "sieun-rules auto-sns-agent repo guard";

/** The question for the worker, or null for an event the loop judges. A stale ctx throws on every read, as the guard's own read() expects. */
function offLoopAsk(name: string, event: unknown, ctx: unknown): Ask | null {
	const call = event as { toolName?: unknown; input?: { code?: unknown } } | null | undefined;
	if (!OFF_LOOP_EVENTS.has(name) || typeof call?.toolName !== "string" || !OFF_LOOP_TOOLS.has(call.toolName)) return null;
	const c = ctx as { cwd?: string; sessionManager?: { getSessionId(): string | null; getSessionFile(): string | null } };
	const read = <T>(get: () => T | undefined): T | null => {
		try {
			return get() ?? null;
		} catch {
			return null;
		}
	};
	const caller = { cwd: read(() => c.cwd), sessionId: read(() => c.sessionManager!.getSessionId()), sessionFile: read(() => c.sessionManager!.getSessionFile()) };
	const split = name === "tool_call" && call.toolName === "ipython" && typeof call.input?.code === "string" && !!ctx && typeof ctx === "object";
	return { name, event, caller, steps: split ? cellSteps(call.input!.code as string, cellStart(ctx)) : null };
}

/** The worker's half: the same judging as judgeWhereItRuns, with ctx rebuilt from the caller. */
async function judgeAsk({ name, event, caller, steps }: Ask): Promise<unknown> {
	const handler = (await handlers()).get(name);
	if (!handler) return undefined;
	const ctxAt = (cwd: string | null) => ({ cwd: cwd ?? undefined, sessionManager: { getSessionId: () => caller.sessionId, getSessionFile: () => caller.sessionFile } });
	if (!steps) return handler(event, ctxAt(caller.cwd));
	const call = event as { input: Record<string, unknown> };
	for (const step of steps) {
		const verdict = (await handler({ ...call, input: { ...call.input, code: step.code } }, ctxAt(step.cwd))) as { block?: boolean } | undefined;
		if (verdict?.block) return verdict;
	}
	return undefined;
}

if (!isMainThread && workerData === WORKER_MARK && parentPort) {
	const port = parentPort;
	port.on("message", async ({ id, ask }: { id: number; ask: Ask }) => {
		let reply: Reply;
		try {
			reply = { id, verdict: await judgeAsk(ask) };
		} catch (error) {
			reply = { id, error: error instanceof Error ? error.message : String(error) };
		}
		port.postMessage(reply);
	});
}

type Waiter = (reply: Reply | { error: string }) => void;
let worker: Worker | undefined;
/** Set when the worker failed before its first answer, so this runtime cannot run it and every call stays on the loop. */
let noWorker = false;
let answered = false;
let nextId = 0;
const waiting = new Map<number, Waiter>();

function failAll(error: string): void {
	worker = undefined;
	if (!answered) noWorker = true;
	log("auto-sns-agent", `the repo guard's worker failed (${error}), so ${noWorker ? "every call in this process" : "its waiting calls"} will be judged on the loop`);
	for (const waiter of waiting.values()) waiter({ error });
	waiting.clear();
}

function started(): Worker {
	if (worker) return worker;
	const fresh = new Worker(new URL(import.meta.url), { workerData: WORKER_MARK, env: SHARE_ENV });
	fresh.unref();
	fresh.on("message", (reply: Reply) => {
		answered = true;
		const waiter = waiting.get(reply.id);
		waiting.delete(reply.id);
		if (!waiting.size) fresh.unref();
		waiter?.(reply);
	});
	fresh.on("error", error => worker === fresh && failAll(error.message));
	fresh.on("exit", code => worker === fresh && failAll(`exited with code ${code}`));
	worker = fresh;
	return fresh;
}

/** The worker's verdict, or ok: false when the loop must judge: no worker here, the worker failed, or the guard threw there. */
async function askWorker(ask: Ask): Promise<Answer> {
	if (noWorker) return { ok: false };
	const id = nextId++;
	let target: Worker;
	try {
		target = started();
	} catch (error) {
		failAll(error instanceof Error ? error.message : String(error));
		return { ok: false };
	}
	const reply = await new Promise<Reply | { error: string }>(resolve => {
		waiting.set(id, resolve);
		try {
			target.ref();
			target.postMessage({ id, ask });
		} catch (error) {
			waiting.delete(id);
			resolve({ id, error: error instanceof Error ? error.message : String(error) });
		}
	});
	if (!("error" in reply)) return { ok: true, verdict: reply.verdict };
	if ("id" in reply) log("auto-sns-agent", `the repo guard's worker did not judge a ${ask.name} (${reply.error}), so the loop judges it`);
	return { ok: false };
}

/**
 * The guard reads ctx.cwd, which Prime sets to the cwd the session started in. An ipython cell runs from the kernel's cwd and moves
 * with each os.chdir in it, so each part of the cell goes to the guard with the cwd it runs in (kernel-cwd.ts). A bash call follows
 * its own cd and git -C in the guard's shell walk.
 */
async function judgeWhereItRuns(handler: Handler | undefined, event: unknown, ctx: unknown): Promise<unknown> {
	const call = event as { toolName?: string; input?: { code?: unknown } };
	if (!handler || call?.toolName !== "ipython" || typeof call.input?.code !== "string" || !ctx || typeof ctx !== "object") return handler?.(event, ctx);
	for (const step of cellSteps(call.input.code, cellStart(ctx))) {
		const at = new Proxy(ctx, { get: (target, key) => (key === "cwd" ? step.cwd : Reflect.get(target, key)) });
		const verdict = (await handler({ ...call, input: { ...call.input, code: step.code } }, at)) as { block?: boolean } | undefined;
		if (verdict?.block) return verdict;
	}
	return undefined;
}

/** A root session's kernel has RLM_SESSION_DIR=<artifacts>/<session id>; a subagent's ends in sub-<n> and is never the release owner. */
export function sessionIdOf(sessionDir: string | undefined): string | null {
	const name = sessionDir ? basename(sessionDir) : "";
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ? name : null;
}

/**
 * The kernel half: send-check.ts runs this for a git write or a local check a Python kernel starts, with the kernel's
 * real cwd and the command's expanded text, which the tool_call text cannot show after an os.chdir or an f-string.
 */
export async function judgeKernelShell(text: string, cwd: string, sessionDir: string | undefined): Promise<Verdict> {
	if (!existsSync(CHECKOUT)) return undefined;
	const { adapter } = await loadGuard();
	const id = sessionIdOf(sessionDir);
	return adapter.onToolCall({ toolName: "bash", input: { command: text } }, { cwd, sessionManager: { getSessionId: () => id } });
}
