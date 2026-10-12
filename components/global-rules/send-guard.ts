import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PY_STRING, SHELLS, balancedSlice, effective, lex, shellScript, stripHeredocs } from "./shell.ts";
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

/** Where a URL sends to, when a write to it is an email or a ticket reply. */
export function sendTarget(url: string, body = ""): string | null {
	const m = url.match(/^(https?|smtps?):\/\/([^/:?#]+)(?::\d+)?([^?#]*)/i);
	if (!m) return null;
	const [, scheme, rawHost, path] = m;
	const host = rawHost.toLowerCase();
	if (/^smtps?$/i.test(scheme)) return `SMTP server ${host}`;
	if (/^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/.test(host)) return null;
	if (/^(?:gmail|www)\.googleapis\.com$/.test(host) && /\/gmail\/|^\/upload\/gmail/.test(path) && /\/send\b/.test(path)) return "the Gmail send API";
	if (host === "graph.microsoft.com" && /\/(?:sendMail|reply|replyAll|forward|send)\b/i.test(path)) return "the Microsoft Graph mail API";
	if (/(?:^|\.)(?:api\.sendgrid\.com|api\.(?:eu\.)?mailgun\.net|api\.postmarkapp\.com|api\.resend\.com|api\.mailjet\.com|api\.brevo\.com|api\.sendinblue\.com|api\.sparkpost\.com|mandrillapp\.com|api\.smtp2go\.com|send\.api\.mailtrap\.io)$/.test(host)) return `the mail API ${host}`;
	if (/^email(?:-smtp)?\.[\w-]+\.amazonaws\.com$/.test(host)) return "Amazon SES";
	if (/\.zendesk\.com$|\.freshdesk\.com$|^api\.intercom\.io$|^api\.helpscout\.net$|^api2\.frontapp\.com$|\.kayako\.com$|\.gorgias\.com$|^desk\.zoho\.[a-z.]+$|\.zohodesk\.[a-z.]+$/.test(host)) return `the ticket API ${host}`;
	if (/\.atlassian\.net$/.test(host) && /\/rest\/servicedeskapi\//.test(path)) return "Jira Service Management";
	if (/(?:submitticket|viewticket|supporttickets)\.php$/i.test(path)) return `the support portal ${host}`;
	if (/\/includes\/api\.php$/i.test(path) && /\b(?:AddTicketReply|OpenTicket)\b/.test(body)) return `the WHMCS ticket API ${host}`;
	if (/^(?:support|helpdesk|tickets?)\./.test(host)) return `the support desk ${host}`;
	return null;
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

const ASIDE_SEND_CODE = /(?:Meta|Control|ControlOrMeta|Mod|Cmd)\s*\+\s*Enter|\bSend\b|data-tooltip[*^$]?=\\?["']?Send|aria-label[*^$]?=\\?["']?Send|\.T-I\.aoO|requestSubmit\s*\(|보내기/;
const SEND_INTENT = /\b(?:send|reply|respond|submit|forward|post)\b|보내|답장|회신/i;
const MAIL_WORDS = /\b(?:e-?mails?|mail|gmail|outlook|inbox|tickets?|support|vendor|helpdesk)\b|메일|티켓/i;
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

function refusal(what: string): string {
	return (
		`global-rules send guard: refused, because ${what}. An email or a vendor ticket reply goes out only after the owner approves it (correction c37). ` +
		"Draft the message instead, and add a For you todo on your chat's board that quotes the draft and the recipient, with choices such as " +
		'"Send it" / "Not yet". After the owner approves it, run the same call again with OWNER_OK=<chat id>/<todo id> in it: an env prefix in bash ' +
		"(`OWNER_OK=<chat>/<todo> curl ...`), or a `# OWNER_OK=<chat>/<todo>` line in an ipython cell. Reading mail, drafting, and GET requests stay allowed."
	);
}

function collect(command: string, depth: number, out: Verdict[]): void {
	if (depth > 4) return;
	const { commands, nested } = lex(command);
	for (const argv of commands) {
		const eff = effective(argv);
		if (!eff.length) continue;
		const name = basename(eff[0]);
		const args = eff.slice(1);
		const line = eff.join(" ");
		if (SHELLS.has(name)) {
			const script = shellScript(eff);
			if (script) collect(script, depth + 1, out);
			continue;
		}
		if (name === "timeout" || name === "xargs" || name === "ssh") {
			const rest = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[a-zA-Z]$/.test(args[i - 1]) && name !== "xargs"));
			const inner = name === "xargs" ? rest : rest.slice(1);
			if (inner.length) collect(inner.join(" "), depth + 1, out);
			continue;
		}
		if (mailCliSends(name, args)) {
			out.push({ rule: "send", command: line, reason: refusal(`\`${name}\` sends mail or a ticket reply`) });
			continue;
		}
		if (HTTP_CLIENTS.has(name)) {
			const body = args.join(" ");
			const urls = args.flatMap((a) => a.match(URL_TEXT) ?? []);
			if (!urls.length && name !== "curl" && name !== "wget") {
				const bare = args.find((a) => !a.startsWith("-") && !/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(a));
				if (bare && /^[\w-]+(?:\.[\w-]+)+(?:[:/]|$)/.test(bare)) urls.push(`https://${bare}`);
			}
			const smtp = urls.find((u) => /^smtps?:/i.test(u));
			const target = smtp ? sendTarget(smtp) : httpWrite(name, args) ? urls.map((u) => sendTarget(u, body)).find(Boolean) : null;
			if (target) out.push({ rule: "send", command: line, reason: refusal(`this ${name} call writes to ${target}`) });
			continue;
		}
		if (name === "osascript" && /application\s+"?Mail\b/.test(line) && /\bsend\b/.test(line)) {
			out.push({ rule: "send", command: line, reason: refusal("this AppleScript sends a message from Mail.app") });
			continue;
		}
		if (name === "aside") {
			const sub = args[0];
			const text = args.slice(1).join(" ");
			const prompt = sub === "exec" ? sendPrompt(text) : sub === "session" && args[1] === "resume" ? sendPrompt(args.slice(3).join(" ")) : null;
			if (prompt) out.push({ rule: "send", command: line, reason: refusal(`the Aside agent task asks it to send: "${prompt}"`) });
			else if (sub === "repl" && ASIDE_SEND_CODE.test(text)) {
				out.push({ rule: "send", command: line, reason: refusal("this `aside repl` code presses Send or submits a form outside the aside_browser skill's page check") });
			}
		}
	}
	for (const inner of nested) collect(inner, depth + 1, out);
}

export function judgeSendShell(text: string): Verdict[] {
	const out: Verdict[] = [];
	collect(stripHeredocs(text), 0, out);
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

/** Sends written as Python in an ipython cell: HTTP writes to mail or ticket APIs, SMTP, the Gmail API client, and MCP send tools. */
export function judgeSendPython(code: string): Verdict[] {
	const out: Verdict[] = [];
	const push = (what: string, command: string) => out.push({ rule: "send", command, reason: refusal(what) });
	const sites = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), (text) => " ".repeat(text.length));
	if (PY_SMTP.test(sites) && PY_SMTP_SEND.test(sites)) push("this cell sends mail over SMTP", "smtplib send");
	if (GMAIL_CLIENT_SEND.test(sites)) push("this cell calls the Gmail API client's send", "gmail messages().send()");
	PY_WRITE_CALL.lastIndex = 0;
	let w: RegExpExecArray | null;
	while ((w = PY_WRITE_CALL.exec(sites)) !== null) {
		const args = balancedSlice(code, w.index + w[0].length - 1);
		const verb = w[0].replace(/[\s.(]/g, "");
		const writes = /^(?:post|put|patch)$/.test(verb) || PY_WRITE_ARGS.test(args);
		const target = writes ? callUrls(args, code).map((u) => sendTarget(u, args)).find(Boolean) : null;
		if (target) {
			push(`this cell posts to ${target}`, "HTTP write in Python");
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
		if (server === "aside") {
			const prompt = tool === "exec" ? sendPrompt(args) : null;
			if (prompt) push(`the Aside agent task asks it to send: "${prompt}"`, "mcp aside exec");
			else if (tool === "repl" && ASIDE_SEND_CODE.test(args)) push("this raw aside repl call presses Send or submits a form outside the aside_browser skill's page check", "mcp aside repl");
		} else if (MCP_SEND_TOOL.test(tool) && MCP_MAIL_SERVER.test(`${server} ${tool}`)) {
			push(`the MCP tool ${server}/${tool} sends mail or a ticket reply`, `mcp ${server} ${tool}`);
		}
	}
	return out;
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

/**
 * Drops the send and merge verdicts that an approved OWNER_OK token covers; otherwise says why the token does not count.
 * A merge verdict also needs the todo's text to name its subject (c49): the PR, or the repo and default-branch push, so one go cannot move something else.
 */
export function applyOwnerOk(verdicts: Verdict[], text: string): Verdict[] {
	const gated = (v: Verdict) => v.rule === "send" || v.rule === "merge";
	if (!verdicts.some(gated)) return verdicts;
	const token = ownerOkToken(text);
	if (!token) return verdicts;
	const result = ownerOkTodo(token);
	const why = (v: Verdict): string | null => {
		if (!("todo" in result)) return result.reason;
		if (v.rule !== "merge") return null;
		if (!v.subject) return "the command does not name the PR number, or the repo and branch it moves";
		return v.subject.pattern.test(result.todo.text) ? null : `todo text "${result.todo.text.slice(0, 120)}" does not name ${v.subject.label}`;
	};
	return verdicts.flatMap((v) => {
		if (!gated(v)) return [v];
		const reason = why(v);
		return reason === null ? [] : [{ ...v, reason: `${v.reason} OWNER_OK=${token} does not count: ${reason}` }];
	});
}
