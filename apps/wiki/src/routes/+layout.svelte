<script module lang="ts">
	import { getContext, setContext } from 'svelte';

	/**
	 * Reader-view state shared with the article route through `getWikiView()`. The flags live on `<html>` as `data-*`
	 * attributes that app.css keys off; `src/app.html` writes them before first paint, so there is no flash.
	 */
	export type WikiView = {
		/** Long-form reading: rails out of the way, article centred on a reading measure. */
		reader: boolean;
		/** Left page-tree rail hidden. Desktop only — narrow viewports use `.browse-btn`. */
		treeCollapsed: boolean;
		/** Right rail (contents + backlinks) hidden. */
		railCollapsed: boolean;
		/** "On this page" section open inside the right rail. */
		tocOpen: boolean;
	};

	const VIEW_CONTEXT = Symbol('wiki-view');

	export function getWikiView(): WikiView {
		return getContext<WikiView>(VIEW_CONTEXT);
	}
</script>

<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import TreeNav from '$lib/components/TreeNav.svelte';
	import FavoritesNav from '$lib/components/FavoritesNav.svelte';
	import Palette from '$lib/components/Palette.svelte';

	const VIEW_STORE_KEY = 'wiki:readerView';

	let { data, children } = $props();
	let paletteOpen = $state(false);
	let treeOpen = $state(false);

	// Defaults match what the server renders: both rails open. The saved view is picked up from
	// `<html>` in a client-only effect below, so nothing SSR-visible depends on stored state.
	const view = $state<WikiView>({ reader: false, treeCollapsed: false, railCollapsed: false, tocOpen: true });
	setContext(VIEW_CONTEXT, view);
	// Guards the persist effect so the first flush cannot write defaults over the saved view.
	let viewRestored = false;

	// The canonical page path (…/index.html) from readPage, so the tree highlight and favorites toggle match index pages.
	const activePage = $derived(
		page.url.pathname.startsWith(`${base}/page/`)
			? (page.data as { page?: { path?: string; title?: string } }).page
			: undefined,
	);
	const activePath = $derived(activePage?.path ?? '');
	const activeTitle = $derived(activePage?.title ?? '');

	// Full-bleed "app" views render their own chrome and don't want the doc tree rail.
	const fullBleed = $derived(
		['/graph', '/api', '/edit', '/specs'].some((p) => page.url.pathname === `${base}${p}` || page.url.pathname.startsWith(`${base}${p}/`)),
	);

	// Close the mobile tree rail on every navigation. Tree expand/collapse buttons inside TreeNav
	// do not change the pathname, so they leave the rail open as required.
	$effect(() => {
		page.url.pathname; // track as reactive dependency — re-runs on every page navigation
		treeOpen = false;
	});

	// Pick the pre-paint flags back up. Restore runs first: effects run in creation order, so this
	// lands before the persist effect below and defaults never overwrite the saved view.
	$effect(() => {
		const flags = document.documentElement.dataset;
		view.reader = flags.reader !== undefined;
		view.treeCollapsed = flags.treeCollapsed !== undefined;
		view.railCollapsed = flags.railCollapsed !== undefined;
		view.tocOpen = flags.tocClosed === undefined;
		viewRestored = true;
	});

	// Keep `<html>` (what the CSS reads) and the record (what app.html reads next load) in step.
	// Every field is read into `next` BEFORE the guard so all four stay tracked dependencies.
	$effect(() => {
		const next = {
			reader: view.reader,
			treeCollapsed: view.treeCollapsed,
			railCollapsed: view.railCollapsed,
			tocOpen: view.tocOpen,
		};
		if (!viewRestored) return;
		const root = document.documentElement;
		root.toggleAttribute('data-reader', next.reader);
		root.toggleAttribute('data-tree-collapsed', next.treeCollapsed);
		root.toggleAttribute('data-rail-collapsed', next.railCollapsed);
		root.toggleAttribute('data-toc-closed', !next.tocOpen);
		localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(next));
	});

	/** Reader mode is a preset: it puts both rails away and brings both back. */
	function toggleReader(): void {
		const on = !view.reader;
		view.reader = on;
		view.treeCollapsed = on;
		view.railCollapsed = on;
	}

	function onWindowKey(event: KeyboardEvent): void {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '\\') {
			event.preventDefault();
			toggleReader();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<Palette bind:open={paletteOpen} />

<div class="shell">
	<header class="topbar">
		<div class="topbar-inner">
			<a class="brand" href="{base}/">
				<span class="brand-mark">LW</span>
				<span>llm-wiki</span>
			</a>
			<button class="search-trigger" onclick={() => (paletteOpen = true)}>
				<span>Search…</span>
				<kbd>⌘K</kbd>
			</button>
			<nav class="nav" aria-label="Wiki navigation">
				<a href="{base}/timeline">Timeline</a>
				<a href="{base}/skills">Skills</a>
				<a href="{base}/specs">Specs</a>
				<a href="{base}/playground">Playground</a>
				<a href="{base}/graph">Graph</a>
				<a href="{base}/api">API Reference</a>
				<a href="{base}/lint">Health</a>
				<a href="{base}/llms.txt">llms.txt</a>
			</nav>
			{#if !fullBleed}
				<button
					class="reader-toggle"
					class:reader-toggle--on={view.reader}
					aria-pressed={view.reader}
					title="Reader mode — hide both rails (⌘\)"
					onclick={toggleReader}
				>
					<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
						<path
							d="M2.75 3.5h10.5M4.75 6.75h6.5M4.75 10h6.5M2.75 13.25h10.5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.4"
							stroke-linecap="round"
						/>
					</svg>
					<span class="reader-toggle-label">Reader</span>
					<kbd>⌘\</kbd>
				</button>
			{/if}
		</div>
	</header>

	{#if fullBleed}
		<div class="content full">
			{@render children()}
		</div>
	{:else}
		<div class="body">
			<button
				class="browse-btn"
				aria-expanded={treeOpen}
				aria-controls="wiki-tree-rail"
				onclick={() => (treeOpen = !treeOpen)}
			>
				Browse pages
			</button>
			<!-- Swapped with the rail by CSS, not {#if}, so the pre-paint attributes settle the fold before the first frame. -->
			<button
				class="rail-tab"
				aria-expanded="false"
				aria-controls="wiki-tree-rail"
				title="Show the page tree"
				onclick={() => (view.treeCollapsed = false)}
			>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path
						d="M6 3.5 10.5 8 6 12.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="rail-tab-label">Pages</span>
			</button>
			<aside class="tree-rail" class:tree-rail--open={treeOpen} id="wiki-tree-rail" aria-label="Wiki tree">
				<div class="tree-head">
					<span>{data.manifest.pageCount} pages</span>
					<span class="tree-head-actions">
						<a href="{base}/" class="tree-home">Home</a>
						<button
							class="rail-collapse"
							aria-expanded="true"
							aria-controls="wiki-tree-rail"
							title="Hide the page tree"
							onclick={() => (view.treeCollapsed = true)}
						>
							<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
								<path
									d="M10 3.5 5.5 8l4.5 4.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
							<span class="sr-only">Hide the page tree</span>
						</button>
					</span>
				</div>
				<FavoritesNav {activePath} {activeTitle} favorites={data.favorites} writable={data.favoritesWritable} />
				<TreeNav nodes={data.tree} {activePath} />
			</aside>
			<div class="content">
				{@render children()}
			</div>
		</div>
	{/if}
</div>
