/**
 * The code of a source file with its comments and docstrings removed, so wiki-stale.ts can tell a commit that changed what
 * the code does from one that only reworded or cut its comments.
 */

/** @param {string} text */
const lines = (text) =>
	text
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim())
		.join('\n');

/** @param {string} line */
const indent = (line) => line.length - line.trimStart().length;

/** @param {string} text @param {number} from */
const lineEnd = (text, from) => {
	const end = text.indexOf('\n', from);
	return end < 0 ? text.length : end;
};

const PY_STRING = /^[rRbBuUfF]{0,2}("""|'''|"|')/;

/**
 * Python without `#` comments, without a string that stands alone as a statement, which covers every docstring, and
 * without a lone `pass`, which a cut docstring of an empty class leaves behind.
 * @param {string} text
 */
function python(text) {
	let out = '';
	let depth = 0;
	let statementStart = true;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '#') {
			i = lineEnd(text, i);
			continue;
		}
		if (c === '\n') {
			if (depth === 0 && text[i - 1] !== '\\') statementStart = true;
			out += c;
			i += 1;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			out += c;
			i += 1;
			continue;
		}
		const quote = /\w/.test(text[i - 1] ?? '') ? null : PY_STRING.exec(text.slice(i, i + 5));
		if (quote) {
			const delimiter = quote[1];
			let end = i + quote[0].length;
			while (end < text.length && !text.startsWith(delimiter, end)) {
				if (delimiter.length === 1 && text[end] === '\n') break;
				end += text[end] === '\\' ? 2 : 1;
			}
			end = Math.min(text.length, end + delimiter.length);
			const rest = text.slice(end, lineEnd(text, end)).trim();
			const alone = statementStart && depth === 0 && (!rest || rest.startsWith('#'));
			if (!alone) out += text.slice(i, end);
			statementStart = false;
			i = end;
			continue;
		}
		if ('([{'.includes(c)) depth += 1;
		if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
		statementStart = false;
		out += c;
		i += 1;
	}
	return out.replace(/^[ \t]*pass[ \t]*$/gm, '');
}

const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

/**
 * JavaScript or TypeScript without `//` and block comments, read past strings, template literals and regex literals.
 * @param {string} text
 */
function script(text) {
	let out = '';
	/** @type {number[]} */
	const templates = [];
	let braces = 0;
	let last = '';
	let word = '';
	let i = 0;
	/** @param {number} from */
	const template = (from) => {
		let end = from;
		while (end < text.length && text[end] !== '`') {
			if (text[end] === '\\') end += 2;
			else if (text.startsWith('${', end)) {
				templates.push(braces);
				braces += 1;
				return end + 2;
			} else end += 1;
		}
		return Math.min(text.length, end + 1);
	};
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === '/' && next === '/') {
			i = lineEnd(text, i);
			continue;
		}
		if (c === '/' && next === '*') {
			const close = text.indexOf('*/', i + 2);
			i = close < 0 ? text.length : close + 2;
			out += ' ';
			continue;
		}
		if (/\s/.test(c)) {
			out += c;
			i += 1;
			continue;
		}
		let end = i + 1;
		if (c === '"' || c === "'") {
			while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(text.length, end + 1);
		} else if (c === '`') {
			end = template(i + 1);
		} else if (c === '}' && templates.length && templates[templates.length - 1] === braces - 1) {
			templates.pop();
			braces -= 1;
			end = template(i + 1);
		} else if (c === '/' && (!last || REGEX_AFTER.has(last) || REGEX_KEYWORDS.has(word))) {
			let inClass = false;
			while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
				if (text[end] === '[') inClass = true;
				if (text[end] === ']') inClass = false;
				end += text[end] === '\\' ? 2 : 1;
			}
			end = Math.min(text.length, end + 1);
			while (/[a-z]/.test(text[end] ?? '')) end += 1;
		} else if (/[\w$]/.test(c)) {
			while (/[\w$]/.test(text[end] ?? '')) end += 1;
		} else if (c === '{') braces += 1;
		else if (c === '}') braces = Math.max(0, braces - 1);
		const token = text.slice(i, end);
		out += token;
		word = /^[\w$]+$/.test(token) ? token : '';
		last = word ? 'w' : token[token.length - 1];
		i = end;
	}
	return out;
}

/**
 * A style sheet without `/* *\/` comments, and without `//` line comments when `lines` is set, as SCSS and Less read
 * them, outside quoted strings and an unquoted `url(...)`, so `url(https://a.example/x.png)` stays. JSON with comments
 * (JSONC, JSON5) reads the same way, because valid JSON holds no `url(` outside a string, so a turbo.json key such as
 * `"//#ci:guards"` and a value such as `"https://x"` stay.
 * @param {boolean} lines
 */
const css = (lines) => (/** @type {string} */ text) => {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			i = close < 0 ? text.length : close + 2;
			out += ' ';
			continue;
		}
		if (lines && c === '/' && text[i + 1] === '/') {
			i = lineEnd(text, i);
			continue;
		}
		let end = i + 1;
		if (c === '"' || c === "'") {
			while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(text.length, end + 1);
		} else if (/^url\([ \t]*[^'"\s)]/i.test(text.slice(i, i + 6)) && !/[\w-]/.test(text[i - 1] ?? '')) {
			end = text.indexOf(')', i) + 1 || text.length;
		}
		out += text.slice(i, end);
		i = end;
	}
	return out;
};

/**
 * JSON with no whitespace outside its strings and one line per member: a line break after each `{`, `[` and `,` and before
 * each `}` and `]`, so a commit that only reflows a value, such as a one-line object split over several lines, changes no line.
 * JSONC and JSON5 read the same way after their comments go. Python and YAML keep their indentation, which is code there. On
 * 2026-11-22 auto-sns-agent c8e3e5589e split the one-line `m02-ci-monitor` and `m02-land-tick` objects of
 * apps/infra/komodo/stacks.json over several lines and changed no value, and the 14:22 KST dream run flagged the 2 pages
 * citing them. On a replay of the 2,034 dream rechecks in the 7 days to 2026-11-22 06:00Z, 1,865 behind a flag, this drops
 * those 2, both `last_verified` only, and none of the rechecks that changed a page body
 * (~/work/wiki-stale-reflow-and-shared-keys/).
 * @param {string} text
 */
function jsonLayout(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		let end = i + 1;
		if (c === '"' || c === "'") {
			while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(text.length, end + 1);
			out += text.slice(i, end);
		} else if ('{[,'.includes(c)) out += `${c}\n`;
		else if ('}]'.includes(c)) out += `\n${c}`;
		else if (!/\s/.test(c)) out += c;
		i = end;
	}
	return out;
}

/**
 * SQL without `--` line comments and `/* *\/` block comments, which may nest, as PostgreSQL and ClickHouse read them,
 * outside a `'` string (with `''` or `\'` inside), a `"` or backtick quoted identifier.
 * @param {string} text
 */
function sql(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '-' && text[i + 1] === '-') {
			i = lineEnd(text, i);
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			let depth = 0;
			while (i < text.length) {
				if (text.startsWith('/*', i)) {
					depth += 1;
					i += 2;
				} else if (text.startsWith('*/', i)) {
					depth -= 1;
					i += 2;
					if (!depth) break;
				} else i += 1;
			}
			out += ' ';
			continue;
		}
		let end = i + 1;
		if (c === "'" || c === '"' || c === '`') {
			while (end < text.length) {
				if (text[end] === c && text[end + 1] === c) end += 2;
				else if (text[end] === c) break;
				else end += c === "'" && text[end] === '\\' ? 2 : 1;
			}
			end = Math.min(text.length, end + 1);
		}
		out += text.slice(i, end);
		i = end;
	}
	return out;
}

/**
 * Svelte with its scripts read as JavaScript, its styles read as CSS, or as SCSS or Less by their `lang`, and `<!-- -->`
 * and whole `//` comment lines of its template expressions cut from its markup.
 * @param {string} text
 */
function svelte(text) {
	return text
		.split(/(<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>)/)
		.map((part) => {
			const open = /^<(script|style)\b[^>]*>/.exec(part);
			if (!open) return part.replace(/<!--[\s\S]*?-->/g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
			const close = `</${open[1]}>`;
			const body = part.slice(open[0].length, part.length - close.length);
			const style = css(/\blang=["']?(?:scss|less)\b/.test(open[0]));
			return open[0] + (open[1] === 'script' ? script(body) : style(body)) + close;
		})
		.join('');
}

/**
 * Shell without `#` comments: a `#` that starts a word outside quotes, so `$#` and `${#name}` stay.
 * @param {string} text
 */
function shell(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '#' && (i === 0 || /[\s;|&()]/.test(text[i - 1]))) {
			i = lineEnd(text, i);
			continue;
		}
		let end = i + 1;
		if (c === '\\') end = i + 2;
		else if (c === "'") end = text.indexOf("'", i + 1) + 1 || text.length;
		else if (c === '"') {
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(text.length, end + 1);
		}
		out += text.slice(i, end);
		i = end;
	}
	return out;
}

/** Where a YAML value starts, so a quote there opens a quoted string, while the `'` of `don't` in a plain value is text. */
const YAML_VALUE = /(?:^|[:?-][ \t]|[[{,])[ \t]*$/;
/** A YAML line whose value is a block scalar, `key: |`, `- >-` or `key: |2`. */
const YAML_BLOCK = /(?:^|[:?-])[ \t]+[|>][-+1-9]{0,2}[ \t]*$/;
/** A block scalar under a `run` key, a GitHub Actions step's script, as `run: |` or `- run: >-`. */
const YAML_RUN = /^[ \t]*(?:-[ \t]+)?run[ \t]*:/;
/** A shell heredoc opener in a script line, `<<EOF`, `<<-'EOF'` or `<< "EOF"`, whose body lines are text, not comments. */
const HEREDOC_OPEN = /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/;

/**
 * YAML or TOML without `#` comments: a `#` at a line start or after a space or tab, outside a quoted string, a TOML
 * `"""` or `'''` string and a YAML block scalar body (the lines under `key: |` or `key: >` that sit deeper than that key),
 * which all stay as they are, except that a `run` block scalar drops its whole-line shell `#` comments outside a heredoc and
keeps a `#!` line. A YAML quote opens a string only where a value starts. It does not read a TOML comment with
 * no space before its `#` (`a = 1#note`), a YAML block scalar with an explicit indent less than its key's, or a YAML tag or
 * anchor before a quote (`!!str "a # b"`), so those keep their comment text as code.
 * @param {string} text
 * @param {boolean} yaml
 */
function hashComments(text, yaml) {
	let out = '';
	let lineStart = 0;
	let outLine = 0;
	let block = -1;
	let run = false;
	let heredoc = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (i === lineStart && block >= 0) {
			const line = text.slice(i, lineEnd(text, i));
			if (!line.trim() || indent(line) > block) {
				const body = line.trim();
				const comment = run && !heredoc && body.startsWith('#') && !body.startsWith('#!');
				if (heredoc && body === heredoc) heredoc = '';
				else if (run && !heredoc && !comment) heredoc = HEREDOC_OPEN.exec(body)?.[2] ?? '';
				if (!comment) out += text.slice(i, i + line.length + 1);
				i += line.length + 1;
				lineStart = i;
				outLine = out.length;
				continue;
			}
			block = -1;
		}
		if (c === '#' && (i === lineStart || /[ \t]/.test(text[i - 1]))) {
			i = lineEnd(text, i);
			continue;
		}
		if (c === '\n') {
			if (yaml && YAML_BLOCK.test(out.slice(outLine))) {
				block = indent(text.slice(lineStart, i));
				run = YAML_RUN.test(out.slice(outLine));
				heredoc = '';
			}
			out += c;
			i += 1;
			lineStart = i;
			outLine = out.length;
			continue;
		}
		let end = i + 1;
		const triple = !yaml && (text.startsWith('"""', i) || text.startsWith("'''", i));
		if (triple) {
			const close = text.indexOf(c.repeat(3), i + 3);
			end = close < 0 ? text.length : close + 3;
		} else if ((c === '"' || c === "'") && (!yaml || YAML_VALUE.test(text.slice(lineStart, i)))) {
			while (end < text.length && (text[end] !== c || (yaml && c === "'" && text[end + 1] === "'"))) {
				if (!yaml && text[end] === '\n') break;
				end += (c === '"' && text[end] === '\\') || (c === "'" && text[end] === "'") ? 2 : 1;
			}
			end = Math.min(text.length, end + 1);
		}
		const token = text.slice(i, end);
		out += token;
		const newline = token.lastIndexOf('\n');
		if (newline >= 0) {
			lineStart = i + newline + 1;
			outLine = out.length - (token.length - newline - 1);
		}
		i = end;
	}
	return out;
}

/** @param {string} text */
const yaml = (text) => hashComments(text, true);
/** @param {string} text */
const toml = (text) => hashComments(text, false);

const HEREDOC = /^<<([A-Za-z0-9_-]+)[ \t]*$/;

/**
 * A Caddyfile without `#` comments: a `#` that starts a token, at a line start or after a space or tab, outside a `"` or
 * backtick quoted token and a `<<MARKER` heredoc body, so `http://host/#top`, `header X a#b` and `respond "a #b"` stay.
 * @param {string} text
 */
function caddyfile(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		const tokenStart = i === 0 || /\s/.test(text[i - 1]);
		if (c === '#' && tokenStart) {
			i = lineEnd(text, i);
			continue;
		}
		let end = i + 1;
		const heredoc = tokenStart && c === '<' ? HEREDOC.exec(text.slice(i, lineEnd(text, i))) : null;
		if (heredoc) {
			const close = new RegExp(`\\n[ \\t]*${heredoc[1]}(?=\\s|$)`).exec(text.slice(i));
			end = close ? i + close.index + close[0].length : text.length;
		} else if (c === '"') {
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(text.length, end + 1);
		} else if (c === '`') end = text.indexOf('`', i + 1) + 1 || text.length;
		out += text.slice(i, end);
		i = end;
	}
	return out;
}

/**
 * A file without its whole-line comments, the lines whose first character after indent is one of `markers`, as a
 * Dockerfile, a systemd unit or a `.gitignore` reads them, where a `#` later in a line is text. A Dockerfile parser
 * directive (`# syntax=`, `# escape=`, `# check=`) stays, because it changes how the file builds.
 * @param {string} markers
 */
const lineComments = (markers) => (/** @type {string} */ text) =>
	text
		.split('\n')
		.filter((line) => !markers.includes(line.trimStart()[0] ?? ' ') || /^#\s*(?:syntax|escape|check)\s*=/i.test(line.trim()))
		.join('\n');

/** Each language this module reads, matched on the file's base name. */
const LANGUAGES = [
	{ match: /\.pyi?$/, strip: python },
	{ match: /\.[cm]?[jt]sx?$/, strip: script },
	{ match: /\.svelte$/, strip: svelte },
	{ match: /\.(?:css|pcss|postcss)$/, strip: css(false) },
	{ match: /\.(?:scss|less)$/, strip: css(true) },
	{ match: /\.sql$/, strip: sql },
	{ match: /\.json[c5]?$/, strip: (text) => jsonLayout(css(true)(text)) },
	{ match: /\.(?:sh|bash|zsh)$/, strip: shell },
	{ match: /\.ya?ml$/, strip: yaml },
	{ match: /\.toml$|^\.env(?:\.[\w.-]+)?$/, strip: toml },
	{ match: /^(?:.+\.)?Caddyfile$|\.caddy$/, strip: caddyfile },
	{ match: /^(?:.+\.)?Dockerfile(?:\..+)?$|\.dockerfile$/i, strip: lineComments('#') },
	{ match: /\.(?:service|timer|socket|path|target|mount)$/, strip: lineComments('#;') },
	{ match: /^\.(?:git|docker|prettier|eslint)?ignore$/, strip: lineComments('#') },
];

/** The language a file with no dot in its name reads as, from its `#!` line, such as `.githooks/pre-push`. */
const SHEBANGS = [
	{ match: /^#!.*\b(?:sh|bash|zsh)\b/, strip: shell },
	{ match: /^#!.*\bpython/, strip: python },
	{ match: /^#!.*\b(?:node|bun|deno|tsx)\b/, strip: script },
];

/**
 * The code of `text`, read as the language of `file`, without comments, docstrings, trailing spaces or blank lines;
 * `text` as it is for a language this module does not read.
 * @param {string} text
 * @param {string} file
 * @returns {string}
 */
export function codeText(text, file) {
	const name = file.split('/').pop() ?? file;
	const first = text.slice(0, lineEnd(text, 0));
	const language =
		LANGUAGES.find(({ match }) => match.test(name)) ??
		(!name.includes('.') && first.startsWith('#!') ? SHEBANGS.find(({ match }) => match.test(first)) : undefined);
	return language ? lines(language.strip(text)) : text;
}
