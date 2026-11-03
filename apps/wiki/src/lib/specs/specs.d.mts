/** Types for specs.mjs, the one spec parser shared by run.mjs and the /specs page. Keep in step with specs.mjs. */
export type Env = 'local' | 'staging' | 'prod';
export type Every = 'daily' | 'weekly' | 'manual';
export type Params = Record<string, string | number>;

export type Criterion = {
	index: number;
	env: Env;
	text: string;
	check: string;
	params: Params;
	number: number | null;
	hash: string;
};

export type Spec = {
	id: string;
	title: string;
	status: 'draft' | 'approved';
	every: Every;
	cost: 'free' | 'paid';
	prodWrites: boolean;
	journey: string;
	notes: string;
	criteria: Criterion[];
	/** relative to apps/llm-wiki/specs */
	file: string;
	/** absolute path */
	path: string;
	folder: string;
	header: Record<string, string>;
};

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
	/** relative to RESULTS_DIR */
	artifacts: string[];
	mutate?: Record<string, number | string>;
};

export type RowStore = {
	days: string[];
	rows: Row[];
	latest(spec: string, hash: string, env: string, day: string): Row | null;
	latestFor(spec: string, hash: string, env: string): Row | null;
};

export const SPECS_DIR: string;
export const REPO: string;
export const RESULTS_DIR: string;
export const TIME_ZONE: string;
export const RESERVED_FOLDERS: Set<string>;
export const ENV_NAMES: Record<'Local' | 'Staging' | 'Production', Env>;
export const ENV_LABELS: Record<Env, string>;
export function today(d?: Date): string;
export function isSunday(d?: Date): boolean;
export function hashText(text: string): string;
export function firstNumber(s: unknown): number | null;
export function parseCheckLine(s: unknown): { check: string; params: Params };
export function parseSpec(text: string, file?: string): Spec | null;
export type SpecInput = {
	id: string;
	title?: string;
	status?: 'draft' | 'approved';
	every?: Every;
	cost?: string;
	prodWrites?: boolean;
	journey?: string;
	notes?: string;
	criteria?: Array<{ env: Env | string; text: string; check?: string; params?: Params }>;
};
export function formatSpec(spec: SpecInput): string;
export function loadSpecs(options?: { dir?: string }): Spec[];
export function findSpec(specs: Spec[], id: string): Spec | null;
export function dayWindow(days: number, end?: Date): string[];
export function loadRows(options?: { days?: number; dir?: string; end?: Date }): RowStore;
export function artifactPath(rel: string, dir?: string): string;
