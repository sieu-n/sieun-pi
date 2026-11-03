<script lang="ts">
	import { base } from '$app/paths';
	let { data } = $props();

	// Sessions browse through the timeline view.
	const SECTION_BLURB: Record<string, string> = {
		apps: 'Durable truth per app — hubs, topics, deep specs',
		domains: 'Cross-app topics — data lifecycle, auth/billing, deploy',
		projects: 'Bounded initiatives with an end state',
		experiments: 'Runs + data ending in a FINDINGS page',
		sessions: 'Append-only session logs — one per work session',
		archive: 'Frozen tail — superseded plans, opt-in search',
		'@code': 'Repo CLAUDE.md, rules & skills — read-only',
	};

	// Curated spaces first, evidence/system tiers after.
	const ORDER = ['apps', 'domains', 'projects', 'experiments', 'sessions', 'archive', '@code'];
	const rank = (name: string) => (ORDER.includes(name) ? ORDER.indexOf(name) : 99);
	const sections = $derived([...data.sections].sort((a, b) => rank(a.name) - rank(b.name)));

	const startHere = [
		{ href: `${base}/page/index.html`, label: 'Wiki home', note: 'The seven spaces and where knowledge goes' },
		{ href: `${base}/page/apps/index.html`, label: 'Apps', note: 'One hub per component' },
		{ href: `${base}/timeline`, label: 'Timeline', note: 'Session logs, newest first' },
	];

	const agentApis = [
		{ href: `${base}/llms.txt`, label: 'llms.txt', note: 'compact index for agents' },
		{ href: `${base}/api/agent/context-pack?q=crawler&budget=8000`, label: 'context-pack', note: 'budgeted page bundle' },
		{ href: `${base}/api/agent/search?q=billing`, label: 'search', note: 'ranked page search' },
		{ href: `${base}/api/agent/graph`, label: 'graph', note: 'nodes + link edges' },
		{ href: `${base}/api/agent/lint`, label: 'lint', note: 'wiki health report' },
	];

	const updated = $derived(data.manifest.latestUpdated?.slice(0, 10) ?? '');
</script>

<svelte:head><title>auto-sns-agent · wiki</title></svelte:head>

<main class="main">
	<header class="masthead">
		<h1>auto-sns-agent</h1>
		<p class="masthead-lead">
			Engineering knowledge base for the Instagram stack — <strong>virev.ai</strong>
			and <strong>api.virev.ai</strong>. Specs, architecture, deploy runbooks, session history, and the rules &amp;
			skills agents run — indexed live from the repo.
		</p>
		<p class="masthead-meta">
			<span><strong>{data.manifest.pageCount.toLocaleString()}</strong> pages</span>
			<span class="sep">·</span>
			<span><kbd>⌘K</kbd> to search</span>
			<span class="sep">·</span>
			<a href="{base}/llms.txt">llms.txt</a>
			{#if updated}<span class="sep">·</span><span>updated {updated}</span>{/if}
		</p>
	</header>

	<section class="block">
		<h2>Start here</h2>
		<div class="start-row">
			{#each startHere as item (item.href)}
				<a class="start-card" href={item.href}>
					<span class="start-label">{item.label}</span>
					<span class="start-note">{item.note}</span>
				</a>
			{/each}
		</div>
	</section>

	<section class="block">
		<h2>Browse</h2>
		<div class="section-grid">
			{#each sections as section (section.path)}
				<a class="section-card" href={section.href}>
					<span class="section-top">
						<span class="section-name">{section.name === '@code' ? 'Repo source docs' : section.name}</span>
						<span class="section-count">{section.pages}</span>
					</span>
					<span class="section-blurb">{SECTION_BLURB[section.name] ?? `${section.pages} pages`}</span>
				</a>
			{/each}
		</div>
	</section>

	<div class="home-cols">
		<section class="block">
			<h2>Recent changes</h2>
			<div class="recent-list">
				{#each data.recent as page (page.path)}
					<a class="recent" href="{base}/page/{page.path}">
						<span class="recent-title">{page.title}</span>
						<span class="recent-path">{page.path}</span>
					</a>
				{/each}
			</div>
		</section>

		<aside class="block">
			<h2>Agent endpoints</h2>
			<div class="api-list">
				{#each agentApis as api (api.href)}
					<a href={api.href}>
						<span class="api-label">{api.label}</span>
						<span class="api-note">{api.note}</span>
					</a>
				{/each}
			</div>
		</aside>
	</div>
</main>

<style>
	.masthead {
		max-width: 760px;
		margin-bottom: 36px;
		border-bottom: 1px solid var(--border);
		padding-bottom: 24px;
	}

	.masthead h1 {
		margin: 0 0 12px;
		font-size: 30px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.masthead-lead {
		margin: 0 0 14px;
		color: var(--ink-soft);
		font-size: 16px;
		line-height: 1.6;
	}

	.masthead-lead strong {
		color: var(--ink);
		font-weight: 600;
	}

	.masthead-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0;
		color: var(--ink-muted);
		font-size: 13px;
	}

	.masthead-meta strong {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.masthead-meta a {
		color: var(--accent);
		font-family: ui-monospace, Menlo, Consolas, monospace;
	}

	.masthead-meta .sep {
		color: var(--border);
	}

	.masthead-meta kbd {
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface);
		padding: 1px 6px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
	}

	.block {
		margin-bottom: 32px;
	}

	.block h2 {
		margin: 0 0 13px;
		color: var(--ink-muted);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}

	.start-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
	}

	.start-card {
		display: grid;
		gap: 3px;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface);
		padding: 14px 16px;
	}

	.start-card:hover {
		border-color: var(--accent);
	}

	.start-label {
		color: var(--ink);
		font-size: 14.5px;
		font-weight: 600;
	}

	.start-note {
		color: var(--ink-muted);
		font-size: 12.5px;
		line-height: 1.4;
	}

	.section-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
		gap: 9px;
	}

	.section-card {
		display: grid;
		gap: 5px;
		border: 1px solid var(--border-soft);
		border-radius: 9px;
		background: var(--surface);
		padding: 13px 15px;
	}

	.section-card:hover {
		border-color: #b9c6c0;
	}

	.section-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.section-name {
		color: var(--ink);
		font-size: 14.5px;
		font-weight: 600;
	}

	.section-count {
		color: var(--ink-muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.section-blurb {
		color: var(--ink-muted);
		font-size: 12.5px;
		line-height: 1.4;
	}

	.home-cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 290px;
		gap: 36px;
		align-items: start;
	}

	.recent-list {
		display: grid;
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: 9px;
		overflow: hidden;
	}

	.recent {
		display: grid;
		gap: 1px;
		background: var(--surface);
		padding: 10px 14px;
		border-bottom: 1px solid var(--border-soft);
	}

	.recent:last-child {
		border-bottom: none;
	}

	.recent:hover {
		background: var(--surface-alt);
	}

	.recent-title {
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
	}

	.recent-path {
		color: var(--ink-muted);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
		word-break: break-all;
	}

	.api-list {
		display: grid;
		gap: 7px;
	}

	.api-list a {
		display: grid;
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: 8px;
		background: var(--surface);
		padding: 9px 12px;
	}

	.api-list a:hover {
		border-color: #b9c6c0;
	}

	.api-label {
		color: var(--accent);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 13px;
		font-weight: 600;
	}

	.api-note {
		color: var(--ink-muted);
		font-size: 12px;
	}

	@media (max-width: 1080px) {
		.home-cols {
			grid-template-columns: 1fr;
		}
	}
</style>
