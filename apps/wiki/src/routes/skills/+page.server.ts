import { getWikiIndex } from '$lib/server/wiki';
import { getMirrorHistorySummaries } from '$lib/server/wiki-git-history';
import { loadSkillMetrics, SKILL_METRICS_ENABLED } from '$lib/server/skill-metrics';
import { statsFor } from '$lib/server/wiki-store';

const GROUP_ORDER = ['apps', 'stack', 'repo', 'workflows', 'symphony', 'claude-native'] as const;
const GROUP_LABEL: Record<string, string> = {
	apps: 'Apps — one per product surface',
	stack: 'Stack — technologies and external APIs',
	repo: 'Repo — cross-cutting engineering system',
	workflows: 'Workflows — task loops and gates',
	symphony: 'Symphony — Linear issue-agent only',
	'claude-native': 'Claude-native — Claude Code only, invisible to Codex',
};

function metricsFailure(err: unknown): { error: string } {
	return { error: err instanceof Error ? err.message : String(err) };
}

/** The skill-library map, a view over the read-only `@code/` mirror whose index already carries every SKILL.md. */
export async function load() {
	const index = await getWikiIndex();
	const skills: {
		id: string;
		group: string;
		path: string;
		title: string;
		description: string;
		trackedViews: number;
		viewsHuman: number;
		viewsAgent: number;
		committedEdits: number | null;
		lastEditedAt: string | null;
		historyAvailable: boolean;
	}[] = [];
	for (const [path, page] of index.byPath) {
		const m =
			/^@code\/\.agents\/skills\/(.+)\/SKILL\.md$/.exec(path) ??
			/^@code\/\.claude\/skills-native\/(.+)\/SKILL\.md$/.exec(path);
		if (!m) continue;
		const isNative = path.includes('/.claude/skills-native/');
		skills.push({
			id: m[1],
			group: isNative ? 'claude-native' : m[1].split('/')[0],
			path,
			title: page.title,
			description: page.meta?.description ?? page.excerpt ?? '',
			trackedViews: 0,
			viewsHuman: 0,
			viewsAgent: 0,
			committedEdits: null,
			lastEditedAt: null,
			historyAvailable: false,
		});
	}
	const paths = skills.map((skill) => skill.path);
	const viewStats = statsFor(paths);
	const editStats = await getMirrorHistorySummaries(paths);
	for (const skill of skills) {
		const views = viewStats.get(skill.path);
		const edits = editStats.get(skill.path);
		skill.trackedViews = views?.views ?? 0;
		skill.viewsHuman = views?.viewsHuman ?? 0;
		skill.viewsAgent = views?.viewsAgent ?? 0;
		skill.committedEdits = edits?.count ?? null;
		skill.lastEditedAt = edits?.lastEditedAt ?? null;
		skill.historyAvailable = edits?.available ?? false;
	}
	skills.sort((a, b) => a.id.localeCompare(b.id));
	const groups = GROUP_ORDER.filter((g) => skills.some((s) => s.group === g)).map((g) => ({
		key: g,
		label: GROUP_LABEL[g],
		skills: skills.filter((s) => s.group === g),
	}));
	const ungrouped = skills.filter((s) => !GROUP_ORDER.includes(s.group as (typeof GROUP_ORDER)[number]));
	return {
		groups,
		ungrouped,
		total: skills.length,
		viewCoverage:
			'Tracked views include wiki opens, agent API reads, Claude Skill loads, and Codex wrapper reads. Direct Codex filesystem reads outside the wrapper are not observable.',
		skillMetricsEnabled: SKILL_METRICS_ENABLED,
		// Stream metrics so host discovery does not delay the library table.
		skillMetrics: SKILL_METRICS_ENABLED ? loadSkillMetrics().catch(metricsFailure) : null,
	};
}
