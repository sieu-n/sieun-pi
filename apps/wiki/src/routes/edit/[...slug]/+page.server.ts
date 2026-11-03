import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { readPage } from '$lib/server/wiki';

const EDITABLE = dev || env.WIKI_EDITABLE === 'true';

export async function load({ params, url }) {
	if (!EDITABLE) error(403, 'This wiki instance is read-only. Run with WIKI_EDITABLE=true to enable editing.');
	if (params.slug.startsWith('@code/'))
		error(403, 'The @code/ tier mirrors repo source docs and is read-only. Edit those files in the codebase.');

	const isNew = url.searchParams.get('new') === '1';
	const page = isNew ? null : await readPage(params.slug);
	if (!page && !isNew) error(404, 'Page not found — append ?new=1 to create it.');

	return {
		slug: params.slug,
		content: page?.content ?? `# ${titleFromSlug(params.slug)}\n\n`,
		exists: Boolean(page),
	};
}

function titleFromSlug(slug: string): string {
	return (
		slug
			.split('/')
			.at(-1)
			?.replace(/\.[^.]+$/, '')
			.split(/[-_]/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ') ?? 'Untitled'
	);
}
