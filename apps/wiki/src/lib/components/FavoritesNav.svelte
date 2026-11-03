<script lang="ts">
	import { base } from '$app/paths';
	let {
		activePath = '',
		activeTitle = '',
		favorites: initialFavorites = [],
		writable = true,
	}: {
		activePath?: string;
		activeTitle?: string;
		/** Favorites whose page exists, with titles from the server's index. */
		favorites?: { path: string; title: string }[];
		writable?: boolean;
	} = $props();

	// Machine-local favorites from the SQLite store via /api/agent/favorites; mutations adopt the endpoint's list.
	let favorites = $state<string[]>(initialFavorites.map((favorite) => favorite.path));
	let pending = $state(false);
	let error = $state<string | null>(null);
	/** Titles of pages favorited in this tab, which the server data does not list yet. */
	let addedTitles = $state<Record<string, string>>({});

	const titles = $derived<Record<string, string>>({
		...Object.fromEntries(initialFavorites.map((favorite) => [favorite.path, favorite.title])),
		...addedTitles,
	});

	/** Only paths with a known page are shown. Stale/unknown paths are hidden. */
	const knownFavorites = $derived(favorites.filter((path) => Object.hasOwn(titles, path)));

	// `activePath` is already the canonical page path (…/index.html), resolved server-side, so it
	// matches favorite rows directly — no client-side link resolution needed here.
	const activeIsFile = $derived(activePath !== '');
	const activeIsFavorited = $derived(activeIsFile && favorites.includes(activePath));

	/** POST/DELETE against the server store; adopt its authoritative list on success, surface failures. */
	async function mutate(method: 'POST' | 'DELETE', path: string): Promise<void> {
		if (pending) return;
		pending = true;
		error = null;
		try {
			const res = await fetch(`${base}/api/agent/favorites`, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path }),
			});
			const data = (await res.json().catch(() => ({}))) as { favorites?: unknown; error?: unknown };
			if (!res.ok) {
				error = typeof data.error === 'string' ? data.error : `Couldn't save favorite (${res.status})`;
				return;
			}
			if (Array.isArray(data.favorites)) {
				if (method === 'POST') addedTitles[path] = activeTitle || path;
				favorites = data.favorites.filter((p): p is string => typeof p === 'string');
			} else {
				// Ok status but no list (corrupted/unexpected body) — don't silently pretend it worked.
				error = 'Favorites store returned an unexpected response';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't reach the favorites store";
		} finally {
			pending = false;
		}
	}

	function toggleActive(): void {
		if (!activeIsFile) return;
		mutate(activeIsFavorited ? 'DELETE' : 'POST', activePath);
	}

	function removeFavorite(path: string): void {
		mutate('DELETE', path);
	}
</script>

<details class="favorites-section" open>
	<summary>
		<span class="fav-label">Favorites</span>
		{#if knownFavorites.length > 0}
			<span class="fav-count">{knownFavorites.length}</span>
		{/if}
	</summary>

	{#if activeIsFile && writable}
		<button
			class="fav-toggle"
			class:is-favorited={activeIsFavorited}
			type="button"
			disabled={pending}
			aria-label={activeIsFavorited ? 'Remove from favorites' : 'Add to favorites'}
			aria-pressed={activeIsFavorited}
			onclick={toggleActive}
		>
			{activeIsFavorited ? '★ Remove from favorites' : '☆ Add to favorites'}
		</button>
	{/if}

	{#if error}
		<p class="fav-error" role="alert">{error}</p>
	{/if}

	{#if knownFavorites.length === 0}
		<p class="fav-empty">No favorites yet.</p>
	{:else}
		<ul class="fav-list">
			{#each knownFavorites as path (path)}
				{@const title = titles[path] ?? path}
				{@const isActive = path === activePath}
				<li class="fav-item">
					<a class="fav-link" class:active={isActive} href="{base}/page/{path}" {title} data-sveltekit-preload-data="tap"
						>{title}</a
					>
					{#if !isActive && writable}
						<button
							class="fav-remove"
							type="button"
							disabled={pending}
							aria-label="Remove {title} from favorites"
							onclick={() => removeFavorite(path)}>&times;</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</details>

<style>
	.favorites-section {
		margin-bottom: 12px;
		border-bottom: 1px solid #e3e9e6;
		padding-bottom: 10px;
	}

	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		border-radius: 6px;
		padding: 4px 7px;
		color: #3a4a45;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		list-style: none;
		user-select: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary::before {
		content: '\25b8';
		color: #9aa8a3;
		font-size: 10px;
		transition: transform 0.12s ease;
	}

	details[open] > summary::before {
		transform: rotate(90deg);
	}

	summary:hover {
		background: #eef4f1;
		color: #16211f;
	}

	.fav-label {
		flex: 1;
	}

	.fav-count {
		color: #aab6b1;
		font-size: 11px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.fav-toggle {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		border: none;
		border-radius: 6px;
		background: none;
		padding: 4px 8px;
		color: #66736f;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}

	.fav-toggle:hover {
		background: #eef4f1;
		color: #16211f;
	}

	.fav-toggle.is-favorited {
		color: #1d4f43;
	}

	.fav-toggle:focus-visible {
		outline: 2px solid #1d4f43;
		outline-offset: 1px;
	}

	.fav-empty {
		margin: 4px 0 0;
		padding: 3px 8px;
		color: #9aa8a3;
		font-size: 12px;
	}

	.fav-error {
		margin: 4px 0 0;
		padding: 3px 8px;
		color: #a3341d;
		font-size: 12px;
	}

	/* Capped at about 6 rows so the list does not take over the sidebar. */
	.fav-list {
		margin: 2px 0 0;
		padding: 0;
		max-height: 220px;
		overflow-y: auto;
		list-style: none;
	}

	.fav-item {
		display: flex;
		align-items: center;
		gap: 2px;
		margin: 1px 0;
	}

	.fav-link {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		border-radius: 6px;
		padding: 4px 8px;
		color: #55635e;
		font-size: 13px;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fav-link:hover {
		background: #eef4f1;
		color: #16211f;
	}

	.fav-link.active {
		background: #e4efe9;
		color: #12433a;
		font-weight: 600;
	}

	.fav-link:focus-visible {
		outline: 2px solid #1d4f43;
		outline-offset: 1px;
	}

	.fav-remove {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: none;
		border-radius: 4px;
		background: none;
		color: #9aa8a3;
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
	}

	.fav-remove:hover {
		background: #eef4f1;
		color: #3a4a45;
	}

	.fav-remove:focus-visible {
		outline: 2px solid #1d4f43;
		outline-offset: 1px;
	}

	.fav-toggle:disabled,
	.fav-remove:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
