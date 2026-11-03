<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';

	type Result = {
		path: string;
		title: string;
		description: string | null;
		kind: string;
		status: string | null;
		updated: string;
		views: number;
		edits: number;
	};

	function fmtDate(value: string): string {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
	}

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let query = $state('');
	let results = $state<Result[]>([]);
	let active = $state(0);
	// Opt-in to include sessions and archive, which search excludes by default. localStorage is read in the
	// open-effect before any search fires, so no SSR-visible state may depend on it.
	let includeAll = $state(false);
	/** Hits the same query gets once sessions + archive are included — only computed when curated is empty. */
	let wider = $state(0);
	let failed = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	let token = 0;

	const STORE_KEY = 'wiki:searchIncludeAll';

	$effect(() => {
		if (open) {
			includeAll = localStorage.getItem(STORE_KEY) === '1';
			queueMicrotask(() => inputEl?.focus());
		} else {
			query = '';
			results = [];
			wider = 0;
			failed = false;
			active = 0;
		}
	});

	async function runSearch(q: string, withAll: boolean): Promise<Result[]> {
		const extra = withAll ? '&includeSessions=true&includeArchive=true' : '';
		const res = await fetch(`${base}/api/agent/search?q=${encodeURIComponent(q)}&limit=20${extra}`);
		if (!res.ok) throw new Error(`search failed: ${res.status}`);
		return ((await res.json()).results ?? []) as Result[];
	}

	$effect(() => {
		const q = query.trim();
		const withAll = includeAll; // tracked: toggling re-runs the current query
		const current = ++token;
		if (!q) {
			results = [];
			wider = 0;
			failed = false;
			return;
		}
		const timer = setTimeout(async () => {
			try {
				const hits = await runSearch(q, withAll);
				if (current !== token) return;
				results = hits;
				failed = false;
				active = 0;
				// Say when the term lives only in sessions or the archive, so "No matches." does not read as broken.
				wider = hits.length === 0 && !withAll ? (await runSearch(q, true)).length : 0;
			} catch {
				if (current !== token) return;
				results = [];
				wider = 0;
				failed = true; // a dead endpoint must not look like "nothing here"
			}
		}, 110);
		return () => clearTimeout(timer);
	});

	function toggleIncludeAll() {
		includeAll = !includeAll;
		localStorage.setItem(STORE_KEY, includeAll ? '1' : '0');
		inputEl?.focus();
	}

	function onWindowKey(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			open = !open;
		} else if (event.key === 'Escape' && open) {
			open = false;
		}
	}

	function onInputKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (event.key === 'Enter' && results[active]) {
			event.preventDefault();
			select(results[active]);
		}
	}

	function select(result: Result) {
		open = false;
		goto(`${base}/page/${encodeURI(result.path)}`);
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<div
		class="overlay"
		role="button"
		tabindex="-1"
		onclick={() => (open = false)}
		onkeydown={(e) => e.key === 'Enter' && (open = false)}
	>
		<div class="palette" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={onInputKey}
				placeholder="Search the wiki — titles, headings, page text…"
				aria-label="Search the wiki"
			/>
			<div class="results">
				{#if query.trim() && failed}
					<p class="empty">Search is not answering. Check that the wiki dev server is up.</p>
				{:else if query.trim() && results.length === 0}
					{#if wider > 0}
						<p class="empty">
							No curated page matches. <strong>{wider}</strong>
							{wider === 1 ? 'hit' : 'hits'} in sessions + archive —
							<button class="empty-action" onclick={toggleIncludeAll}>search those too</button>
						</p>
					{:else}
						<p class="empty">No matches.</p>
					{/if}
				{:else}
					{#each results as result, i (result.path)}
						<button
							class="row"
							class:active={i === active}
							onmouseenter={() => (active = i)}
							onclick={() => select(result)}
						>
							<span class="row-title">{result.title}</span>
							<span class="row-path">{result.path}</span>
							{#if result.description}<span class="row-excerpt">{result.description}</span>{/if}
							<span class="row-meta">
								<span class="badge"
									>{result.kind}{#if result.status}
										· {result.status}{/if}</span
								>
								<span class="dim">{fmtDate(result.updated)}</span>
								{#if result.views || result.edits}<span class="dim">{result.views} views · {result.edits} edits</span
									>{/if}
							</span>
						</button>
					{/each}
				{/if}
			</div>
			<div class="palette-foot">
				<kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
				<button
					class="scope-toggle"
					class:on={includeAll}
					aria-pressed={includeAll}
					title="Sessions and archive are excluded from search by default"
					onclick={toggleIncludeAll}
				>
					{includeAll ? '✓ ' : ''}sessions + archive
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		justify-content: center;
		padding-top: 12vh;
		background: rgba(18, 28, 25, 0.32);
		backdrop-filter: blur(2px);
	}

	.palette {
		display: flex;
		flex-direction: column;
		width: min(640px, 92vw);
		max-height: 70vh;
		overflow: hidden;
		border: 1px solid #cdd7d2;
		border-radius: 12px;
		background: #ffffff;
		box-shadow: 0 24px 60px rgba(16, 40, 33, 0.28);
	}

	input {
		border: none;
		border-bottom: 1px solid #e7ece9;
		padding: 16px 18px;
		font-size: 16px;
		color: #16211f;
		outline: none;
	}

	.results {
		overflow-y: auto;
	}

	.row {
		display: grid;
		width: 100%;
		gap: 2px;
		border: none;
		border-bottom: 1px solid #f1f4f2;
		background: transparent;
		padding: 10px 18px;
		text-align: left;
		cursor: pointer;
	}

	.row.active {
		background: #eef5f1;
	}

	.row-title {
		color: #16211f;
		font-size: 14px;
		font-weight: 600;
	}

	.row-path {
		color: #7c8884;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
	}

	.row-excerpt {
		overflow: hidden;
		color: #66736f;
		font-size: 12px;
		line-height: 1.4;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 3px;
		color: #8a9692;
		font-size: 11px;
	}

	.badge {
		border: 1px solid #dbe3df;
		border-radius: 4px;
		background: #f3f7f5;
		padding: 0 6px;
		color: #4c5b56;
		font-weight: 600;
		text-transform: lowercase;
	}

	.dim {
		font-family: ui-monospace, Menlo, Consolas, monospace;
	}

	.empty {
		margin: 0;
		padding: 18px;
		color: #7c8884;
		font-size: 14px;
		line-height: 1.5;
	}

	.empty strong {
		color: #24312c;
	}

	.empty-action {
		border: none;
		background: none;
		padding: 0;
		color: #2f7a5c;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.palette-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		border-top: 1px solid #eef2f0;
		padding: 8px 16px;
		color: #8a9692;
		font-size: 12px;
	}

	kbd {
		border: 1px solid #dbe3df;
		border-radius: 4px;
		background: #f7faf8;
		padding: 1px 5px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
	}

	.scope-toggle {
		margin-left: auto;
		border: 1px solid #dbe3df;
		border-radius: 999px;
		background: #f7faf8;
		padding: 2px 10px;
		color: #66736f;
		font-size: 11px;
		cursor: pointer;
	}

	.scope-toggle.on {
		border-color: #9dbfae;
		background: #eef5f1;
		color: #24503c;
		font-weight: 600;
	}
</style>
