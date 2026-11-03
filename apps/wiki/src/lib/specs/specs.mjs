// Spec file parser and result store readers, with no side effects beyond reading files. A copy of auto-sns-agent's
// apps/specs/lib/specs.mjs for the /specs page; the specs, their checks and run.mjs stay in auto-sns-agent,
// whose CI runs them, and the wiki config's `specsDir` names that folder.
// Contract: apps/llm-wiki/content/sessions/2026/10/03/0327-specs-framework-redesign/contract.md
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { repoDir, wikiConfig } from '../wiki-config.mjs';

/** the specs folder, `specsDir` in the wiki config (env SPECS_DIR wins) */
export const SPECS_DIR = wikiConfig().specsDir ?? '';
/** the checkout that holds the specs folder, where run.mjs runs and commit.mjs commits */
export const REPO = repoDir('auto-sns-agent') ?? '';
/** <content root>/.wiki/spec-results; SPEC_RESULTS_DIR overrides */
export const RESULTS_DIR = resolve(process.env.SPEC_RESULTS_DIR || resolve(wikiConfig().contentRoot, '.wiki/spec-results'));
/** days are counted in the owner's zone: the 21:00 UTC cron is the 06:00 KST morning run and lands on that day */
export const TIME_ZONE = 'Asia/Seoul';
/** process env the keySources decrypt or fetch with; a check never needs them, so run.mjs redacts them and e2e children do not get them */
export const PROCESS_SECRET_NAMES = ['DOTENV_PRIVATE_KEY_STAGING', 'VERCEL_TOKEN'];
/** folders under specs/ that hold code or config, never spec files */
export const RESERVED_FOLDERS = new Set(['checks', 'lib', 'envs']);
export const ENV_NAMES = { Local: 'local', Staging: 'staging', Production: 'prod' };
export const ENV_LABELS = { local: 'Local', staging: 'Staging', prod: 'Production' };

const dayFmt = new Intl.DateTimeFormat('en-CA', {
	timeZone: TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});
/** YYYY-MM-DD in TIME_ZONE */
export const today = (d = new Date()) => dayFmt.format(d);
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' });
export const isSunday = (d = new Date()) => weekdayFmt.format(d) === 'Sun';

/** sha1 prefix of the criterion text; the row key that survives re-ordering lines */
export const hashText = (text) => createHash('sha1').update(text.trim()).digest('hex').slice(0, 8);

/** first number in the line, or null */
export const firstNumber = (s) => {
	const m = String(s).match(/(\d+(?:\.\d+)?)/);
	return m ? Number(m[1]) : null;
};

const coerce = (v) => (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);

/** `landing-ttfb field=total_ms days=7` -> { check, params } */
export function parseCheckLine(s) {
	const line = String(s ?? '').trim();
	// an old-format link (`playwright@staging:path#test name`) stays one string with no params
	if (/^[\w-]+(@\w+)?:/.test(line)) return { check: line, params: {} };
	const parts = line.split(/\s+/).filter(Boolean);
	const check = parts.shift() || 'none';
	const params = {};
	for (const p of parts) {
		const i = p.indexOf('=');
		if (i > 0) params[p.slice(0, i)] = coerce(p.slice(i + 1));
	}
	return { check, params };
}

/**
 * Parse one spec file's text. Returns the spec object, or null when the file has no
 * frontmatter with an id (not a spec). Unknown frontmatter keys land in `header`.
 */
export function parseSpec(text, file = '') {
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!fm) return null;
	const header = {};
	for (const m of fm[1].matchAll(/^([\w-]+):\s*(.*?)\s*$/gm)) header[m[1]] = m[2];
	if (!header.id) return null;
	const body = fm[2];
	const [, criteriaText = ''] = body.split(/^## Criteria\s*$/m);
	const [head] = body.split(/^## Criteria\s*$/m);

	// Prose before the criteria: a Journey paragraph, then 0 to 3 note lines. Old files carry a
	// `## Review` section; its lines are neither notes nor journey.
	let journey = '';
	const notes = [];
	let section = 'notes';
	let para = [];
	const paras = [];
	for (const raw of head.split('\n')) {
		const line = raw.trim();
		if (/^##\s/.test(line)) {
			section = /^##\s+Review/i.test(line) ? 'review' : 'notes';
			continue;
		}
		if (section === 'review') continue;
		if (!line) {
			if (para.length) paras.push(para);
			para = [];
		} else para.push(line);
	}
	if (para.length) paras.push(para);
	for (const p of paras) {
		if (!journey && /^Journey:/i.test(p[0])) journey = p.join(' ').replace(/^Journey:\s*/i, '');
		else notes.push(...p.map((l) => l.replace(/^Notes?:\s*/i, '')));
	}

	const criteria = [];
	const lines = criteriaText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^- (Local|Staging|Production):\s*(.*?)\s*$/);
		if (!m) continue;
		let checkLine = 'none';
		const next = lines[i + 1] ?? '';
		if (/^\s+check:/.test(next)) {
			checkLine = next.replace(/^\s+check:\s*/, '');
			i++;
		}
		const { check, params } = parseCheckLine(checkLine);
		const textLine = m[2];
		criteria.push({
			index: criteria.length,
			env: ENV_NAMES[m[1]],
			text: textLine,
			check,
			params,
			number: firstNumber(textLine),
			hash: hashText(textLine),
		});
	}

	const folder = file ? relative(SPECS_DIR, dirname(resolve(SPECS_DIR, file))) || '.' : '.';
	return {
		id: header.id,
		title: header.title ?? '',
		status: header.status === 'draft' ? 'draft' : 'approved',
		every: header.every === 'weekly' || header.every === 'manual' ? header.every : 'daily',
		cost: header.cost === 'paid' ? 'paid' : 'free',
		prodWrites: /^(yes|true)$/i.test(header['prod-writes'] ?? ''),
		journey,
		notes: notes.slice(0, 3).join('\n'),
		criteria,
		file: file ? relative(SPECS_DIR, resolve(SPECS_DIR, file)) : '',
		path: file ? resolve(SPECS_DIR, file) : '',
		folder,
		header,
	};
}

/** The contract file text for a spec object; the one serializer the page writes through. */
export function formatSpec(spec) {
	const lines = ['---', `id: ${spec.id}`, `title: ${spec.title ?? ''}`];
	if (spec.status === 'draft') lines.push('status: draft');
	if (spec.every && spec.every !== 'daily') lines.push(`every: ${spec.every}`);
	if (spec.cost === 'paid') lines.push('cost: paid');
	if (spec.prodWrites) lines.push('prod-writes: yes');
	lines.push('---', '');
	if (spec.journey) lines.push(`Journey: ${spec.journey.trim()}`, '');
	if (spec.notes) lines.push(spec.notes.trim(), '');
	lines.push('## Criteria', '');
	for (const c of spec.criteria ?? []) {
		lines.push(`- ${ENV_LABELS[c.env] ?? c.env}: ${c.text.trim()}`);
		const params = Object.entries(c.params ?? {})
			.map(([k, v]) => ` ${k}=${v}`)
			.join('');
		lines.push(`  check: ${c.check || 'none'}${params}`);
	}
	return lines.join('\n') + '\n';
}

function walk(dir, out) {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (dir === SPECS_DIR && RESERVED_FOLDERS.has(name)) continue;
			walk(p, out);
		} else if (name.endsWith('.md') && name !== 'AGENTS.md') out.push(p);
	}
	return out;
}

/** Every spec file under apps/specs, sorted by file path. */
export function loadSpecs({ dir = SPECS_DIR } = {}) {
	if (!existsSync(dir)) return [];
	const specs = [];
	for (const p of walk(dir, [])) {
		const spec = parseSpec(readFileSync(p, 'utf8'), p);
		if (spec) specs.push(spec);
	}
	return specs;
}

export const findSpec = (specs, id) => specs.find((s) => s.id === id) ?? null;

/** rows.jsonl under <store>/<day>/, one JSON object per line; bad lines are skipped */
function readRowsFile(file) {
	if (!existsSync(file)) return [];
	const rows = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// a half-written line from a run in flight is not a row
		}
	}
	return rows;
}

/** the calendar days (TIME_ZONE) ending on `end`, oldest first */
export function dayWindow(days, end = new Date()) {
	const out = [];
	const t = Date.parse(today(end) + 'T00:00:00Z');
	for (let i = days - 1; i >= 0; i--) out.push(new Date(t - i * 86400_000).toISOString().slice(0, 10));
	return out;
}

/**
 * Rows from the result store for the last `days` calendar days.
 * Returns { days, rows, latest(spec, hash, env, day), latestFor(spec, hash, env) }.
 * The newest row (by `at`) per (spec, hash, env, day) is the status for that day; rows with `mutate` set are
 * failure-case rehearsals and never the status.
 */
export function loadRows({ days = 14, dir = RESULTS_DIR, end = new Date() } = {}) {
	const window = dayWindow(days, end);
	const wanted = new Set(window);
	const rows = [];
	if (existsSync(dir)) {
		for (const day of readdirSync(dir).sort()) {
			if (!wanted.has(day)) continue;
			rows.push(...readRowsFile(join(dir, day, 'rows.jsonl')));
		}
	}
	rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
	const byDay = new Map();
	const byCriterion = new Map();
	for (const r of rows) {
		if (r.mutate) continue; // a --mutate rehearsal row never becomes the status
		byDay.set(`${r.spec}#${r.hash}#${r.env}#${r.day}`, r);
		byCriterion.set(`${r.spec}#${r.hash}#${r.env}`, r);
	}
	return {
		days: window,
		rows,
		latest: (spec, hash, env, day) => byDay.get(`${spec}#${hash}#${env}#${day}`) ?? null,
		latestFor: (spec, hash, env) => byCriterion.get(`${spec}#${hash}#${env}`) ?? null,
	};
}

/**
 * Absolute path of an artifact listed in a row (row.artifacts are relative to the store). Refuses a path that leaves
 * the store lexically (../) and, when the file exists, one that leaves it through a symlink.
 */
export const artifactPath = (rel, dir = RESULTS_DIR) => {
	const root = resolve(dir);
	const p = resolve(root, rel);
	if (!p.startsWith(root + '/')) throw new Error(`artifact outside the store: ${rel}`);
	if (existsSync(p)) {
		const realRoot = realpathSync(root);
		if (!realpathSync(p).startsWith(realRoot + '/')) throw new Error(`artifact outside the store: ${rel}`);
	}
	return p;
};
