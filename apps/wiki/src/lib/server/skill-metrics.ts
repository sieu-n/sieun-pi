import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { scriptEnv } from './script-env';

const execFileP = promisify(execFile);

/** The store is machine-local DuckDB under content/.wiki; it never ships. */
export const SKILL_METRICS_ENABLED = dev || env.WIKI_EDITABLE === 'true';

const SCRIPT = resolve(process.cwd(), 'scripts/skill-metrics.py');

async function runTool(args: string[]): Promise<unknown> {
	const { stdout } = await execFileP('uv', ['run', '--no-project', '--with', 'duckdb', 'python', SCRIPT, ...args], {
		cwd: process.cwd(),
		env: scriptEnv(),
		maxBuffer: Infinity,
	});
	return JSON.parse(stdout);
}

export interface SkillMetricsHost {
	host: string;
	skills: number;
	visible_skills: number;
	skill_description_chars: number;
	rules: number | null;
	always_injected_rule_chars: number | null;
}

export interface SkillMetricsItem {
	host: string;
	layer: 'skill' | 'rule';
	display_id: string;
	name: string;
	description: string;
	description_chars: number;
	body_chars: number;
	visible: boolean;
	root_kind: string;
	precedence_rank: number | null;
	skill_key: string;
	reads: number;
	reader_sessions: number;
	last_read: string | null;
}

export interface SkillMetrics {
	snapshot: { id: string; ts: string; repo_head: string | null; skipped: { host: string; reason: string }[] };
	hosts: SkillMetricsHost[];
	items: SkillMetricsItem[];
	reads_by_host: { agent: string; reads: number; sessions: number; first_seen: string; last_seen: string }[];
	reads_daily: { day: string; agent: string; reads: number }[];
	error?: string;
}

/** Snapshot the skills on disk first; the store skips the write when nothing changed. */
export async function loadSkillMetrics(days = 30): Promise<SkillMetrics> {
	await runTool(['snapshot']);
	return (await runTool(['export', '--days', String(days)])) as SkillMetrics;
}
