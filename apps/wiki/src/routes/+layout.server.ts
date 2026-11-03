import { base } from '$app/paths';
import { getManifest, getWikiIndex } from '$lib/server/wiki';
import { getRailTree } from '$lib/server/wiki-tree';
import { listFavorites, storeStatus } from '$lib/server/wiki-store';

/**
 * Runs on every navigation, because the rail opens the folders on the way to the current page.
 * The full tree is ~13 MB, so the rail gets the top level plus that branch and loads other folders itself.
 */
export async function load({ url }) {
	const [tree, manifest, index] = await Promise.all([getRailTree(openPath(url)), getManifest(), getWikiIndex()]);
	// Favorites are machine-local (SQLite), SSR'd so there's no hydration flash. Titles come from the index,
	// and a favorite whose page is gone is left out. `favoritesWritable` is false on a read-only deploy
	// (Vercel) — the sidebar hides the toggle rather than show a dead button.
	const favorites = listFavorites().flatMap((path) => {
		const page = index.byPath.get(path);
		return page ? [{ path, title: page.title }] : [];
	});
	return { tree, manifest, favorites, favoritesWritable: storeStatus().ok };
}

function openPath(url: URL): string {
	if (!url.pathname.startsWith(`${base}/page/`)) return '';
	try {
		return decodeURIComponent(url.pathname.slice(`${base}/page/`.length));
	} catch {
		return '';
	}
}
