import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODE_PREFIX, getRepoRoot, isMirrorDocumentPath } from './wiki-mirror';

const execFileP = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const COMMIT_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';

export type GitRevision = {
	commit: string;
	author: string;
	ts: string;
	summary: string;
	linesAdded: number;
	linesRemoved: number;
};

export type GitHistory = {
	available: boolean;
	count: number | null;
	lastEditedAt: string | null;
	revisions: GitRevision[];
	error: string | null;
};

export type GitHistorySummary = Omit<GitHistory, 'revisions'>;

let summaryCache: { expiresAt: number; value: Map<string, GitHistorySummary> } | null = null;

function mirrorToRepoPath(wikiPath: string): string {
	if (!wikiPath.startsWith(CODE_PREFIX)) throw new Error('Git history is only available for @code paths');
	const repoPath = wikiPath.slice(CODE_PREFIX.length);
	if (!isMirrorDocumentPath(repoPath)) {
		throw new Error('Invalid @code path');
	}
	return repoPath;
}

function parseCount(value: string): number {
	if (!/^\d+$/.test(value)) return 0;
	return Number(value);
}

export function parseGitHistory(output: string): GitRevision[] {
	return output
		.split(COMMIT_SEPARATOR)
		.slice(1)
		.map((block) => {
			const [header = '', ...numstat] = block.replace(/^\n/, '').split('\n');
			const [commit = '', ts = '', author = '', summary = ''] = header.split(FIELD_SEPARATOR);
			let linesAdded = 0;
			let linesRemoved = 0;
			for (const line of numstat) {
				const [added = '', removed = ''] = line.split('\t');
				linesAdded += parseCount(added);
				linesRemoved += parseCount(removed);
			}
			return { commit, ts, author, summary, linesAdded, linesRemoved };
		})
		.filter((revision) => revision.commit.length > 0);
}

export function parseGitSummary(output: string, requestedPaths: string[]): Map<string, GitHistorySummary> {
	const requested = new Set(requestedPaths.map(mirrorToRepoPath));
	const byRepoPath = new Map<string, { count: number; lastEditedAt: string | null }>();
	for (const block of output.split(COMMIT_SEPARATOR).slice(1)) {
		const [header = '', ...files] = block.replace(/^\n/, '').split('\n');
		const [, ts = ''] = header.split(FIELD_SEPARATOR);
		for (const repoPath of new Set(files.map((file) => file.trim()).filter(Boolean))) {
			if (!requested.has(repoPath)) continue;
			const current = byRepoPath.get(repoPath) ?? { count: 0, lastEditedAt: null };
			byRepoPath.set(repoPath, {
				count: current.count + 1,
				lastEditedAt: current.lastEditedAt ?? ts ?? null,
			});
		}
	}
	return new Map(
		requestedPaths.map((wikiPath) => {
			const value = byRepoPath.get(mirrorToRepoPath(wikiPath)) ?? { count: 0, lastEditedAt: null };
			return [wikiPath, { available: true, ...value, error: null }];
		}),
	);
}

export async function getMirrorHistory(wikiPath: string): Promise<GitHistory> {
	try {
		const repoPath = mirrorToRepoPath(wikiPath);
		const { stdout } = await execFileP(
			'git',
			[
				'log',
				'--follow',
				'--find-renames=20%',
				`--format=${COMMIT_SEPARATOR}%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%s`,
				'--numstat',
				'--',
				repoPath,
			],
			{ cwd: getRepoRoot(), maxBuffer: Infinity },
		);
		const revisions = parseGitHistory(stdout);
		return {
			available: true,
			count: revisions.length,
			lastEditedAt: revisions[0]?.ts ?? null,
			revisions,
			error: null,
		};
	} catch (error) {
		return {
			available: false,
			count: null,
			lastEditedAt: null,
			revisions: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getMirrorHistorySummaries(paths: string[]): Promise<Map<string, GitHistorySummary>> {
	if (summaryCache && summaryCache.expiresAt > Date.now() && paths.every((path) => summaryCache?.value.has(path))) {
		return new Map(paths.map((path) => [path, summaryCache?.value.get(path) as GitHistorySummary]));
	}
	try {
		const { stdout } = await execFileP(
			'git',
			[
				'log',
				`--format=${COMMIT_SEPARATOR}%H${FIELD_SEPARATOR}%aI`,
				'--name-only',
				'--',
				'.agents/skills',
				'.claude/skills-native',
			],
			{ cwd: getRepoRoot(), maxBuffer: Infinity },
		);
		const value = parseGitSummary(stdout, paths);
		summaryCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
		return value;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Map(paths.map((path) => [path, unavailable(message)]));
	}
}

function unavailable(error: string): GitHistorySummary {
	return { available: false, count: null, lastEditedAt: null, error };
}
