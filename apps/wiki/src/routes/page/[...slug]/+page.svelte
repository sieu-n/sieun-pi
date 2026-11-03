<script lang="ts">
	import { base } from '$app/paths';
	import { mount, unmount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import WikiEChart from '$lib/components/WikiEChart.svelte';
	import WikiGitStatus from '$lib/components/WikiGitStatus.svelte';
	import { getWikiView } from '../../+layout.svelte';

	/** Sticky topbar plus a little air. Headings clear it when jumped to and when scroll-spied. */
	const HEADING_OFFSET = 84;

	let { data } = $props();
	const view = getWikiView();
	/** Floating contents dock, the way back to the ToC once the rail is put away. */
	let dockOpen = $state(false);
	let activeId = $state('');
	const isMirror = $derived(data.page.path.startsWith('@code/'));
	const isSkill = $derived(
		isMirror &&
			(/^@code\/\.agents\/skills\/.+\/SKILL\.md$/.test(data.page.path) ||
				/^@code\/\.claude\/skills-native\/.+\/SKILL\.md$/.test(data.page.path)),
	);

	// Hydrate the interactive <wiki-*> primitives from sanitized markup; behavior lives here, never in inline script.
	$effect(() => {
		void data.html; // re-run when navigating to another page
		const root = document.querySelector('.prose');
		if (!root) return;
		const cleanups: Array<() => void> = [];

		root.querySelectorAll<HTMLTableElement>('table[data-wiki-sortable]').forEach(setupSortable);
		root
			.querySelectorAll<HTMLTableElement>('table[data-wiki-filterable]')
			.forEach((table) => cleanups.push(setupFilter(table)));

		const onClick = (event: Event) => {
			const img = (event.target as HTMLElement | null)?.closest<HTMLImageElement>(
				'[data-wiki-zoom] img, img[data-wiki-zoom]',
			);
			if (img) openLightbox(img.currentSrc || img.src, img.alt);
		};
		root.addEventListener('click', onClick);
		cleanups.push(() => root.removeEventListener('click', onClick));

		// Source tips (`<wiki-cite>`) are position: fixed, so put each one under its number as it opens.
		const placeCite = (event: Event) => {
			const cite = (event.target as HTMLElement | null)?.closest<HTMLElement>('.wiki-cite');
			const tip = cite?.querySelector<HTMLElement>('.wiki-cite-tip');
			if (!cite || !tip) return;
			const box = cite.getBoundingClientRect();
			tip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tip.offsetWidth - 8))}px`;
			tip.style.top = `${box.bottom}px`;
		};
		root.addEventListener('mouseover', placeCite);
		root.addEventListener('focusin', placeCite);
		cleanups.push(() => {
			root.removeEventListener('mouseover', placeCite);
			root.removeEventListener('focusin', placeCite);
		});

		// Live charts: `<div data-wiki-echart data-src="<chart json>" data-chart="<key>">` holds a static
		// fallback (an SVG of the same chart) until the ECharts host takes the slot.
		for (const slot of root.querySelectorAll<HTMLElement>('[data-wiki-echart]')) {
			if (!slot.dataset.src || !slot.dataset.chart) continue;
			slot.replaceChildren();
			const chart = mount(WikiEChart, { target: slot, props: { src: slot.dataset.src, chart: slot.dataset.chart } });
			cleanups.push(() => unmount(chart));
		}

		// Live branch status: `<div data-wiki-git-status>` holds a static fallback line until WikiGitStatus takes the slot.
		for (const slot of root.querySelectorAll<HTMLElement>('[data-wiki-git-status]')) {
			slot.replaceChildren();
			const branches = mount(WikiGitStatus, { target: slot });
			cleanups.push(() => unmount(branches));
		}

		// Mermaid loads only on pages with a `<pre class="mermaid">`. startOnLoad stays off because navigation swaps .prose;
		// suppressErrors leaves the raw definition visible, which is the failure signal for a diagram typo.
		const diagrams = root.querySelectorAll<HTMLElement>('pre.mermaid');
		if (diagrams.length > 0) {
			let cancelled = false;
			cleanups.push(() => {
				cancelled = true;
			});
			void import('mermaid').then(({ default: mermaid }) => {
				if (cancelled) return;
				mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
				void mermaid.run({ nodes: diagrams, suppressErrors: true });
			});
		}

		return () => cleanups.forEach((fn) => fn());
	});

	function setupSortable(table: HTMLTableElement): void {
		const headers = Array.from(table.tHead?.rows[0]?.cells ?? []);
		headers.forEach((th, col) => {
			th.addEventListener('click', () => {
				const body = table.tBodies[0];
				if (!body) return;
				const ascending = th.getAttribute('aria-sort') !== 'ascending';
				headers.forEach((cell) => cell.removeAttribute('aria-sort'));
				th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
				Array.from(body.rows)
					.sort((a, b) => compareCells(a.cells[col]?.textContent ?? '', b.cells[col]?.textContent ?? '', ascending))
					.forEach((row) => body.appendChild(row));
			});
		});
	}

	function setupFilter(table: HTMLTableElement): () => void {
		const input = document.createElement('input');
		input.className = 'wiki-filter';
		input.type = 'search';
		input.placeholder = 'Filter rows…';
		input.setAttribute('aria-label', 'Filter table rows');
		table.parentElement?.insertBefore(input, table);
		const onInput = () => {
			const query = input.value.trim().toLowerCase();
			for (const row of Array.from(table.tBodies[0]?.rows ?? [])) {
				row.style.display = !query || (row.textContent ?? '').toLowerCase().includes(query) ? '' : 'none';
			}
		};
		input.addEventListener('input', onInput);
		return () => {
			input.removeEventListener('input', onInput);
			input.remove();
		};
	}

	// Scrollspy: the section that owns the reading line. Re-runs on navigation — `data.toc` is a
	// tracked dependency.
	$effect(() => {
		const items = data.toc;
		if (items.length === 0) {
			activeId = '';
			return;
		}
		const headings = items
			.map((item) => document.getElementById(item.id))
			.filter((el): el is HTMLElement => el !== null);
		if (headings.length === 0) return;

		const pick = () => {
			// The end of the document belongs to the last section even when its heading never
			// climbs past the offset, which is what a short trailing section does.
			if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
				activeId = headings[headings.length - 1].id;
				return;
			}
			let current = headings[0].id;
			for (const heading of headings) {
				if (heading.getBoundingClientRect().top > HEADING_OFFSET) break;
				current = heading.id;
			}
			activeId = current;
		};

		let frame = 0;
		const onScroll = () => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				pick();
			});
		};

		// Two triggers, two jobs. The observer takes the first pick and re-picks whenever headings
		// MOVE without a scroll — mermaid diagrams and images finish laying out long after load and
		// shift every heading below them. The passive, frame-coalesced scroll listener re-picks
		// while scrolling: a jump (End, a hash link, scroll restore on reload) can carry the page
		// past several headings without changing a single intersection state, and the observer
		// stays silent through it. Measured: jumping 2700px left the wrong section lit until the
		// next crossing when the observer was the only trigger.
		const observer = new IntersectionObserver(pick, { rootMargin: `-${HEADING_OFFSET}px 0px 0px 0px` });
		for (const heading of headings) observer.observe(heading);
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener('scroll', onScroll);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	});

	function jumpTo(event: MouseEvent, id: string): void {
		const target = document.getElementById(id);
		if (!target) return;
		event.preventDefault();
		dockOpen = false;
		activeId = id;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
		replaceState(`#${id}`, page.state);
	}

	function compareCells(a: string, b: string, ascending: boolean): number {
		const na = Number(a.replace(/[,%$\s]/g, ''));
		const nb = Number(b.replace(/[,%$\s]/g, ''));
		const numeric = a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
		const cmp = numeric ? na - nb : a.localeCompare(b, undefined, { numeric: true });
		return ascending ? cmp : -cmp;
	}

	function openLightbox(src: string, alt: string): void {
		const overlay = document.createElement('div');
		overlay.className = 'wiki-lightbox';
		const img = document.createElement('img');
		img.src = src;
		img.alt = alt;
		overlay.appendChild(img);
		if (alt) {
			const caption = document.createElement('figcaption');
			caption.textContent = alt;
			overlay.appendChild(caption);
		}
		const close = () => {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close();
		};
		overlay.addEventListener('click', close);
		document.addEventListener('keydown', onKey);
		document.body.appendChild(overlay);
	}
</script>

<svelte:head>
	<title>{data.page.title} · llm-wiki</title>
</svelte:head>

<article class="page">
	{#if data.supersededBy}
		<p class="superseded" role="note">
			This page was replaced by <a href="{base}/page/{data.supersededBy.path}">{data.supersededBy.title}</a>.
		</p>
	{/if}
	<header class="page-head">
		<p class="crumbs">{data.page.path}</p>
		<div class="page-title-row">
			<h1>{data.page.title}</h1>
			{#if isMirror}
				<span class="mirror-tag" title="Mirrored from the repository — edit in the codebase">source · read-only</span>
			{:else}
				<a class="edit-btn" href="{base}/edit/{data.page.path}">Edit</a>
			{/if}
		</div>
		<div class="page-meta">
			<span class="pill">{data.page.kind}</span>
			<span class="pill">{data.page.size.toLocaleString()} bytes</span>
			<span class="pill">{data.page.links.length} links</span>
			<span class="pill">{data.page.backlinks.length} backlinks</span>
			<span class="muted">Updated {data.page.updated.slice(0, 10)}</span>
			{#if data.page.truncated}<span class="pill warn">truncated preview</span>{/if}
			{#if isSkill && data.stats}
				<span class="pill" title="Human: {data.stats.viewsHuman} · Agent: {data.stats.viewsAgent}"
					>{data.stats.views} tracked views</span
				>
				<span class="pill">{data.stats.viewsHuman} human</span>
				<span class="pill">{data.stats.viewsAgent} agent</span>
				{#if data.history?.available && data.history.count != null}
					<span class="pill">{data.history.count} committed edits</span>
				{:else}
					<span class="pill pill-dim" title="Edit history not available for this skill">edits unavailable</span>
				{/if}
			{/if}
		</div>
	</header>

	<div class="page-grid">
		<!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized by DOMPurify in render.ts -->
		<div class="prose">{@html data.html}</div>

		<aside class="rail" id="wiki-page-rail" aria-label="Page sidebar">
			<div class="rail-tools">
				<!-- Literal `aria-expanded`: this control only ever rides inside the open rail. -->
				<button
					class="rail-collapse"
					aria-expanded="true"
					aria-controls="wiki-page-rail"
					title="Hide the page sidebar"
					onclick={() => (view.railCollapsed = true)}
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
					<span class="sr-only">Hide the page sidebar</span>
				</button>
			</div>

			{#if data.toc.length > 0}
				<section class="rail-card">
					<h2>
						<button
							class="rail-card-btn"
							aria-expanded={view.tocOpen}
							aria-controls="wiki-toc"
							onclick={() => (view.tocOpen = !view.tocOpen)}
						>
							<svg class="rail-caret" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
								<path
									d="M6 3.5 10.5 8 6 12.5"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
							On this page
						</button>
					</h2>
					<!-- Folded by CSS off `html[data-toc-closed]`, so a saved fold is already applied
					     on the first frame. -->
					<div id="wiki-toc">{@render tocNav()}</div>
				</section>
			{/if}

			{#if isSkill}
				<section class="rail-card">
					<h2>Recent committed edits</h2>
					{#if data.viewCoverage}
						<p class="hist-coverage">{data.viewCoverage}</p>
					{/if}
					{#if !data.history || !data.history.available}
						<p class="muted small">{data.history?.error ?? 'Edit history unavailable.'}</p>
					{:else if !data.history.revisions?.length}
						<p class="muted small">No commits recorded yet.</p>
					{:else}
						<ol class="rev-list">
							{#each data.history.revisions.slice(0, 5) as rev (rev.commit)}
								<li class="rev-item">
									<span class="rev-date">{rev.ts.slice(0, 10)}</span>
									<span class="rev-subject">{rev.summary}</span>
									<span class="rev-meta">
										<span class="rev-author">{rev.author}</span>
										<span class="rev-diff">
											<span class="rev-added">+{rev.linesAdded}</span>
											<span class="rev-removed">−{rev.linesRemoved}</span>
										</span>
									</span>
								</li>
							{/each}
						</ol>
					{/if}
				</section>
			{/if}

			<section class="rail-card">
				<h2>Backlinks <span class="badge">{data.page.backlinks.length}</span></h2>
				{#if data.page.backlinks.length === 0}
					<p class="muted small">No pages link here yet.</p>
				{:else}
					<div class="backlinks">
						{#each data.page.backlinks as link (link.path)}
							<a href="{base}/page/{link.path}">
								<span class="bl-title">{link.title}</span>
								<span class="bl-path">{link.path}</span>
							</a>
						{/each}
					</div>
				{/if}
			</section>
		</aside>
	</div>
</article>

<!-- Shown by CSS off `html[data-rail-collapsed]`, so the dock is in place on the first frame; `aria-expanded` is a literal
     because the dock is only perceivable while the rail is folded. -->
<div class="toc-dock">
	{#if dockOpen}
		<div class="toc-dock-panel" id="wiki-toc-dock-panel">
			<div class="toc-dock-head">
				<span>On this page</span>
				<button
					class="dock-pin"
					aria-expanded="false"
					aria-controls="wiki-page-rail"
					onclick={() => {
						view.railCollapsed = false;
						dockOpen = false;
					}}
				>
					Pin to side
				</button>
			</div>
			{#if data.toc.length > 0}
				{@render tocNav()}
			{:else}
				<p class="muted small">No headings on this page.</p>
			{/if}
		</div>
	{/if}
	<button
		class="toc-dock-btn"
		aria-expanded={dockOpen}
		aria-controls="wiki-toc-dock-panel"
		onclick={() => (dockOpen = !dockOpen)}
	>
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path
				d="M2.75 4h2M2.75 8h2M2.75 12h2M7.25 4h6M7.25 8h6M7.25 12h6"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
			/>
		</svg>
		<span>On this page</span>
	</button>
</div>

{#snippet tocNav()}
	<nav class="toc" aria-label="On this page">
		{#each data.toc as item (item.id)}
			<a
				href="#{item.id}"
				class="toc-d{item.depth}"
				class:toc-active={activeId === item.id}
				aria-current={activeId === item.id ? 'location' : undefined}
				onclick={(event) => jumpTo(event, item.id)}>{item.text}</a
			>
		{/each}
	</nav>
{/snippet}

<style>
	/* Same palette as `.prose .wiki-panel.warning`: a stale page must say where its rewrite lives. */
	.superseded {
		margin: 0 0 16px;
		border: 1px solid var(--border);
		border-left: 3px solid #c79321;
		border-radius: 8px;
		background: #fdf7e6;
		padding: 11px 15px;
		color: #60480f;
		font-weight: 600;
	}
	.superseded a {
		color: inherit;
		text-decoration: underline;
	}
	.hist-coverage {
		font-size: 0.75rem;
		color: var(--muted, #666);
		font-style: italic;
		margin-bottom: 0.5rem;
		line-height: 1.4;
	}
	.rev-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rev-item {
		display: grid;
		grid-template-rows: auto auto auto;
		gap: 0.1rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border, #e3e3e3);
		font-size: 0.8rem;
	}
	.rev-item:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}
	.rev-date {
		color: var(--muted, #666);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}
	.rev-subject {
		font-weight: 500;
		line-height: 1.3;
	}
	.rev-meta {
		display: flex;
		justify-content: space-between;
		color: var(--muted, #666);
		font-size: 0.72rem;
	}
	.rev-diff {
		display: flex;
		gap: 0.35rem;
		font-variant-numeric: tabular-nums;
	}
	.rev-added {
		color: #1a6b1a;
	}
	.rev-removed {
		color: #9b1c1c;
	}
	.pill-dim {
		color: var(--muted, #888);
		font-style: italic;
	}
</style>
