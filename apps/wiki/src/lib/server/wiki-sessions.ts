/**
 * The append-only sessions write path for `sessions/YYYY/MM/DD/hhmm-{slug}/index.html`: opened with a goal, appended
 * to, immutable after close. `commitPage` rejects other writes to `sessions/`; this module passes `allowSessions`.
 * A session opened with `root: "agents/<agent>/jobs"` lives at `agents/<agent>/jobs/YYYY/MM/DD/hhmm-{slug}/` instead,
 * the job folder of an sw factory agent, under the `agents/` mount.
 */
import { commitPage, readForEdit, WriteError } from './wiki-write';
import { escapeHtml as esc, META_COMMENT, parseHtmlMeta } from './wiki-html';
import { normalizeRequestedPath } from './wiki';
import { kstDay, kstSessionFolder } from '../kst.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;
const ROOT = /^(sessions|agents\/[a-z0-9][a-z0-9-]{0,80}\/jobs)$/;
const SESSION_ID = /^(sessions|agents\/[^/]+\/jobs)\//;

export type SessionOpen = {
	slug: string;
	goal: string;
	agent?: string;
	/** The thread, or `<thread>:<n>` for a job, that opened the session. */
	conversation?: string;
	/** The conversation that started this one, or null for a root thread. */
	parent?: string | null;
	/** The box the opener runs on. */
	host?: string;
	/** `sessions` (the default) or `agents/<agent>/jobs`. */
	root?: string;
	title?: string;
	description?: string;
	apps?: string[];
	projects?: string[];
	domains?: string[];
	tags?: string[];
};

/** The folder and the date stamps use Korea time on any host (see src/lib/kst.mjs). */
export function sessionPath(now: Date, slug: string, root = 'sessions'): string {
	return `${root}/${kstSessionFolder(now, slug)}/index.html`;
}

const optionalText = (value: unknown, name: string): string | undefined => {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || value.length > 200) throw new WriteError(400, `${name} must be a string of at most 200 chars`);
	return value;
};

/** Open a session: create the log page with `status: open`. Returns its id (= folder path). */
export async function openSession(input: SessionOpen): Promise<{ id: string; path: string; version: number }> {
	if (!SLUG.test(input.slug ?? '')) throw new WriteError(400, 'slug must be kebab-case [a-z0-9-], 2-81 chars');
	if (!input.goal?.trim()) throw new WriteError(400, 'goal is required — a session opens with intent');
	const root = (input.root ?? 'sessions').replace(/\/+$/, '');
	if (!ROOT.test(root)) throw new WriteError(400, 'root must be "sessions" or "agents/<agent>/jobs"');
	const identity = {
		conversation: optionalText(input.conversation, 'conversation'),
		parent: input.parent === null ? null : optionalText(input.parent, 'parent'),
		host: optionalText(input.host, 'host'),
	};
	const now = new Date();
	const path = sessionPath(now, input.slug, root);
	if ((await readForEdit(path)) !== null) throw new WriteError(409, `session already exists: ${path}`);

	const title = input.title ?? input.slug.replace(/-/g, ' ');
	const meta = {
		title,
		description: input.description ?? input.goal.trim().slice(0, 200),
		kind: 'session',
		created: kstDay(now),
		date: kstDay(now),
		updated: kstDay(now),
		apps: input.apps ?? [],
		projects: input.projects ?? [],
		domains: input.domains ?? [],
		tags: input.tags ?? [],
		status: 'open',
		goal: input.goal.trim(),
		agent: input.agent ?? 'agent',
		...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)),
	};
	const content = [
		`<!--wiki\n${JSON.stringify(meta)}\n-->`,
		`<h1>${esc(title)}</h1>`,
		`<p><strong>Goal.</strong> ${esc(input.goal.trim())}</p>`,
		`<section class="session-events">`,
		`</section>`,
		'',
	].join('\n');
	const res = await commitPage({
		rawPath: path,
		content,
		author: input.agent ?? 'agent',
		summary: 'session opened',
		allowSessions: true,
	});
	return { id: path.replace(/\/index\.html$/, ''), path, version: res.version };
}

async function loadSession(rawId: string): Promise<{ path: string; content: string; meta: Record<string, unknown> }> {
	const id = normalizeRequestedPath(rawId);
	if (!SESSION_ID.test(id)) throw new WriteError(400, 'not a session id');
	const path = id.endsWith('/index.html') ? id : `${id}/index.html`;
	const content = await readForEdit(path);
	if (content === null) throw new WriteError(404, `no session at ${path}`);
	const match = content.match(META_COMMENT);
	if (!match) throw new WriteError(500, 'session page has no wiki meta comment');
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(match[1].trim()) as Record<string, unknown>;
	} catch {
		throw new WriteError(500, 'session meta comment is not valid JSON');
	}
	return { path, content, meta };
}

function withMeta(content: string, meta: Record<string, unknown>): string {
	// Function replacer: a string replacement would interpret `$1`/`$&` inside the
	// serialized meta (e.g. a goal mentioning "$10") as regex substitution patterns
	// and splice the old meta into itself.
	return content.replace(META_COMMENT, () => `<!--wiki\n${JSON.stringify(meta)}\n-->`);
}

/** Append an event to an open session. Corrections are appended too — never edited in place. */
export async function appendEvent(
	rawId: string,
	event: { summary: string; html?: string; author?: string },
): Promise<{ path: string; version: number }> {
	if (!event.summary?.trim()) throw new WriteError(400, 'event needs a summary');
	const { path, content, meta } = await loadSession(rawId);
	if (meta.status !== 'open')
		throw new WriteError(409, `session is ${String(meta.status)} — closed sessions are immutable`);
	const ts = new Date().toISOString();
	const block = [
		`<section class="session-event" data-ts="${ts}">`,
		`<h2>${esc(event.summary.trim())}</h2>`,
		`<p style="opacity:.7;font-size:12px">${ts}${event.author ? ` · ${esc(event.author)}` : ''}</p>`,
		...(event.html ? [event.html] : []),
		`</section>`,
	].join('\n');
	// The events container is the LAST </section> in an open session by construction.
	const stamped = withMeta(content, { ...meta, updated: kstDay(new Date(ts)) });
	const at = stamped.lastIndexOf('</section>');
	const next = at === -1 ? `${stamped}\n${block}\n` : `${stamped.slice(0, at)}${block}\n${stamped.slice(at)}`;
	const res = await commitPage({
		rawPath: path,
		content: next,
		author: event.author ?? 'agent',
		summary: `event: ${event.summary.trim().slice(0, 120)}`,
		allowSessions: true,
	});
	return { path, version: res.version };
}

/** Close a session: record the outcome + graduation, flip status — the page is immutable after this. */
export async function closeSession(
	rawId: string,
	close: {
		outcome: string;
		graduated_to?: string[];
		gaps_created?: string[];
		no_durable_knowledge?: boolean;
		author?: string;
	},
): Promise<{ path: string; version: number }> {
	if (!close.outcome?.trim()) throw new WriteError(400, 'close needs an outcome');
	const graduated = close.graduated_to?.length ? close.graduated_to : [];
	if (!graduated.length && !close.gaps_created?.length && !close.no_durable_knowledge) {
		throw new WriteError(
			422,
			'graduation contract: a closed session must set graduated_to, gaps_created, or no_durable_knowledge=true',
		);
	}
	const { path, content, meta } = await loadSession(rawId);
	if (meta.status !== 'open') throw new WriteError(409, `session is already ${String(meta.status)}`);
	const ts = new Date().toISOString();
	const block = [
		`<section class="session-close" data-ts="${ts}">`,
		`<h2>Closed</h2>`,
		`<p><strong>Outcome.</strong> ${esc(close.outcome.trim())}</p>`,
		...(graduated.length ? [`<p><strong>Graduated to:</strong> ${graduated.map(esc).join(' · ')}</p>`] : []),
		...(close.gaps_created?.length ? [`<p><strong>Gaps:</strong> ${close.gaps_created.map(esc).join(' · ')}</p>`] : []),
		...(close.no_durable_knowledge ? ['<p><em>No durable knowledge.</em></p>'] : []),
		`</section>`,
	].join('\n');
	const next = `${withMeta(content, {
		...meta,
		status: 'closed',
		updated: kstDay(new Date(ts)),
		outcome: close.outcome.trim(),
		graduated_to: graduated,
		gaps_created: close.gaps_created ?? [],
	})}\n${block}\n`;
	const res = await commitPage({
		rawPath: path,
		content: next,
		author: close.author ?? 'agent',
		summary: `session closed: ${close.outcome.trim().slice(0, 120)}`,
		allowSessions: true,
	});
	return { path, version: res.version };
}
