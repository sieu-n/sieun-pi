/** A Python string literal, with its prefix and triple-quoted forms. */
export const PY_STRING = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

/** The text between the parenthesis at `openParen` and its match, skipping Python strings; at most 4000 characters. */
export function balancedSlice(code: string, openParen: number): string {
	if (openParen < 0) return "";
	let depth = 0;
	const limit = Math.min(code.length, openParen + 4000);
	for (let i = openParen; i < limit; i++) {
		const ch = code[i];
		if (ch === "'" || ch === '"') {
			const delimiter = code.slice(i, i + 3) === ch.repeat(3) ? ch.repeat(3) : ch;
			i += delimiter.length;
			while (i < code.length && !code.startsWith(delimiter, i)) {
				i += code[i] === "\\" ? 2 : 1;
			}
			i += delimiter.length - 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return code.slice(openParen + 1, i);
		}
	}
	return code.slice(openParen + 1, limit);
}

export interface Lexed {
	commands: string[][];
	nested: string[];
}

export function stripHeredocs(str: string): string {
	const out: string[] = [];
	let endTag: string | null = null;
	for (const line of str.split("\n")) {
		if (endTag !== null) {
			if (line.trim() === endTag || line.trim() === `\t${endTag}`) endTag = null;
			continue;
		}
		const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (m) endTag = m[2];
		out.push(line);
	}
	return out.join("\n");
}

/** Each heredoc's opener line and body, so a guard can judge a script fed to a shell (`bash <<'EOF'`). */
export function heredocs(str: string): { opener: string; body: string }[] {
	const out: { opener: string; body: string }[] = [];
	let open: { opener: string; tag: string; lines: string[] } | null = null;
	for (const line of str.split("\n")) {
		if (open) {
			if (line.trim() === open.tag) {
				out.push({ opener: open.opener, body: open.lines.join("\n") });
				open = null;
			} else open.lines.push(line);
			continue;
		}
		const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (m) open = { opener: line.slice(0, m.index), tag: m[2], lines: [] };
	}
	if (open) out.push({ opener: open.opener, body: open.lines.join("\n") });
	return out;
}

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
const WRAPPERS = new Set(["command", "exec", "time", "nice", "nohup", "setsid", "stdbuf", "ionice", "builtin", "caffeinate"]);

/** Splits shell text into argv lists and collects `$(...)`, backtick, and subshell bodies for a separate pass. */
export function lex(str: string): Lexed {
	const commands: string[][] = [];
	const nested: string[] = [];
	let argv: string[] = [];
	let cur = "";
	let has = false;
	let i = 0;
	const n = str.length;
	const endWord = () => { if (has) { argv.push(cur); cur = ""; has = false; } };
	const endCmd = () => { endWord(); if (argv.length) { commands.push(argv); argv = []; } };

	const grabBalanced = (open: string, close: string, start: number) => {
		let depth = 0;
		let j = start;
		let q: string | null = null;
		for (; j < n; j++) {
			const ch = str[j];
			if (q) { if (ch === "\\" && q === '"') j++; else if (ch === q) q = null; continue; }
			if (ch === "'" || ch === '"') { q = ch; continue; }
			if (ch === open) depth++;
			else if (ch === close) { depth--; if (depth === 0) return { inner: str.slice(start + 1, j), end: j + 1 }; }
		}
		return { inner: str.slice(start + 1), end: n };
	};
	const grabBacktick = (start: number) => {
		let j = start + 1;
		for (; j < n; j++) { if (str[j] === "\\") j++; else if (str[j] === "`") break; }
		return { inner: str.slice(start + 1, j), end: Math.min(j + 1, n) };
	};

	while (i < n) {
		const c = str[i];
		if (c === "\\") { cur += str[i + 1] ?? ""; has = true; i += 2; continue; }
		if (c === "'") { let j = i + 1; while (j < n && str[j] !== "'") j++; cur += str.slice(i + 1, j); has = true; i = j < n ? j + 1 : j; continue; }
		if (c === '"') {
			let j = i + 1;
			while (j < n && str[j] !== '"') {
				if (str[j] === "\\") { cur += str[j + 1] ?? ""; j += 2; continue; }
				if (str[j] === "$" && str[j + 1] === "(") { const g = grabBalanced("(", ")", j + 1); nested.push(g.inner); j = g.end; continue; }
				if (str[j] === "`") { const g = grabBacktick(j); nested.push(g.inner); j = g.end; continue; }
				cur += str[j]; j++;
			}
			has = true; i = j < n ? j + 1 : j; continue;
		}
		if (c === "`") { const g = grabBacktick(i); nested.push(g.inner); i = g.end; continue; }
		if (c === "$" && str[i + 1] === "(") { const g = grabBalanced("(", ")", i + 1); nested.push(g.inner); i = g.end; continue; }
		if (c === "(") { const g = grabBalanced("(", ")", i); nested.push(g.inner); i = g.end; continue; }
		if (c === "\n" || c === ";") { endCmd(); i++; continue; }
		if (c === "&") { endCmd(); i += str[i + 1] === "&" ? 2 : 1; continue; }
		if (c === "|") { endCmd(); i += str[i + 1] === "|" ? 2 : 1; continue; }
		if (c === ">" || c === "<") { endWord(); i++; while (i < n && /[\s>&\d-]/.test(str[i])) i++; continue; }
		if (/\s/.test(c)) { endWord(); i++; continue; }
		cur += c; has = true; i++;
	}
	endCmd();
	return { commands, nested };
}

/** Drops env assignments, sudo, env, shell keywords such as then and do, and wrappers such as nohup, so argv[0] is the program that runs. */
export function effective(argv: string[]): string[] {
	let k = 0;
	while (k < argv.length) {
		const w = argv[k];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
		if (w === "sudo" || w === "doas") { k++; while (k < argv.length && argv[k].startsWith("-")) { k += argv[k] === "-u" || argv[k] === "--user" ? 2 : 1; } continue; }
		if (w === "env") { k++; while (k < argv.length && (argv[k].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k]))) k++; continue; }
		if (WRAPPERS.has(w) || KEYWORDS.has(w)) { k++; continue; }
		break;
	}
	return argv.slice(k);
}

/** The `-c` script of `bash -lc '...'` and similar, or null. */
export function shellScript(eff: string[]): string | null {
	const ci = eff.findIndex((w, idx) => idx > 0 && /^-[a-z]*c$/.test(w));
	return ci !== -1 && eff[ci + 1] ? eff[ci + 1] : null;
}

/**
 * Applies plain `NAME=value` and `export NAME=value` commands to the later words of the same script, so `URL=...; curl "$URL"`
 * reads as the literal command. A name the script never set stays as written.
 */
export function expandVars(commands: string[][], vars: Map<string, string> = new Map()): string[][] {
	const sub = (word: string) => word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole);
	const out: string[][] = [];
	for (const raw of commands) {
		const words = /^(?:export|declare|local|readonly)$/.test(raw[0] ?? "") ? raw.slice(1) : raw;
		if (words.length && words.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
			for (const w of words) vars.set(w.slice(0, w.indexOf("=")), sub(w.slice(w.indexOf("=") + 1)));
			continue;
		}
		out.push(raw.map(sub));
	}
	return out;
}
