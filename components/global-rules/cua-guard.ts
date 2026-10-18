import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { Verdict } from "./guard.ts";
import { enabled } from "./log.ts";
import { checkOwnerOk } from "./send-guard.ts";
import { recordSend, sendReason, sessionOf } from "./send-log.ts";
import { effective, expandVars, lex, stripHeredocs } from "./shell.ts";

/*
 * The cua-driver MCP guard (owner correction c37): a desktop click or key press that sends mail or a message goes through only with the owner's
 * approved For you todo, passed as `owner_ok: "<chat id>/<todo id>"`. Run as a stdio proxy in front of `cua-driver mcp`
 * (`node cua-guard.ts <cua-driver> mcp`): it reads every tools/call, remembers what each snapshot element is, and refuses a send.
 */

export interface Element { label: string; role: string; frame?: { x: number; y: number; w: number; h: number } }
export interface CuaContext {
	/** The target app's bundle id, when known. */
	bundle?: string;
	/** Titles of the target window, or of the app's windows when the call names no window. */
	titles: string[];
	/** The element an element_token names, when it came from a snapshot this guard saw. */
	element?: Element;
	/** Elements of the target window's last snapshot, for a click by coordinates. */
	snapshot?: Element[];
	/** Screen point of the window's top-left corner; snapshot frames are in screen points and a click's x, y is window-local. */
	origin?: { x: number; y: number };
	/** A desktop call whose window the guard could not find: its click is checked against every snapshot it has seen. */
	unknown?: boolean;
}

/** An on-screen window from cua-driver's list_windows, with bounds in screen points. */
export interface ScreenWindow { pid: number; window_id: number; title: string; app_name: string; bounds: { x: number; y: number; width: number; height: number }; z_index: number | null }
/** What a desktop call lands on: screenshot pixels per screen point, and the on-screen windows. */
export interface Desktop { scale: number; windows: ScreenWindow[] }

const MAIL_APPS = /^(?:com\.apple\.mail|com\.microsoft\.Outlook|com\.readdle\.smartemail-Mac|it\.bloop\.airmail2|org\.mozilla\.thunderbird|com\.mimestream\.Mimestream|com\.superhuman\.electron|com\.hey\.app\.desktop|io\.canarymail\.mac|com\.postbox-inc\.postbox|thunderbird|betterbird|evolution|geary|mailspring)$/i;
const MESSAGE_APPS = /^(?:com\.apple\.MobileSMS|com\.tinyspeck\.slackmacgap|com\.kakao\.KakaoTalkMac|ru\.keepcoder\.Telegram|org\.telegram\.desktop|net\.whatsapp\.WhatsApp|desktop\.WhatsApp|com\.hnc\.Discord|com\.microsoft\.teams2?|jp\.naver\.line\.mac|org\.whispersystems\.signal-desktop|com\.facebook\.archon(?:\.developerID)?|slack|discord|telegram-desktop|signal-desktop|whatsapp-for-linux|teams-for-linux|element-desktop)$/i;
const MAIL_TITLE = /\bGmail\b|\bOutlook\b|\bInbox\b|\bCompose\b|\bNew Message\b|\bTickets?\b|\bSupport\b|Zendesk|Freshdesk|Help ?desk|viewticket|Client Area|Intercom|Help Scout|\bContact\b|Submit a request|Help Center|\/ X\b|\bTwitter\b|\bLinkedIn\b|\bMessenger\b|\bDiscord\b|\bWhatsApp\b|\bTelegram\b/i;
const SEND_LABEL = /^(?:send(?!\s+(?:to|backward|backwards|feedback|to back)\b)\b|submit\b|post(?: reply| all)?$|tweet(?: all)?$|add reply|update ticket|reply and submit|보내기|전송|送信|게시)/i;
const STRICT_SEND_LABEL = /^(?:send(?!\s+(?:to|backward|backwards|feedback|to back)\b)\b|보내기|전송|送信)/i;
const MOD = /^(?:cmd|command|meta|super|ctrl|control)$/i;
const RETURN = /^(?:return|enter|kp_?enter|\n)$/i;

const ACTIONS = new Set(["click", "double_click", "press_key", "hotkey", "invoke_menu", "set_value", "type_text"]);
const BATCHES = new Set(["replay_trajectory", "run_steps", "run_script"]);
export const isAction = (tool: string): boolean => ACTIONS.has(tool) || BATCHES.has(tool);

function kind(ctx: CuaContext): "mail" | "message" | "marked" | "unknown" | "other" {
	if (ctx.unknown) return "unknown";
	if (ctx.bundle && MAIL_APPS.test(ctx.bundle)) return "mail";
	if (ctx.bundle && MESSAGE_APPS.test(ctx.bundle)) return "message";
	if (ctx.titles.some((title) => MAIL_TITLE.test(title))) return "marked";
	return "other";
}

/** The smallest snapshot element whose frame holds the point, read at 1x and 2x since a screenshot can be in device pixels. */
function hit(snapshot: Element[], x: number, y: number, origin = { x: 0, y: 0 }): Element | undefined {
	const inside = (e: Element, s: number) => {
		const px = origin.x + x / s;
		const py = origin.y + y / s;
		return !!e.frame && px >= e.frame.x && px <= e.frame.x + e.frame.w && py >= e.frame.y && py <= e.frame.y + e.frame.h;
	};
	return snapshot.filter((e) => e.label && (inside(e, 1) || inside(e, 2)) && SEND_LABEL.test(e.label.trim())).sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h)[0];
}

/** Why this cua-driver call sends mail or a message, or null. Pure: the context says what the target is. */
export function judgeCua(tool: string, args: Record<string, unknown>, ctx: CuaContext): string | null {
	const where = kind(ctx);
	const app = ctx.bundle ?? (where === "unknown" ? "a window the guard could not identify" : "this app");
	const sendable = where !== "other";
	const sendName = (label: string) => (sendable ? SEND_LABEL : STRICT_SEND_LABEL).test(label.trim());
	if (tool === "click" || tool === "double_click" || tool === "set_value") {
		if (ctx.element) return sendName(ctx.element.label) ? `it presses "${ctx.element.label.trim()}" in ${app}` : null;
		if (!sendable) return null;
		if (typeof args.element_token === "string") return `it presses an element this guard has not seen in ${app}; take get_window_state first so the guard can read the element`;
		if (typeof args.x === "number" && typeof args.y === "number") {
			if (!ctx.snapshot) return where === "unknown" ? null : `it clicks by coordinates in ${app} with no snapshot of the window; take get_window_state first so the guard can see what the click hits`;
			const target = hit(ctx.snapshot, args.x, args.y, ctx.origin);
			return target ? `the click lands on "${target.label.trim()}" in ${app}` : null;
		}
		return null;
	}
	if (tool === "invoke_menu") {
		const path = Array.isArray(args.path) ? args.path.map(String) : [];
		const last = path.at(-1) ?? "";
		return /^send\b|^보내기|^전송/i.test(last.trim()) ? `it runs the menu item ${path.join(" > ")} in ${app}` : null;
	}
	if (tool === "type_text") {
		return where === "message" && /[\r\n]/.test(String(args.text ?? "")) ? `typing a line break sends the message in ${app}` : null;
	}
	if (tool === "hotkey" || tool === "press_key") {
		const keys = tool === "hotkey" ? (Array.isArray(args.keys) ? args.keys.map(String) : []) : [String(args.key ?? ""), ...(Array.isArray(args.modifiers) ? args.modifiers.map(String) : [])];
		const lower = keys.map((k) => k.toLowerCase());
		const mod = lower.some((k) => MOD.test(k));
		const shift = lower.includes("shift");
		const ret = lower.some((k) => RETURN.test(k));
		if ((where === "mail" || where === "unknown") && lower.some((k) => /^(?:cmd|command|meta)$/.test(k)) && shift && lower.includes("d")) return `Cmd+Shift+D sends the message in ${app}`;
		if (sendable && mod && ret) return `${keys.join("+")} sends in ${app}`;
		if (where === "message" && ret && !shift && !mod) return `Return sends the message in ${app}`;
		return null;
	}
	return null;
}

export const OWNER_OK_HELP =
	"An email or a message goes out only after the owner approves it (correction c37). Leave the draft unsent, and add a For you todo on your chat's board " +
	'that quotes the draft and the recipient, with choices such as "Send it" / "Not yet". After the owner approves it, call again with ' +
	'owner_ok: "<chat id>/<todo id>" in the tool arguments. Reading, typing into a draft, and other clicks stay allowed.';

/** The refusal text for a call, or null when it may run: no send, or a send with an approved owner_ok. */
export function decide(tool: string, args: Record<string, unknown>, ctx: CuaContext, approve: (token: string) => string | null = checkOwnerOk): string | null {
	if (!enabled("GLOBAL_RULES_GUARD")) return null;
	const reason = judgeCua(tool, args, ctx);
	if (!reason) return null;
	const token = typeof args.owner_ok === "string" ? args.owner_ok : null;
	if (!token) return `cua-driver send guard: refused, because ${reason}. ${OWNER_OK_HELP}`;
	const why = approve(token);
	return why === null ? null : `cua-driver send guard: refused, because ${reason}, and owner_ok=${token} does not count: ${why.replace(/\.$/, "")}. ${OWNER_OK_HELP}`;
}

/** The bundle id of a running pid, through lsappinfo, or its executable name on Linux; undefined when it cannot tell. */
export function bundleOf(pid: unknown): string | undefined {
	if (typeof pid !== "number") return undefined;
	if (process.platform === "linux") {
		try {
			return basename(readlinkSync(`/proc/${pid}/exe`));
		} catch {
			return undefined;
		}
	}
	try {
		return execFileSync("lsappinfo", ["info", "-only", "bundleid", String(pid)], { encoding: "utf8", timeout: 3000 }).match(/bundleID="([^"]+)"/)?.[1];
	} catch {
		return undefined;
	}
}

/** The pid and window a call aims at: its own pid and window_id, else a nested `target: {kind: "window", pid, window_id}`. */
export function aim(args: Record<string, unknown>): { pid?: number; window?: number } {
	const target = args.target as { kind?: unknown; pid?: unknown; window_id?: unknown } | null | undefined;
	const nested = target?.kind === "window" ? target : undefined;
	const pid = typeof args.pid === "number" ? args.pid : typeof nested?.pid === "number" ? nested.pid : undefined;
	const window = typeof args.window_id === "number" ? args.window_id : typeof nested?.window_id === "number" ? nested.window_id : undefined;
	return { pid, window };
}

/** A call aimed at the desktop: `scope: "desktop"` or `target: {kind: "desktop"}`, with no pid of its own. */
export function onDesktop(args: Record<string, unknown>): boolean {
	const target = args.target as { kind?: unknown } | null | undefined;
	return args.pid === undefined && (args.scope === "desktop" || target?.kind === "desktop");
}

/** The on-screen windows through the cua-driver CLI; undefined when it cannot tell. */
export function desktopOf(cli: string): Desktop | undefined {
	try {
		const call = (tool: string, args: Record<string, unknown>) => JSON.parse(execFileSync(cli, ["call", tool, JSON.stringify(args)], { encoding: "utf8", timeout: 5000 }));
		const screen = call("get_screen_size", {}) as { scale_factor?: number };
		const list = call("list_windows", { on_screen_only: true }) as { windows?: ScreenWindow[] };
		return { scale: Number(screen.scale_factor) || 1, windows: list.windows ?? [] };
	} catch {
		return undefined;
	}
}

/** What the proxy has seen: snapshot elements by token and by window, window titles, and the last desktop capture's pixels per point. */
export class Seen {
	tokens = new Map<string, { element: Element; pid: number; window: number; title: string }>();
	windows = new Map<string, { title: string; elements: Element[]; origin?: { x: number; y: number } }>();
	titles = new Map<number, Map<number, string>>();
	desktopScale?: number;

	record(tool: string, args: Record<string, unknown>, result: unknown): void {
		const data = structured(result);
		if (!data) return;
		if (tool === "get_window_state" && Array.isArray(data.elements)) {
			const pid = Number(data.pid ?? args.pid);
			const window = Number(data.window_id ?? args.window_id);
			const title = String(data.window_title ?? "");
			const elements: Element[] = [];
			for (const raw of data.elements as Record<string, unknown>[]) {
				const element: Element = { label: String(raw.label ?? raw.title ?? ""), role: String(raw.role ?? ""), frame: raw.frame as Element["frame"] };
				elements.push(element);
				if (typeof raw.element_token === "string") this.tokens.set(raw.element_token, { element, pid, window, title });
			}
			const bounds = (data.window_bounds ?? elements.find((e) => e.role === "AXWindow")?.frame) as { x?: number; y?: number } | undefined;
			const origin = typeof bounds?.x === "number" && typeof bounds.y === "number" ? { x: bounds.x, y: bounds.y } : undefined;
			this.windows.set(`${pid}:${window}`, { title, elements, origin });
			this.title(pid, window, title);
		}
		if (tool === "get_desktop_state" && typeof data.scale_factor === "number") {
			const shrink = typeof data.screenshot_original_width === "number" && typeof data.screenshot_width === "number" ? data.screenshot_width / data.screenshot_original_width : 1;
			this.desktopScale = data.scale_factor * shrink;
		}
		if (tool === "list_windows" && Array.isArray(data.windows)) {
			for (const w of data.windows as Record<string, unknown>[]) this.title(Number(w.pid), Number(w.window_id), String(w.title ?? ""));
		}
	}

	title(pid: number, window: number, title: string): void {
		if (!this.titles.has(pid)) this.titles.set(pid, new Map());
		this.titles.get(pid)!.set(window, title);
	}

	context(args: Record<string, unknown>, bundle = bundleOf): CuaContext {
		const token = typeof args.element_token === "string" ? this.tokens.get(args.element_token) : undefined;
		const aimed = aim(args);
		const pid = aimed.pid ?? token?.pid;
		const window = aimed.window ?? token?.window;
		const snap = pid !== undefined && window !== undefined ? this.windows.get(`${pid}:${window}`) : undefined;
		const known = pid !== undefined ? this.titles.get(pid) : undefined;
		const titles = window !== undefined && known?.has(window) ? [known.get(window)!] : [...(known?.values() ?? [])];
		if (token?.title) titles.push(token.title);
		return { bundle: bundle(pid), titles, element: token?.element, snapshot: snap?.elements, origin: snap?.origin };
	}

	/**
	 * The arguments and context to judge a call by. A desktop call is re-aimed at the frontmost window under its point, or at the front window for a key press,
	 * with x, y turned into window-local points. The driver's own cursor overlay is skipped. When the windows cannot be read, its click is checked against every snapshot seen so far.
	 */
	resolve(args: Record<string, unknown>, bundle = bundleOf, desktop: () => Desktop | undefined = () => desktopOf("cua-driver")): { args: Record<string, unknown>; ctx: CuaContext } {
		if (!onDesktop(args)) return { args, ctx: this.context(args, bundle) };
		const screen = desktop();
		const scale = this.desktopScale ?? screen?.scale ?? 2;
		const point = typeof args.x === "number" && typeof args.y === "number" ? { x: args.x / scale, y: args.y / scale } : undefined;
		if (!screen) {
			const snapshot = [...this.windows.values()].flatMap((w) => w.elements);
			return { args: { ...args, ...point }, ctx: { titles: [], unknown: true, snapshot: snapshot.length ? snapshot : undefined } };
		}
		const contains = (w: ScreenWindow) => !!point && point.x >= w.bounds.x && point.x <= w.bounds.x + w.bounds.width && point.y >= w.bounds.y && point.y <= w.bounds.y + w.bounds.height;
		const front = screen.windows.filter((w) => w.app_name !== "Cua Driver").sort((a, b) => (b.z_index ?? -1) - (a.z_index ?? -1));
		const window = point ? front.find(contains) : front[0];
		if (!window) return { args, ctx: { titles: [] } };
		const aimed = { ...args, scope: undefined, target: undefined, pid: window.pid, window_id: window.window_id, ...(point && { x: point.x - window.bounds.x, y: point.y - window.bounds.y }) };
		const ctx = this.context(aimed, bundle);
		const titles = [window.title, ...screen.windows.filter((w) => w.pid === window.pid && w !== window).map((w) => w.title)].filter(Boolean);
		return { args: aimed, ctx: { ...ctx, titles: [...new Set([...ctx.titles, ...titles])], origin: { x: window.bounds.x, y: window.bounds.y } } };
	}
}

function structured(result: unknown): Record<string, unknown> | null {
	const r = result as { structuredContent?: unknown; content?: { type: string; text?: string }[] } | undefined;
	if (r?.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Record<string, unknown>;
	for (const block of r?.content ?? []) {
		if (block.type !== "text" || !block.text?.trim().startsWith("{")) continue;
		try {
			return JSON.parse(block.text) as Record<string, unknown>;
		} catch {
			// Not JSON; keep looking.
		}
	}
	return null;
}

/** The actions a recorded trajectory would replay: each turn-NNNNN/action.json as {tool, args}. */
export function trajectoryActions(dir: string): { tool: string; args: Record<string, unknown> }[] {
	const out: { tool: string; args: Record<string, unknown> }[] = [];
	for (const turn of readdirSync(dir).filter((name) => name.startsWith("turn-")).sort()) {
		try {
			const action = JSON.parse(readFileSync(join(dir, turn, "action.json"), "utf8")) as Record<string, unknown>;
			const tool = String(action.tool ?? action.name ?? "");
			const args = (action.arguments ?? action.args ?? action.input ?? {}) as Record<string, unknown>;
			out.push({ tool, args });
		} catch {
			out.push({ tool: "unreadable", args: {} });
		}
	}
	return out;
}

/** Judges one tools/call against what the proxy has seen. A replay is judged turn by turn. */
export function decideCall(seen: Seen, tool: string, args: Record<string, unknown>, bundle = bundleOf, approve = checkOwnerOk, desktop = () => desktopOf("cua-driver")): string | null {
	if (tool === "replay_trajectory") {
		let turns: { tool: string; args: Record<string, unknown> }[];
		try {
			turns = trajectoryActions(String(args.dir ?? ""));
		} catch {
			return null;
		}
		for (const turn of turns) {
			const aimed = seen.resolve(turn.args, bundle, desktop);
			const why = decide(turn.tool, { ...aimed.args, owner_ok: args.owner_ok }, aimed.ctx, approve);
			if (why) return why.replace("because ", "because a replayed turn: ");
		}
		return null;
	}
	if (tool === "run_steps") {
		const window = Object.fromEntries(["pid", "window_id", "app", "window"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
		for (const step of Array.isArray(args.steps) ? (args.steps as { tool?: unknown; args?: Record<string, unknown> }[]) : []) {
			const inner = String(step?.tool ?? "");
			if (BATCHES.has(inner)) {
				const why = decideCall(seen, inner, { ...window, ...(step.args ?? {}), owner_ok: args.owner_ok }, bundle, approve, desktop);
				if (why) return why.replace("because ", "because a run_steps step: ");
				continue;
			}
			if (!ACTIONS.has(inner)) continue;
			const aimed = seen.resolve({ ...window, ...(step.args ?? {}) }, bundle, desktop);
			const why = decide(inner, { ...aimed.args, owner_ok: args.owner_ok }, aimed.ctx, approve);
			if (why) return why.replace("because ", "because a run_steps step: ");
		}
		return null;
	}
	if (tool === "run_script") {
		if (!enabled("GLOBAL_RULES_GUARD")) return null;
		const reason = "run_script drives apps from JavaScript this guard cannot read step by step; use run_steps or the single action tools";
		const token = typeof args.owner_ok === "string" ? args.owner_ok : null;
		const why = token ? approve(token) : "no owner_ok";
		return why === null ? null : `cua-driver send guard: refused, because ${reason}. ${OWNER_OK_HELP}`;
	}
	if (!ACTIONS.has(tool)) return null;
	const aimed = seen.resolve(args, bundle, desktop);
	return decide(tool, aimed.args, aimed.ctx, approve);
}

/** Window titles of a pid through the cua-driver CLI, for a `cua-driver call` in a shell. */
function cliTitles(cli: string, pid: unknown): string[] {
	if (typeof pid !== "number") return [];
	try {
		const out = execFileSync(cli, ["call", "list_windows", JSON.stringify({ pid })], { encoding: "utf8", timeout: 5000 });
		return ((JSON.parse(out) as { windows?: { title?: string }[] }).windows ?? []).map((w) => String(w.title ?? ""));
	} catch {
		return [];
	}
}

/** `cua-driver call <tool> '<json>'` in shell text: a send verdict for each call that would send. guard.ts lifts it with an approved OWNER_OK. */
export function judgeCuaShell(text: string, bundle = bundleOf, titles = cliTitles, desktop = desktopOf): Verdict[] {
	const out: Verdict[] = [];
	if (!enabled("GLOBAL_RULES_GUARD")) return out;
	const vars = new Map<string, string>();
	const walk = (command: string, depth: number) => {
		if (depth > 4) return;
		const { commands, nested } = lex(command);
		for (const argv of expandVars(commands, vars)) {
			const eff = effective(argv);
			if (!/(?:^|\/)cua-driver$/.test(eff[0] ?? "") || eff[1] !== "call" || !isAction(eff[2] ?? "")) continue;
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(eff[3] ?? "{}");
			} catch {
				// Unparsed arguments leave only what the tool name says.
			}
			const seen = new Seen();
			const cli = eff[0];
			const { pid } = aim(args);
			const aimed = onDesktop(args) ? seen.resolve(args, bundle, () => desktop(cli)) : { args, ctx: { bundle: bundle(pid), titles: titles(cli, pid) } };
			const reason = BATCHES.has(eff[2] ?? "") ? decideCall(seen, eff[2], { ...args, owner_ok: undefined }, bundle, () => "no", () => desktop(cli)) : judgeCua(eff[2], aimed.args, aimed.ctx);
			if (reason) out.push({ rule: "send", command: eff.join(" "), reason: `cua-driver send guard: refused, because ${reason.replace(/^cua-driver send guard: refused, because /, "")}. ${OWNER_OK_HELP.replace('owner_ok: "<chat id>/<todo id>" in the tool arguments', "OWNER_OK=<chat id>/<todo id> before the command")}` });
		}
		for (const inner of nested) walk(inner, depth + 1);
	};
	walk(stripHeredocs(text), 0);
	return out;
}

function addOwnerOk(result: { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] }): void {
	for (const tool of result.tools ?? []) {
		if (!isAction(tool.name) || !tool.inputSchema) continue;
		tool.inputSchema.properties = { ...(tool.inputSchema.properties ?? {}), owner_ok: { type: "string", description: "<chat id>/<todo id> of the owner's approved For you todo; needed only for a click or key press that sends mail or a message." } };
	}
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (!command) throw new Error("usage: node cua-guard.ts <cua-driver path> mcp");
	const child = spawn(command, rest, { stdio: ["pipe", "pipe", "inherit"] });
	const seen = new Seen();
	const pending = new Map<string, { tool?: string; args?: Record<string, unknown>; list?: boolean }>();
	const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
	createInterface({ input: child.stdout! }).on("line", (line) => {
		try {
			const message = JSON.parse(line) as { id?: string | number; result?: Record<string, unknown> };
			const sent = message.id !== undefined ? pending.get(String(message.id)) : undefined;
			if (sent) {
				pending.delete(String(message.id));
				if (sent.list && message.result) addOwnerOk(message.result);
				if (sent.tool && message.result) seen.record(sent.tool, sent.args ?? {}, message.result);
				process.stdout.write(`${JSON.stringify(message)}\n`);
				return;
			}
		} catch {
			// Pass through anything that is not JSON.
		}
		process.stdout.write(`${line}\n`);
	});
	createInterface({ input: process.stdin }).on("line", (line) => {
		let message: { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
		try {
			message = JSON.parse(line);
		} catch {
			child.stdin!.write(`${line}\n`);
			return;
		}
		if (message.method === "tools/list" && message.id !== undefined) pending.set(String(message.id), { list: true });
		if (message.method === "tools/call" && message.params?.name) {
			const tool = message.params.name;
			const args = message.params.arguments ?? {};
			let refusal: string | null = null;
			try {
				refusal = decideCall(seen, tool, args, bundleOf, checkOwnerOk, () => desktopOf(command));
			} catch (error) {
				refusal = isAction(tool) ? `cua-driver send guard could not judge this call (${error instanceof Error ? error.message : String(error)}); it is refused to be safe.` : null;
			}
			if (refusal) {
				recordSend({ decision: "refused", layer: "cua-driver", ...sessionOf(process.env.RLM_SESSION_DIR), target: `${tool} ${JSON.stringify(args).slice(0, 300)}`, reason: sendReason(refusal), ownerOk: typeof args.owner_ok === "string" ? args.owner_ok : null });
				write({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: refusal }] } });
				return;
			}
			if (typeof args.owner_ok === "string") {
				// An approved owner_ok on a call that sends: judged again with no token, which refuses only a send.
				let send: string | null = null;
				try {
					send = decideCall(seen, tool, { ...args, owner_ok: undefined }, bundleOf, () => "no", () => desktopOf(command));
				} catch {
					send = null;
				}
				if (send) recordSend({ decision: "allowed", layer: "cua-driver", ...sessionOf(process.env.RLM_SESSION_DIR), target: `${tool} ${JSON.stringify(args).slice(0, 300)}`, reason: sendReason(send), ownerOk: args.owner_ok });
			}
			if ("owner_ok" in args) {
				const { owner_ok: _, ...clean } = args;
				message.params.arguments = clean;
			}
			if (message.id !== undefined) pending.set(String(message.id), { tool, args });
		}
		child.stdin!.write(`${JSON.stringify(message)}\n`);
	});
	process.stdin.on("end", () => child.stdin!.end());
	child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1]?.endsWith("cua-guard.ts")) {
	main().catch((error) => {
		process.stderr.write(`cua-guard: ${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
}
