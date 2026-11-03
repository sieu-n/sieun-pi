/** Shapes the /specs page and its api routes share. The server builds them from apps/specs/lib/specs.mjs. */
export type Env = 'local' | 'staging' | 'prod';
export const ENV_LABEL: Record<Env, string> = { local: 'Local', staging: 'Staging', prod: 'Production' };

/** One result row as the runner writes it to spec-results/<day>/rows.jsonl. */
export type Row = {
	day: string;
	at: string;
	spec: string;
	criterion: number;
	hash: string;
	text: string;
	env: Env;
	check: string;
	pass: boolean;
	error: string | null;
	duration_ms: number;
	cost: string;
	writes: boolean;
	metrics: Record<string, number | string>;
	note: string;
	artifacts: string[];
};

export type Criterion = {
	index: number;
	env: Env;
	text: string;
	check: string;
	params: Record<string, string | number>;
	hash: string;
	/** one entry per day in `SpecsPage.days`: true pass, false fail, null no row */
	cells: (boolean | null)[];
	/** newest row for this criterion inside the window */
	latest: Row | null;
};

export type Spec = {
	id: string;
	title: string;
	status: 'draft' | 'approved';
	every: 'daily' | 'weekly' | 'manual';
	journey: string;
	notes: string;
	/** path relative to apps/specs */
	file: string;
	folder: string;
	criteria: Criterion[];
};

export type Folder = { path: string; specs: Spec[] };

export type SpecsPage = {
	/** true on a loopback dev server; play, edit and approve show only then */
	local: boolean;
	/** calendar days, oldest first */
	days: string[];
	folders: Folder[];
	/** specs the parser could not read, as "file: reason" */
	problems: string[];
};

/** What PATCH /api/specs/SPEC-n accepts. Every field is optional; absent fields keep the file's value. */
export type SpecPatch = {
	title?: string;
	journey?: string;
	notes?: string;
	/** criterion text by index; env and check line stay */
	criteria?: { index: number; text: string }[];
	status?: 'draft' | 'approved';
};
