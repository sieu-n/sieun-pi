<script lang="ts">
	import { base } from '$app/paths';
	import EChart from '$lib/charts/EChart.svelte';
	import {
		barTooltip,
		categoryAxis,
		insideZoom,
		recipeGrid,
		recipeLegend,
		sliderZoom,
		stackedBars,
		tooltipHtml,
		valueAxis,
	} from '$lib/charts/recipe';
	import { fmt, type ChartTokens } from '$lib/charts/tokens';
	import type { SkillMetricsHost, SkillMetricsItem } from '$lib/server/skill-metrics';

	let { data } = $props();

	function fmtCount(n: number): string {
		if (n >= 10_000) return Math.round(n / 1000) + 'k';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
		return String(n);
	}

	const HOST_LABEL: Record<string, string> = {
		'claude-code': 'Claude Code',
		codex: 'Codex',
		'prime-agent': 'Prime Agent',
	};
	function hostLabel(host: string): string {
		return HOST_LABEL[host] ?? host;
	}

	function layerLabel(layer: string): string {
		return layer === 'rule' ? 'Rule' : 'Skill';
	}

	/** `skill_key` carries a `repo:`/`home:`/`abs:` prefix (see derive-context.mjs).
	 *  Only repo-relative keys have a mirrored wiki page to link to. */
	function itemHref(skillKey: string): string | null {
		if (!skillKey.startsWith('repo:')) return null;
		return `/page/@code/${skillKey.slice('repo:'.length)}`;
	}

	function pickHost(hosts: SkillMetricsHost[], selected: string | null): string | null {
		if (selected && hosts.some((h) => h.host === selected)) return selected;
		return hosts[0]?.host ?? null;
	}

	function hostItems(items: SkillMetricsItem[], host: string | null): SkillMetricsItem[] {
		return items.filter((i) => i.host === host).sort((a, b) => b.reads - a.reads);
	}

	function dayLabel(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC',
		});
	}

	function stamp(ts: string | null): string {
		if (!ts) return '—';
		const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
		const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
		const d = new Date(withZone);
		if (Number.isNaN(d.getTime())) return ts;
		return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
	}

	let selectedHost = $state<string | null>(null);

	/** Stacked bars, one per agent, from `reads_daily`. Ranked by total reads so
	 *  the busiest agent anchors the bottom of the stack and the legend order. */
	function readsPerDayOption(daily: { day: string; agent: string; reads: number }[]) {
		const days = [...new Set(daily.map((r) => r.day))].sort();
		const totals = new Map<string, number>();
		for (const r of daily) totals.set(r.agent, (totals.get(r.agent) ?? 0) + r.reads);
		const agents = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
		const at = new Map(daily.map((r) => [`${r.agent}|${r.day}`, r.reads]));
		return (t: ChartTokens): Record<string, unknown> => ({
			grid: recipeGrid({ top: 28, right: 8, bottom: 46, left: 4 }),
			legend: recipeLegend(t),
			xAxis: categoryAxis(t, { data: days, formatter: dayLabel }),
			yAxis: valueAxis(t, { minInterval: 1, formatter: fmt }),
			tooltip: barTooltip(t, {
				formatter: (items: { dataIndex: number }[]) => {
					const day = days[items[0]?.dataIndex ?? -1];
					if (!day) return '';
					return tooltipHtml(
						t,
						dayLabel(day),
						agents.map((a, i) => ({
							swatch: t.palette[i % t.palette.length],
							label: a,
							value: fmt(at.get(`${a}|${day}`) ?? 0),
						})),
					);
				},
			}),
			dataZoom: [insideZoom(), sliderZoom(t)],
			series: stackedBars(
				agents.map((a, i) => ({
					name: a,
					color: t.palette[i % t.palette.length],
					data: days.map((d) => at.get(`${a}|${d}`) ?? 0),
				})),
				{ barMaxWidth: 18 },
			),
		});
	}

	/** Two stacked bars per host — skill descriptions plus, for claude-code only,
	 *  the always-injected rule bodies. Zero-filled so a host with no rule layer
	 *  draws a clean single-segment bar instead of a gap. */
	function hostCostOption(hosts: SkillMetricsHost[]) {
		return (t: ChartTokens): Record<string, unknown> => ({
			grid: recipeGrid({ top: 28, right: 8, bottom: 24, left: 4 }),
			legend: recipeLegend(t),
			xAxis: categoryAxis(t, { data: hosts.map((h) => hostLabel(h.host)) }),
			yAxis: valueAxis(t, { minInterval: 1, formatter: fmt }),
			tooltip: barTooltip(t, {
				formatter: (items: { dataIndex: number }[]) => {
					const h = hosts[items[0]?.dataIndex ?? -1];
					if (!h) return '';
					return tooltipHtml(t, hostLabel(h.host), [
						{ swatch: t.palette[0], label: 'Skill descriptions', value: `${fmt(h.skill_description_chars)} chars` },
						{
							swatch: t.palette[4],
							label: 'Rule bodies (always-injected)',
							value: `${fmt(h.always_injected_rule_chars ?? 0)} chars`,
						},
					]);
				},
			}),
			series: stackedBars(
				[
					{ name: 'Skill descriptions', color: t.palette[0], data: hosts.map((h) => h.skill_description_chars) },
					{
						name: 'Rule bodies (always-injected)',
						color: t.palette[4],
						data: hosts.map((h) => h.always_injected_rule_chars ?? 0),
					},
				],
				{ barMaxWidth: 64 },
			),
		});
	}
</script>

<svelte:head>
	<title>Skills · llm-wiki</title>
</svelte:head>

<div class="skills">
	<h1>Skill Library</h1>
	<p class="lede">
		{data.total} skills, read live from
		<a href="{base}/page/@code/.agents/skills/repo/skill-creation/SKILL.md"><code>.agents/skills</code></a>
		— always current, nothing to regenerate. Governance lives in
		<a href="{base}/page/@code/.agents/skills/repo/skill-creation/SKILL.md">repo/skill-creation</a>.
	</p>
	{#if data.viewCoverage}
		<p class="coverage-note">{data.viewCoverage}</p>
	{/if}

	<section class="context">
		<h2>Live context — what each host injects right now</h2>
		{#if !data.skillMetricsEnabled}
			<p class="metrics-note">
				Live context metrics need local dev — this section only derives when the wiki runs in dev, or with
				<code>WIKI_EDITABLE=true</code>.
			</p>
		{:else}
			{#await data.skillMetrics}
				<p class="metrics-note">Deriving a fresh context snapshot...</p>
			{:then metrics}
				{#if !metrics}
					<p class="metrics-note">Live context metrics need local dev.</p>
				{:else if 'error' in metrics}
					<p class="metrics-note">Live context metrics need local dev — snapshot failed: {metrics.error}.</p>
				{:else if !metrics.hosts.length}
					<p class="metrics-note">The snapshot carries no host rows yet.</p>
				{:else}
					{@const effectiveHost = pickHost(metrics.hosts, selectedHost)}
					{@const shownItems = hostItems(metrics.items, effectiveHost)}

					<div class="host-cards">
						{#each metrics.hosts as h (h.host)}
							<article class="host-card">
								<h3>{hostLabel(h.host)}</h3>
								<div class="host-stats">
									<div class="hstat"><span class="hnum">{h.skills}</span><span class="hlab">skills</span></div>
									<div class="hstat"><span class="hnum">{h.visible_skills}</span><span class="hlab">visible</span></div>
									<div class="hstat" title="{h.skill_description_chars.toLocaleString()} characters">
										<span class="hnum">{fmtCount(h.skill_description_chars)}</span><span class="hlab">desc chars</span>
									</div>
									<div
										class="hstat"
										class:hstat-zero={!h.always_injected_rule_chars}
										title={h.always_injected_rule_chars
											? `${h.always_injected_rule_chars.toLocaleString()} characters, always injected`
											: 'no always-injected rule layer for this host'}
									>
										<span class="hnum"
											>{h.always_injected_rule_chars ? fmtCount(h.always_injected_rule_chars) : '—'}</span
										><span class="hlab">rule chars</span>
									</div>
								</div>
							</article>
						{/each}
					</div>

					<div class="charts-row">
						<div class="chart-panel">
							<h3>Reads per day, by agent</h3>
							{#if metrics.reads_daily.length}
								<div class="chart">
									<EChart option={readsPerDayOption(metrics.reads_daily)} preset="full" height="240px" />
								</div>
								<p class="chart-note">
									Agent attribution from the wiki's own view tracking — a different vocabulary than the three hosts
									above, since a read is counted regardless of which host's session made it.
								</p>
							{:else}
								<p class="muted-empty">No agent reads recorded in this window yet.</p>
							{/if}
						</div>
						<div class="chart-panel">
							<h3>Context cost per host</h3>
							<div class="chart">
								<EChart option={hostCostOption(metrics.hosts)} preset="full" height="240px" />
							</div>
						</div>
					</div>

					<div class="phead">
						<h3>Items injected, by host</h3>
						<div class="seg" role="group" aria-label="Host">
							{#each metrics.hosts as h (h.host)}
								<button type="button" class:on={effectiveHost === h.host} onclick={() => (selectedHost = h.host)}>
									{hostLabel(h.host)}
								</button>
							{/each}
						</div>
					</div>
					<div class="table-scroll">
						<table class="items">
							<thead>
								<tr>
									<th>Item</th>
									<th>Type</th>
									<th>Description</th>
									<th class="num-col">Desc chars</th>
									<th class="num-col">Reads</th>
									<th class="num-col">Sessions</th>
									<th>Last read</th>
								</tr>
							</thead>
							<tbody>
								{#each shownItems as item (item.skill_key)}
									{@const href = itemHref(item.skill_key)}
									<tr>
										<td>
											{#if href}
												<a {href}><code>{item.display_id}</code></a>
											{:else}
												<code>{item.display_id}</code>
											{/if}
										</td>
										<td>{layerLabel(item.layer)}</td>
										<td>{item.description}</td>
										<td class="num-col">{item.description_chars}</td>
										<td class="num-col">{item.reads}</td>
										<td class="num-col">{item.reader_sessions}</td>
										<td>{stamp(item.last_read)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if !shownItems.length}
						<p class="muted-empty">No items recorded for {hostLabel(effectiveHost ?? '')}.</p>
					{/if}
				{/if}
			{:catch err}
				<p class="metrics-note">
					Live context metrics need local dev — snapshot failed: {err instanceof Error ? err.message : String(err)}.
				</p>
			{/await}
		{/if}
	</section>

	{#each data.groups as group (group.key)}
		<h2>{group.label}</h2>
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th>Skill</th>
						<th class="num-col">Tracked views</th>
						<th class="num-col">Committed edits</th>
						<th>Use case</th>
					</tr>
				</thead>
				<tbody>
					{#each group.skills as skill (skill.id)}
						<tr>
							<td><a href="{base}/page/{skill.path}"><code>{skill.id}</code></a></td>
							<td class="num-col" title="Human: {skill.viewsHuman} · Agent: {skill.viewsAgent}"
								>{fmtCount(skill.trackedViews)}</td
							>
							<td class="num-col">
								{#if skill.historyAvailable && skill.committedEdits != null}
									{skill.committedEdits}
								{:else}
									<span class="unavail" title="Edit history not available for this skill">—</span>
								{/if}
							</td>
							<td>{skill.description}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/each}

	{#if data.ungrouped.length}
		<h2>Ungrouped (fix placement)</h2>
		<div class="table-scroll">
			<table>
				<tbody>
					{#each data.ungrouped as skill (skill.id)}
						<tr>
							<td><a href="{base}/page/{skill.path}"><code>{skill.id}</code></a></td>
							<td class="num-col" title="Human: {skill.viewsHuman} · Agent: {skill.viewsAgent}"
								>{fmtCount(skill.trackedViews)}</td
							>
							<td class="num-col">
								{#if skill.historyAvailable && skill.committedEdits != null}
									{skill.committedEdits}
								{:else}
									<span class="unavail" title="Edit history not available for this skill">—</span>
								{/if}
							</td>
							<td>{skill.description}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.skills {
		max-width: 72rem;
	}
	.lede {
		color: var(--muted, #666);
		margin-bottom: 0.75rem;
	}
	.coverage-note {
		font-size: 0.8rem;
		color: var(--muted, #666);
		font-style: italic;
		margin-bottom: 2rem;
	}
	h2 {
		margin-top: 2.25rem;
	}
	.table-scroll {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 56rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.45rem 0.75rem;
		border-bottom: 1px solid var(--border, #e3e3e3);
		vertical-align: top;
	}
	td:first-child {
		white-space: nowrap;
	}
	.num-col {
		text-align: right;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		width: 8rem;
	}
	th.num-col {
		text-align: right;
	}
	th:last-child,
	td:last-child {
		min-width: 28rem;
	}
	.unavail {
		color: var(--muted, #999);
	}

	.context {
		margin: 1.75rem 0 2.5rem;
		padding-bottom: 1.75rem;
		border-bottom: 1px solid var(--border);
	}
	.context h2 {
		margin-top: 0;
	}
	.metrics-note {
		font-size: 0.85rem;
		color: var(--ink-muted);
	}
	.host-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		margin: 0.9rem 0 1.5rem;
	}
	.host-card {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.85rem 1rem;
		background: var(--surface);
	}
	.host-card h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
	}
	.host-stats {
		display: flex;
		gap: 1.1rem;
		flex-wrap: wrap;
	}
	.hstat {
		display: flex;
		flex-direction: column;
	}
	.hnum {
		font-size: 1.15rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.hstat-zero .hnum {
		color: var(--ink-muted);
	}
	.hlab {
		font-size: 0.68rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}
	.charts-row {
		--color-ink: var(--ink);
		--color-ink-muted: var(--ink-muted);
		--color-ink-faint: var(--ink-muted);
		--color-rule: var(--border);
		--color-surface: var(--surface);
		--color-surface-alt: var(--surface-alt);
		--color-accent: var(--accent);
		--color-positive: var(--accent);
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1.25rem;
		margin: 0 0 1.5rem;
	}
	.chart-panel h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
	}
	.chart-note {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--ink-muted);
	}
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: 8px;
		background: var(--surface-alt);
	}
	.seg button {
		font: inherit;
		font-size: 0.78rem;
		padding: 0.2rem 0.6rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--ink-muted);
		cursor: pointer;
	}
	.seg button.on {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 650;
	}
	.phead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.5rem;
	}
	.phead h3 {
		margin: 0;
		font-size: 0.95rem;
	}
	table.items th:last-child,
	table.items td:last-child {
		min-width: 0;
		white-space: nowrap;
	}
	.muted-empty {
		font-size: 0.85rem;
		color: var(--ink-muted);
		font-style: italic;
		margin-top: 0.75rem;
	}
</style>
