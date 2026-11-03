export type WikiMeta = {
	title?: string;
	date?: string;
	created?: string;
	updated?: string;
	apps: string[];
	tags: string[];
	status?: string;
	kind?: string;
	projects?: string[];
	domains?: string[];
	owner?: string;
	summary?: string;
	description?: string;
	canonical_for?: string[];
	last_verified?: string;
	source_refs?: string[];
	archived_reason?: string;
	superseded_by?: string;
	goal?: string;
	outcome?: string;
	graduated_to?: string[];
	gaps_created?: string[];
	agent?: string;
	conversation?: string;
	parent?: string;
	host?: string;
};

/** Scalar fields copied verbatim from frontmatter / the HTML meta JSON. */
export const META_STRING_KEYS = [
	'title',
	'date',
	'created',
	'updated',
	'status',
	'kind',
	'owner',
	'summary',
	'description',
	'last_verified',
	'archived_reason',
	'superseded_by',
	'goal',
	'outcome',
	'agent',
	'conversation',
	'parent',
	'host',
] as const;
/** Array-of-string fields. */
export const META_LIST_KEYS = [
	'apps',
	'tags',
	'projects',
	'domains',
	'canonical_for',
	'source_refs',
	'graduated_to',
	'gaps_created',
] as const;

/** Contract accessors that accept the aliases `summary` → `description` and `date` → `created`. */
export function metaDescription(meta: WikiMeta): string | null {
	return meta.description ?? meta.summary ?? null;
}

export function metaCreated(meta: WikiMeta): string | null {
	return meta.created ?? meta.date ?? null;
}

/** Parse a leading YAML frontmatter block for the fields the wiki views use. */
export function parseFrontmatter(content: string): WikiMeta {
	const meta: WikiMeta = { apps: [], tags: [] };
	if (!content.startsWith('---')) return meta;
	const end = content.indexOf('\n---', 3);
	if (end === -1) return meta;
	for (const line of content.slice(3, end).split('\n')) {
		const match = line.match(/^([A-Za-z_]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1].toLowerCase() as keyof WikiMeta;
		const value = unquote(match[2].trim());
		if ((META_STRING_KEYS as readonly string[]).includes(key)) (meta as Record<string, unknown>)[key] = value;
		else if ((META_LIST_KEYS as readonly string[]).includes(key))
			(meta as Record<string, unknown>)[key] = parseList(value);
	}
	return meta;
}

function parseList(value: string): string[] {
	return value
		.replace(/^\[|\]$/g, '')
		.split(',')
		.map((item) => unquote(item.trim()))
		.filter(Boolean);
}

function unquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, '');
}
