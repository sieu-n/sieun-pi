import { error } from '@sveltejs/kit';
import { readPage } from '$lib/server/wiki';
import { renderWikiPage } from '$lib/server/render';
import { recordView, statOne } from '$lib/server/wiki-store';
import { getMirrorHistory } from '$lib/server/wiki-git-history';

export async function load({ params }) {
	const page = await readPage(params.slug);
	if (!page) error(404, 'Wiki page not found');
	recordView({ path: page.path, viewerKind: 'human', source: 'wiki-page' });
	const rendered = await renderWikiPage(page.content, page);
	const replacedBy = page.meta.superseded_by;
	// Read the replacement itself: a session artifact's index entry carries only a path-derived title.
	const supersededBy = replacedBy
		? { path: replacedBy, title: (await readPage(replacedBy).catch(() => null))?.title ?? replacedBy }
		: null;
	const isSkill = /^@code\/(?:\.agents\/skills|\.claude\/skills-native)\/.+\/SKILL\.md$/.test(page.path);
	return {
		page,
		html: rendered.html,
		toc: rendered.toc,
		supersededBy,
		stats: statOne(page.path),
		history: isSkill ? await getMirrorHistory(page.path) : null,
		viewCoverage: isSkill
			? 'Tracked views include wiki opens, agent API reads, Claude Skill loads, and Codex wrapper reads. Direct Codex filesystem reads outside the wrapper are not observable.'
			: null,
	};
}
