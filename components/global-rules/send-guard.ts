import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PY_STRING, SHELLS, balancedSlice, effective, expandVars, lex, shellScript, stripHeredocs } from "./shell.ts";
import type { Verdict } from "./guard.ts";

/*
 * Outside sends (owner correction c37, 2026-10-10): an email or a vendor ticket reply goes out only after the owner approves it on a For you
 * todo. This guard reads tool-call text. The aside-browser skill holds the runtime check for Gmail and ticket pages in the browser.
 */

const MAIL_CLIS = new Set(["sendmail", "msmtp", "ssmtp", "swaks", "mailsend", "mailsend-go"]);
const MAIL_READERS = new Set(["mail", "mailx", "Mail", "nail", "s-nail"]);
const MUTTS = new Set(["mutt", "neomutt"]);
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie"]);
const HELP_ONLY = /^(?:-V|-h|--help|--version|-v|--serverinfo|-bp)$/;
const SEND_VERB = /^(?:send|reply|forward|sendemail|sendmail|send-message|send_message)$/i;
const MAIL_CLI_NAME = /gmail|^gog$|^gmi$|^gam$|^gyb$|outlook|^mailgun$|^sendgrid$|^resend$|^postmark$/i;
const TICKET_CLI_NAME = /zendesk|^zcli$|freshdesk|intercom|helpscout|^front$/i;
const TICKET_CLI_VERB = /^(?:reply|comment|respond|update|create|send)$/i;

const URL_TEXT = /\b(?:https?|smtps?):\/\/[^\s'"`)<>\\]+/gi;
const OWNER_OK = /\bOWNER_OK["']?\s*[=:]\s*["']?([\w-]+\/[\w-]+)/i;

interface TargetRow { label: string; host?: string; path?: string; flags?: string; body?: string; unless_path?: string; test_inbox?: string }

/** The send targets, shared with kernel-guard.py so a run-time check needs no Node process. */
const TARGETS = (JSON.parse(readFileSync(join(dirname(realpathSync(fileURLToPath(import.meta.url))), "send-targets.json"), "utf8")) as TargetRow[]).map((row) => ({
	label: row.label,
	host: row.host ? new RegExp(row.host) : null,
	path: row.path ? new RegExp(row.path, row.flags) : null,
	body: row.body ? new RegExp(row.body) : null,
	unlessPath: row.unless_path ? new RegExp(row.unless_path) : null,
	testInbox: row.test_inbox ?? null,
}));

/** Where a URL sends to, when a write to it is an email, a ticket reply or a message to someone outside. */
export function sendTarget(url: string, body = ""): string | null {
	const m = url.match(/^(https?|smtps?):\/\/([^/:?#]+)(?::\d+)?([^?#]*)/i);
	if (!m) return null;
	const [, scheme, rawHost, path] = m;
	const host = rawHost.toLowerCase();
	if (/^smtps?$/i.test(scheme)) return `SMTP server ${host}`;
	if (/^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/.test(host)) return null;
	const row = TARGETS.find(
		(t) =>
			(!t.host || t.host.test(host)) &&
			(!t.path || t.path.test(path)) &&
			(!t.body || t.body.test(body)) &&
			!t.unlessPath?.test(path) &&
			!(t.testInbox && onlyTestInboxes(body, t.testInbox)),
	);
	return row ? row.label.replace("{host}", host) : null;
}

const RECIPIENT_FIELD = /(?<![\w$-])\\?["']?(?:to|cc|bcc)\\?["']?[^\S\n]*[:=](?!=)[^\S\n]*/gi;
const QUOTED_VALUE = /^(\\?["'])(.*?)\1(?=\s*(?:[,})\]]|$))/s;
const LIST_VALUE = /^\[([^\]]*)\](?=\s*(?:[,})\]]|$))/;
const BARE_VALUE = /^(?!\\?["'[])[^\s,;})\]]+/;
const ADDRESS = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
const NO_RECIPIENT = /^(?:null|None|undefined)$/;

/**
 * True when `body` names at least one to, cc or bcc recipient and every one is a literal address at `domain`, a provider's test inbox,
 * which owner rule c113 lets a real test send reach with no ask. A recipient field whose value is a name, an expression or any other
 * address keeps the send a send. It reads JSON, a Python or JavaScript literal and httpie's `to=...`, and a batch's every message.
 */
export function onlyTestInboxes(body: string, domain: string): boolean {
	let found = 0;
	const literalAt = (text: string): boolean => {
		const inner = text.trim().replace(/^\\?["']|\\?["']$/g, "");
		if (/[{}$`"'\\]/.test(inner)) return false;
		const addresses = [...inner.matchAll(ADDRESS)];
		found += addresses.length;
		return addresses.length > 0 && addresses.every((a) => a[1].toLowerCase() === domain);
	};
	RECIPIENT_FIELD.lastIndex = 0;
	let field: RegExpExecArray | null;
	while ((field = RECIPIENT_FIELD.exec(body)) !== null) {
		const rest = body.slice(field.index + field[0].length);
		const list = rest.match(LIST_VALUE);
		const quoted = list ? null : rest.match(QUOTED_VALUE);
		const bare = list || quoted ? null : rest.match(BARE_VALUE);
		if (list) {
			const items = list[1].split(",").filter((item) => item.trim());
			if (!items.every(literalAt)) return false;
		} else if (quoted) {
			if (!literalAt(quoted[2])) return false;
		} else if (!bare || (!NO_RECIPIENT.test(bare[0]) && !literalAt(bare[0]))) return false;
	}
	return found > 0;
}

function httpWrite(name: string, args: string[]): boolean {
	if (name === "curl") {
		const get = args.some((a) => a === "-G" || a === "--get" || /^-[a-zA-Z]*G[a-zA-Z]*$/.test(a));
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			const method = a === "-X" || a === "--request" ? args[i + 1] : a.match(/^(?:-X|--request=)(\w+)$/)?.[1];
			if (method && /^(?:POST|PUT|PATCH)$/i.test(method)) return true;
			if (get) continue;
			if (/^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form(?:-string)?|-T|--upload-file|--mail-rcpt|--mail-from)(?:=|$)/.test(a)) return true;
			if (/^-[a-zA-Z]*[dFT]/.test(a) && !a.startsWith("--")) return true;
		}
		return false;
	}
	if (name === "wget") return args.some((a) => /^--(?:post-data|post-file|body-data|body-file)\b/.test(a) || /^--method=(?:POST|PUT|PATCH)$/i.test(a));
	const items = args.filter((a) => !a.startsWith("-"));
	if (items.length && /^(?:POST|PUT|PATCH)$/i.test(items[0])) return true;
	return items.some((a) => !/^[a-z]+:\/\//i.test(a) && /^[\w.\-[\]]+(?::=|=|@)/.test(a) && !/^[\w-]+==/.test(a));
}

function mailCliSends(name: string, args: string[]): boolean {
	if (MAIL_CLIS.has(name)) return !(args.length > 0 && args.every((a) => HELP_ONLY.test(a)));
	if (MAIL_READERS.has(name)) {
		if (args.some((a) => /^-[a-zA-Z]*[fHNeu]/.test(a) || a === "--file")) return false;
		return args.some((a) => /^-[sbcarq]/.test(a) || !a.startsWith("-"));
	}
	if (MUTTS.has(name)) {
		if (args.some((a) => /^-[a-zA-Z]*[fRyZQDv]/.test(a))) return false;
		return args.some((a) => /^-[sabcH]/.test(a) || /@/.test(a) || a === "--");
	}
	if (name === "himalaya") return args.some((a) => /^(?:send|reply|forward|write)$/.test(a));
	if (MAIL_CLI_NAME.test(name)) return args.some((a) => SEND_VERB.test(a));
	if (TICKET_CLI_NAME.test(name)) return args.some((a) => TICKET_CLI_VERB.test(a));
	return false;
}

const ASIDE_SEND_CODE = /(?:Meta|Control|ControlOrMeta|Mod|Cmd)\s*\+\s*Enter|\bSend\b|data-tooltip[*^$]?=\\?["']?Send|aria-label[*^$]?=\\?["']?Send|\.T-I\.aoO|requestSubmit\s*\(|보내기|\b(?:linkedin|imessage|whatsapp|discord|twitter|telegram)\s*\.\s*(?:send|reply|post|tweet|comment|message)\w*\s*\(/;
const SEND_INTENT = /\b(?:send|reply|respond|submit|forward|post|tweet|dm)\b|^\s*message\b|보내|답장|회신/i;
const MAIL_WORDS =
	/\b(?:e-?mails?|mail|gmail|outlook|inbox|tickets?|support|vendor|helpdesk|linkedin|twitter|tweet|discord|telegram|whatsapp|imessage|sms|text message|kakao\w*|contact form)\b|메일|티켓|카톡/i;
const DRAFTING = /\bdraft\s+(?:a|an|the|my|our|your|reply|email|message|response)\b|\bas\s+a\s+draft\b|\bunsent\b/i;
const NEGATED = /\b(?:do not|don't|dont|never|without|no)\b|하지\s*마|말고/i;

/** A prompt for the Aside agent that asks it to send or reply to an email or a ticket; "do not send" sentences are skipped. */
export function sendPrompt(prompt: string): string | null {
	for (const sentence of prompt.split(/(?<=[.!?])\s+|\n+/)) {
		if (DRAFTING.test(sentence) && !/\bsend\b/i.test(sentence)) continue;
		if (SEND_INTENT.test(sentence) && MAIL_WORDS.test(sentence) && !NEGATED.test(sentence)) return sentence.trim().slice(0, 160);
	}
	return null;
}

export function refusal(what: string): string {
	return (
		`global-rules send guard: refused, because ${what}. An email or a vendor ticket reply goes out only after the owner approves it (correction c37). ` +
		"Draft the message instead, and add a For you todo on your chat's board that quotes the draft and the recipient, with choices such as " +
		'"Send it" / "Not yet". After the owner approves it, run the same call again with OWNER_OK=<chat id>/<todo id> in it: an env prefix in bash ' +
		"(`OWNER_OK=<chat>/<todo> curl ...`), a `# OWNER_OK=<chat>/<todo>` line in an ipython cell, or an `x-owner-ok: <chat>/<todo>` header on a request to a local server such as Vent. Reading mail, drafting, and GET requests stay allowed."
	);
}

const OWN_GITHUB = /^(?:sieu-n|virev-ai)$/i;
const PY_RUNNER = /^python(?:\d+(?:\.\d+)*)?$/;
const JS_RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "deno"]);
const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
const UV_VALUE_FLAGS = /^(?:--with|--with-requirements|--project|--directory|-p|--python|--env-file|--package|--group|--extra|--index|--index-url)$/;
const MAX_SCRIPT_BYTES = 500000;
const ASIDE_SUBCOMMANDS = new Set(["repl", "exec", "session", "skills", "guide", "account", "memory", "mcp", "help", "login", "logout", "version", "update", "tabs"]);
const CONVEX_SEND_FN = /(?:^|[:/])(?:send|notify|invite|deliver|dispatch|reply|forward|dm)\w*$|(?:Send|Notify|Invite|Deliver|Dispatch|Reply|Forward)$/;
const CONVEX_OTHER_TARGET = /^--(?:prod|preview-name|preview-create|deployment-name|deployment|env-file)(?:=|$)/;
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?\/?$/i;
const ENV_NAME_VALUE = /^([A-Za-z_]\w*)=(.*)$/;
/** A key in a script's vars that no shell name can be: set once the script runs `cd` or `pushd`, so the CLI's cwd is no longer the check's. */
const MOVED = " moved";
const OSA_SEND = /application\s+"?(?:Mail|Messages|Microsoft Outlook|Outlook)\b[\s\S]*\bsend\b|Application\s*\(\s*["'](?:Mail|Messages|Microsoft Outlook)["']\s*\)[\s\S]*\.\s*send\s*\(/;

/** A script file an argv runs, read so its sends can be judged; null when it is missing, not a file, or too big. */
function readScript(file: string, cwd: string): string | null {
	const path = isAbsolute(file) ? file : join(cwd, file);
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size <= MAX_SCRIPT_BYTES ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/** owner/repo for a gh command: its -R flag, a github.com URL in its args, or the origin of the checkout at cwd. */
function ghRepo(args: string[], cwd: string): string | null {
	const flag = args.findIndex((a) => a === "-R" || a === "--repo");
	const named = flag !== -1 ? args[flag + 1] : args.find((a) => /^--repo=/.test(a))?.slice(7);
	const url = args.find((a) => /github\.com[/:][\w.-]+\/[\w.-]+/.test(a));
	const text = named ?? url ?? (() => {
		try {
			return execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return "";
		}
	})();
	const m = text.match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
	return m ? `${m[1]}/${m[2]}` : null;
}

/** Why a gh command writes to a repo the owner does not own, or null: an issue, PR, comment or review, or a gh api write. */
function ghSend(args: string[], cwd: string): string | null {
	const words = args.filter((a) => !a.startsWith("-"));
	const [sub, verb] = words;
	if (sub === "api") {
		const path = args.slice(args.indexOf("api") + 1).find((a, i, rest) => !a.startsWith("-") && !/^-/.test(rest[i - 1] ?? ""));
		if (!path) return null;
		const methodAt = args.findIndex((a) => a === "-X" || a === "--method");
		const method = methodAt !== -1 ? args[methodAt + 1] : args.find((a) => /^--method=/.test(a))?.slice(9) ?? (args.some((a) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(a)) ? "POST" : "GET");
		const repo = /\{owner\}|\{repo\}/.test(path) ? ghRepo([], cwd) : null;
		const resolved = repo ? path.replace("{owner}", repo.split("/")[0]).replace("{repo}", repo.split("/")[1]) : path;
		return httpSend(method, `https://api.github.com/${resolved.replace(/^\//, "")}`, args.join(" "));
	}
	const writes: Record<string, RegExp> = { issue: /^(?:create|new|comment|edit)$/, pr: /^(?:create|new|comment|review|edit)$/ };
	if (!sub || !verb || !writes[sub]?.test(verb)) return null;
	const repo = ghRepo(args, cwd);
	if (repo && OWN_GITHUB.test(repo.split("/")[0])) return null;
	return `\`gh ${sub} ${verb}\` posts on ${repo ?? "a repo it does not name"}, which the owner does not own`;
}

const JS_RESEND_SEND = /\.\s*emails\s*\.\s*send\s*\(/g;
const JS_RESEND_SEND_ANY = /\.\s*(?:emails|batch)\s*\.\s*send\s*\(/g;
const RESEND_EMAILS = "https://api.resend.com/emails";

/** `sites` with each Resend SDK send in `call` blanked out when its arguments reach only Resend's test inboxes (c113). */
function blankTestSends(sites: string, code: string, call: RegExp): string {
	return sites.replace(call, (text: string, offset: number) => (sendTarget(RESEND_EMAILS, balancedSlice(code, offset + text.length - 1)) ? text : " ".repeat(text.length)));
}

/** Sends written in a JavaScript or TypeScript script: an HTTP write to a send target, nodemailer, or a mail or message SDK. */
export function judgeSendJs(code: string): string | null {
	const writes = /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH)["'`]|\.\s*(?:post|put|patch)\s*\(/i.test(code);
	const target = writes ? (code.match(URL_TEXT) ?? []).map((u) => sendTarget(u, code)).find(Boolean) : null;
	if (target) return `this script writes to ${target}`;
	if (/\bcreateTransport\s*\(/.test(code) && /\.\s*sendMail\s*\(/.test(code)) return "this script sends mail with nodemailer";
	const sdkCall = /\bresend\b/i.test(code) ? JS_RESEND_SEND_ANY : JS_RESEND_SEND;
	if (new RegExp(sdkCall.source).test(blankTestSends(code, code, sdkCall)) || (/@sendgrid\/mail|\bpostmark\b|\bmailgun/i.test(code) && /\.\s*(?:send|sendEmail\w*|create)\s*\(/.test(code))) return "this script sends mail through a mail SDK";
	if (/\btwilio\b/i.test(code) && /\.\s*messages\s*\.\s*create\s*\(/.test(code)) return "this script sends a text message through Twilio";
	return null;
}

function scriptSend(kind: "py" | "js" | "sh" | "osa", code: string, cwd: string, depth: number): string | null {
	if (kind === "py") return pythonSends(code)[0] ?? null;
	if (kind === "js") return judgeSendJs(code);
	if (kind === "osa") return OSA_SEND.test(code) ? "this AppleScript sends a message from Mail or Messages" : null;
	const inner: Verdict[] = [];
	collect(code, depth + 1, inner, cwd, new Map());
	return inner.length ? `this shell script runs \`${inner[0].command.slice(0, 120)}\`, which sends` : null;
}

/** The send a script runner starts: inline code (`python -c`, `node -e`) or a script file it runs. */
function runnerSend(name: string, args: string[], cwd: string, depth: number): string | null {
	const kind = PY_RUNNER.test(name) ? "py" : JS_RUNNERS.has(name) ? "js" : SHELLS.has(name) ? "sh" : name === "osascript" ? "osa" : null;
	if (!kind) return null;
	const inline = args.findIndex((a) => (kind === "py" && a === "-c") || (kind === "js" && /^(?:-e|--eval|-p|--print)$/.test(a)) || (kind === "osa" && a === "-e"));
	if (inline !== -1 && kind !== "sh") {
		const code = kind === "osa" ? args.filter((_, i) => args[i - 1] === "-e").join("\n") : args[inline + 1] ?? "";
		return scriptSend(kind, code, cwd, depth);
	}
	const file = args.find((a, i) => !a.startsWith("-") && !(kind === "osa" && args[i - 1] === "-l") && !(kind === "js" && ["run", "x"].includes(a)));
	const code = file ? readScript(file, cwd) : null;
	return code === null ? null : scriptSend(kind, code, cwd, depth);
}

function judgeArgv(eff: string[], depth: number, out: Verdict[], cwd: string, vars: Map<string, string>): void {
	if (!eff.length || depth > 4) return;
	const name = basename(eff[0]);
	const args = eff.slice(1);
	const line = eff.join(" ");
	const push = (what: string): void => {
		out.push({ rule: "send", command: line, reason: refusal(what) });
	};
	if (SHELLS.has(name)) {
		const script = shellScript(eff);
		if (script) collect(script, depth + 1, out, cwd, vars);
		else {
			const what = runnerSend(name, args, cwd, depth);
			if (what) push(what);
		}
		return;
	}
	if (name === "eval") return collect(args.join(" "), depth + 1, out, cwd, vars);
	if (name === "timeout" || name === "xargs" || name === "ssh") {
		const rest = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[a-zA-Z]$/.test(args[i - 1]) && name !== "xargs"));
		const inner = name === "xargs" ? rest : rest.slice(1);
		if (inner.length) collect(inner.join(" "), depth + 1, out, cwd, vars);
		return;
	}
	if (name === "uv" && args[0] === "run") {
		let k = 1;
		while (k < args.length && args[k].startsWith("-")) k += UV_VALUE_FLAGS.test(args[k]) ? 2 : 1;
		const rest = args.slice(k);
		return judgeArgv(rest[0]?.endsWith(".py") ? ["python", ...rest] : rest, depth + 1, out, cwd, vars);
	}
	if (LAUNCHERS.has(name) || ((name === "pnpm" || name === "yarn" || name === "bun") && (args[0] === "exec" || args[0] === "dlx" || args[0] === "x"))) {
		const rest = LAUNCHERS.has(name) ? args : args.slice(1);
		return judgeArgv(rest.filter((a, i) => !(a.startsWith("-") && i === 0)), depth + 1, out, cwd, vars);
	}
	if (mailCliSends(name, args)) return push(`\`${name}\` sends mail or a ticket reply`);
	if (HTTP_CLIENTS.has(name)) {
		const body = args.join(" ");
		const urls = args.flatMap((a) => a.match(URL_TEXT) ?? []);
		if (!urls.length && name !== "curl" && name !== "wget") {
			const bare = args.find((a) => !a.startsWith("-") && !/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(a));
			if (bare && /^[\w-]+(?:\.[\w-]+)+(?:[:/]|$)/.test(bare)) urls.push(`https://${bare}`);
		}
		const smtp = urls.find((u) => /^smtps?:/i.test(u));
		const target = smtp ? sendTarget(smtp) : httpWrite(name, args) ? urls.map((u) => sendTarget(u, body)).find(Boolean) : null;
		if (target) push(`this ${name} call writes to ${target}`);
		return;
	}
	if (name === "gh") {
		const what = ghSend(args, cwd);
		if (what) push(what);
		return;
	}
	if (name === "stripe") {
		if (/^invoices?$/.test(args[0] ?? "") && args[1] === "send") return push("`stripe invoices send` emails the invoice to the customer");
		if (/^(?:post|put|patch)$/i.test(args[0] ?? "") && args[1]) {
			const what = httpSend(args[0], `https://api.stripe.com/${args[1].replace(/^\//, "")}`, args.join(" "));
			if (what) push(what);
		}
		return;
	}
	if ((name === "vercel" || name === "vc") && /^teams?$/.test(args[0] ?? "") && args[1] === "invite") return push("`vercel teams invite` emails an invitation");
	if (name === "convex" && args[0] === "run") {
		const fn = args.slice(1).find((a) => !a.startsWith("-") && !a.startsWith("{"));
		if (fn && CONVEX_SEND_FN.test(fn) && !convexRunStaysLocal(args, cwd, vars)) push(`\`convex run ${fn}\` runs a function that sends email or a message`);
		return;
	}
	if (name === "cua-driver" && /^(?:mcp|serve)$/.test(args[0] ?? "")) return push("this starts cua-driver's MCP server outside the cua-guard proxy, so its desktop sends go unchecked");
	if (name === "osascript") {
		const what = runnerSend(name, args, cwd, depth) ?? (OSA_SEND.test(line) ? "this AppleScript sends a message from Mail or Messages" : null);
		if (what) push(what);
		return;
	}
	if (PY_RUNNER.test(name) || JS_RUNNERS.has(name)) {
		const what = runnerSend(name, args, cwd, depth);
		if (what) push(what);
		return;
	}
	if (name === "aside") {
		let k = 0;
		while (k < args.length && args[k].startsWith("-")) k += /^(?:-m|--model|--profile|-p)$/.test(args[k]) ? 2 : 1;
		const [sub, ...rest] = args.slice(k);
		const text = rest.join(" ");
		const prompt =
			sub === "exec" ? sendPrompt(text) : sub === "session" && rest[0] === "resume" ? sendPrompt(rest.slice(2).join(" ")) : sub && !ASIDE_SUBCOMMANDS.has(sub) ? sendPrompt([sub, ...rest].join(" ")) : null;
		if (prompt) push(`the Aside agent task asks it to send: "${prompt}"`);
		else if (sub === "repl" && ASIDE_SEND_CODE.test(text)) push("this `aside repl` code presses Send or submits a form outside the aside_browser skill's page check");
	}
}

function collect(command: string, depth: number, out: Verdict[], cwd: string, vars: Map<string, string>): void {
	if (depth > 4) return;
	const { commands, nested } = lex(command);
	for (const argv of expandVars(commands, vars)) {
		const eff = effective(argv);
		if (eff[0] === "cd" || eff[0] === "pushd") vars.set(MOVED, "1");
		// `NAME=value cmd` and `env NAME=value cmd` set NAME for that command only.
		const prefix = argv.slice(0, argv.length - eff.length).flatMap((w) => {
			const m = w.match(ENV_NAME_VALUE);
			return m ? [[m[1], m[2]] as [string, string]] : [];
		});
		judgeArgv(eff, depth, out, cwd, prefix.length ? new Map([...vars, ...prefix]) : vars);
	}
	for (const inner of nested) collect(inner, depth + 1, out, cwd, vars);
}

/** The NAME=value rows of a dotenv file, or none when it cannot be read. */
function dotenvRows(path: string): Map<string, string> {
	try {
		const rows = readFileSync(path, "utf8").split("\n").flatMap((line) => {
			const m = line.trim().match(/^(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/);
			return m ? [[m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")] as [string, string]] : [];
		});
		return new Map(rows);
	} catch {
		return new Map();
	}
}

/** The body curl prints for one short read, or null when the read fails. */
function curlRead(args: string[], input = ""): string | null {
	try {
		// measured: 101 reads of the local Convex /api/query and the Vent /healthz on us-metal02 at load 62 to 103 (10-19) took at most 20 ms; 5 s also stays under the kernel judge's 30 s TIMEOUT, past which the kernel lets a check through.
		return execFileSync("curl", ["-sS", "--fail", "--max-time", "5", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

/**
 * True when a `convex run` targets this machine's own Convex (a loopback URL), that deployment's VENT_URL answers mode mock on /healthz, and
 * it holds no SMTP sender. Every provider call from Convex goes through Vent, and a mock-mode Vent answers from its fakes, so the email or
 * message never leaves. An SMTP sender is the one path around Vent: convex/search/senders/smtpNode.ts sends through nodemailer straight to
 * the sender's own server, so any row in an SMTP table, or a missing searchSmtpConnections table, keeps the refusal.
 * The target is the one the Convex CLI picks: --url with --admin-key first, else CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY from
 * the command's prefix, the environment, .env.local and .env. A cloud selector anywhere (--prod, --deployment, CONVEX_DEPLOYMENT,
 * CONVEX_DEPLOY_KEY), a `cd` before the run, two different URLs, a failed read or a real-mode Vent keeps the refusal.
 */
function convexRunStaysLocal(args: string[], cwd: string, vars: Map<string, string>): boolean {
	if (args.some((a) => CONVEX_OTHER_TARGET.test(a))) return false;
	const flag = (name: string): string | undefined => {
		const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
		return i === -1 ? undefined : args[i].startsWith(`${name}=`) ? args[i].slice(name.length + 1) : args[i + 1];
	};
	let url = flag("--url");
	let adminKey = flag("--admin-key");
	if (!url || !adminKey) {
		if (vars.has(MOVED)) return false;
		const sources = [vars, new Map(Object.entries(process.env) as [string, string][]), dotenvRows(join(cwd, ".env.local")), dotenvRows(join(cwd, ".env"))];
		const values = (key: string) => sources.map((s) => s.get(key)?.trim()).filter((v): v is string => Boolean(v));
		if (values("CONVEX_DEPLOYMENT").length || values("CONVEX_DEPLOY_KEY").length) return false;
		const urls = new Set([...(url ? [url] : []), ...values("CONVEX_SELF_HOSTED_URL")].map((u) => u.replace(/\/+$/, "")));
		if (urls.size !== 1) return false;
		url = [...urls][0];
		adminKey ??= values("CONVEX_SELF_HOSTED_ADMIN_KEY")[0];
	}
	if (!adminKey || !LOOPBACK_URL.test(url)) return false;
	const base = url.replace(/\/+$/, "");
	const query = (path: string, args: object): unknown => {
		const body = JSON.stringify({ path, args, format: "json" });
		const reply = JSON.parse(curlRead(["-H", "@-", "-H", "Content-Type: application/json", "--data", body, `${base}/api/query`], `Authorization: Convex ${adminKey}\n`) ?? "") as { status?: unknown; value?: unknown };
		if (reply.status !== "success") throw new Error("the Convex query failed");
		return reply.value;
	};
	// numItems: 10000 is the page size `convex data` asks for (node_modules/convex/dist/esm/cli/lib/run.js runSystemPaginatedQuery); 1 asks only whether a row exists.
	const page = (path: string, args: object, numItems: number): unknown[] => {
		const rows: unknown[] = [];
		for (let cursor: string | null = null; ; ) {
			const value = query(path, { ...args, paginationOpts: { numItems, cursor } }) as { page?: unknown; isDone?: unknown; continueCursor?: unknown };
			if (!Array.isArray(value.page)) throw new Error("the Convex page has no rows");
			rows.push(...value.page);
			if (value.isDone === true || rows.length) return rows;
			cursor = String(value.continueCursor);
		}
	};
	try {
		const ventUrl = (query("_system/cli/queryEnvironmentVariables:get", { name: "VENT_URL" }) as { value?: unknown } | null)?.value;
		if (typeof ventUrl !== "string" || !/^https?:\/\//i.test(ventUrl)) return false;
		const health = JSON.parse(curlRead([`${ventUrl.replace(/\/+$/, "")}/healthz`]) ?? "") as { mode?: unknown };
		if (health.mode !== "mock") return false;
		const smtpTables = page("_system/cli/tables", {}, 10000).map((t) => String((t as { name?: unknown }).name)).filter((name) => /smtp/i.test(name));
		if (!smtpTables.includes("searchSmtpConnections")) return false;
		return smtpTables.every((table) => page("_system/cli/tableData", { table, order: "desc" }, 1).length === 0);
	} catch {
		return false;
	}
}

export function judgeSendShell(text: string, cwd = process.cwd()): Verdict[] {
	const out: Verdict[] = [];
	collect(stripHeredocs(text), 0, out, cwd, new Map());
	return out;
}

const PY_WRITE_CALL = /\.\s*(?:post|put|patch|request|fetch|urlopen|Request|ClientSession\(\)\.post)\s*\(|\burlopen\s*\(/g;
const PY_WRITE_ARGS = /^\s*(?:method\s*=\s*)?["'](?:POST|PUT|PATCH)["']|\bmethod\s*=\s*["'](?:POST|PUT|PATCH)["']|\bdata\s*=/;
const PY_SMTP = /\bsmtplib\b|\bSMTP(?:_SSL)?\s*\(|\baiosmtplib\b|\byagmail\b/;
const PY_SMTP_SEND = /\.\s*(?:sendmail|send_message)\s*\(|\b(?:yagmail|aiosmtplib)\b[\s\S]*\.\s*send\s*\(/;
const GAP = String.raw`(?:\s|\\\n)*`;
const GMAIL_CLIENT_SEND = new RegExp(String.raw`\.${GAP}(?:messages|drafts)${GAP}\(${GAP}\)${GAP}\.${GAP}send${GAP}\(`);
const MCP_CALL = /\bcall_tool\s*\(/g;
const MCP_SEND_TOOL = /send|reply|forward|post_?(?:message|comment|reply)|(?:create|add)_?(?:comment|reply)/i;
const MCP_MAIL_SERVER = /mail|gmail|outlook|zendesk|freshdesk|intercom|helpscout|front|ticket|support|desk/i;

/** Sends written as Python in an ipython cell: HTTP writes to mail or ticket APIs, SMTP, the Gmail API client, and MCP send tools. */
/** The URL a Python call sends to: its first URL literal (later ones sit in the body), or the literal a bare name was assigned. */
function callUrls(args: string, code: string): string[] {
	const literal = args.match(/["'](?:https?|smtps?):\/\/[^"'\s]+/i);
	if (literal) return [literal[0].slice(1)];
	const name = args.match(/^\s*(?:url\s*=\s*)?([A-Za-z_]\w*)\s*[,)]?/)?.[1];
	if (!name) return [];
	const assigned = code.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*[rfbu]?["']([^"'\\n]+)`));
	return assigned?.[1].match(URL_TEXT) ?? [];
}

const PY_RESEND_SEND = /\b(?:Emails|Batch)\s*\.\s*send\s*\(/g;
const PY_SDK_SEND = /\b(?:Emails|Batch)\s*\.\s*send\s*\(|\bSendGridAPIClient\b[\s\S]*\.\s*send\s*\(|\bpostmarker\b[\s\S]*\.\s*send\s*\(/;
const PY_TWILIO_SEND = /\btwilio\b[\s\S]*\.\s*messages\s*\.\s*create\s*\(/;

/** Sends written as Python in an ipython cell: HTTP writes to mail or ticket APIs, SMTP, the Gmail API client, and MCP send tools. */
export function judgeSendPython(code: string): Verdict[] {
	return pythonSendList(code).map(({ what, command }) => ({ rule: "send", command, reason: refusal(what) }));
}

/** What each send in this Python code is, for a cell or a script file a runner starts. */
export function pythonSends(code: string): string[] {
	return pythonSendList(code).map((send) => send.what);
}

function pythonSendList(code: string): { what: string; command: string }[] {
	const out: { what: string; command: string }[] = [];
	const push = (what: string, command: string) => out.push({ what, command });
	const sites = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), (text) => " ".repeat(text.length));
	if (PY_SMTP.test(sites) && PY_SMTP_SEND.test(sites)) push("this code sends mail over SMTP", "smtplib send");
	if (GMAIL_CLIENT_SEND.test(sites)) push("this code calls the Gmail API client's send", "gmail messages().send()");
	if (PY_SDK_SEND.test(blankTestSends(sites, code, PY_RESEND_SEND))) push("this code sends mail through a mail SDK", "mail SDK send");
	if (PY_TWILIO_SEND.test(sites)) push("this code sends a text message through Twilio", "twilio messages.create");
	PY_WRITE_CALL.lastIndex = 0;
	let w: RegExpExecArray | null;
	while ((w = PY_WRITE_CALL.exec(sites)) !== null) {
		const args = balancedSlice(code, w.index + w[0].length - 1);
		const verb = w[0].replace(/[\s.(]/g, "");
		const writes = /^(?:post|put|patch)$/.test(verb) || PY_WRITE_ARGS.test(args);
		const target = writes ? callUrls(args, code).map((u) => sendTarget(u, args)).find(Boolean) : null;
		if (target) {
			push(`this code posts to ${target}`, "HTTP write in Python");
			break;
		}
	}
	MCP_CALL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MCP_CALL.exec(sites)) !== null) {
		const args = balancedSlice(code, m.index + m[0].length - 1);
		const positional = args.match(/^\s*(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/);
		const server = positional?.[2] ?? args.match(/\bserver\s*=\s*["']([^"']+)/)?.[1];
		const tool = positional?.[4] ?? args.match(/\btool(?:_name)?\s*=\s*["']([^"']+)/)?.[1];
		if (!server || !tool) continue;
		const what = mcpSend(server, tool, args);
		if (what) push(what, `mcp ${server} ${tool}`);
	}
	return out;
}

/** Why an MCP call sends outside, or null. `args` is the call's arguments as text: the cell source or the JSON the kernel guard saw. */
export function mcpSend(server: string, tool: string, args: string): string | null {
	if (server === "aside") {
		const prompt = tool === "exec" ? sendPrompt(args) : null;
		if (prompt) return `the Aside agent task asks it to send: "${prompt}"`;
		if (tool === "repl" && ASIDE_SEND_CODE.test(args)) return "this raw aside repl call presses Send or submits a form outside the aside_browser skill's page check";
		return null;
	}
	if (MCP_SEND_TOOL.test(tool) && MCP_MAIL_SERVER.test(`${server} ${tool}`)) return `the MCP tool ${server}/${tool} sends mail or a message`;
	return null;
}

/** Why an HTTP request sends outside, or null: a POST, PUT or PATCH to a mail, ticket or message API, or any request to an smtp:// URL. */
export function httpSend(method: string, url: string, body = ""): string | null {
	if (/^smtps?:/i.test(url)) return `this request writes to ${sendTarget(url)}`;
	if (!/^(?:POST|PUT|PATCH)$/i.test(method)) return null;
	const target = sendTarget(url, body);
	return target ? `this ${method.toUpperCase()} writes to ${target}` : null;
}

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const OWNER_OK_SCRIPT = join(HERE, "..", "user-history", "src", "owner-ok.ts");

/** The OWNER_OK=<chat>/<todo> token in a tool call, or null. */
export function ownerOkToken(text: string): string | null {
	return text.match(OWNER_OK)?.[1] ?? null;
}

/** The approved For you todo the token names, or why it does not count. Runs components/user-history/src/owner-ok.ts, the one approval rule. */
export function ownerOkTodo(token: string): { todo: { text: string } } | { reason: string } {
	if (!existsSync(OWNER_OK_SCRIPT)) return { reason: `the owner-ok check is missing at ${OWNER_OK_SCRIPT}` };
	const last = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok?: boolean; reason?: string; todo?: { text: string } };
	try {
		const stdout = execFileSync(basename(process.execPath) === "node" ? process.execPath : "node", ["--import", "tsx", OWNER_OK_SCRIPT, token], {
			cwd: join(HERE, "..", "user-history"), encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
		});
		const result = last(stdout);
		return result.ok === true && result.todo ? { todo: result.todo } : { reason: "not approved" };
	} catch (error) {
		const stdout = (error as { stdout?: string }).stdout ?? "";
		try {
			return { reason: String(last(stdout).reason ?? "not approved") };
		} catch {
			return { reason: `the owner-ok check failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
		}
	}
}

/** null when the token names an approved For you todo, else why not. */
export function checkOwnerOk(token: string): string | null {
	const result = ownerOkTodo(token);
	return "todo" in result ? null : result.reason;
}

/** Drops the send verdicts that an approved OWNER_OK token covers; otherwise says why the token does not count. */
export function applyOwnerOk(verdicts: Verdict[], text: string): Verdict[] {
	if (!verdicts.some((v) => v.rule === "send")) return verdicts;
	const token = ownerOkToken(text);
	if (!token) return verdicts;
	const result = ownerOkTodo(token);
	return verdicts.flatMap((v) => {
		if (v.rule !== "send") return [v];
		return "todo" in result ? [] : [{ ...v, reason: `${v.reason} OWNER_OK=${token} does not count: ${result.reason}` }];
	});
}
