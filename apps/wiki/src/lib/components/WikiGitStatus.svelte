<script lang="ts" module>
	type RunStateName = 'running' | 'queued' | 'passed' | 'failed' | 'cancelled' | 'skipped';
	interface Run {
		state: RunStateName;
		url: string;
		startedAt: string;
		updatedAt: string;
	}
	interface Commit {
		sha: string;
		at: string;
		subject: string;
	}
	interface DevBranch {
		branch: string;
		host: string;
		pusher: 'release-owner' | 'checkout';
		tip: Commit;
		lastLand: { sha: string; stagingSha: string; at: string } | null;
		sinceLand: number | null;
		unpushed: number | null;
		local: Commit | null;
		verify: (Run & { land: 'passes' | 'blocks' | 'checking' | 'unknown' }) | null;
	}
	/** The JSON of scripts/ci/git-status.mjs, served at /api/git-status. */
	export interface GitStatus {
		at: string;
		fetchedAt: string;
		ciAt: string | null;
		repoUrl: string;
		staging: Commit & { check: Run | null; deploy: Run | null };
		main: Commit & { movedAt: string | null; waiting: number; promote: Run | null };
		dev: DevBranch[];
		lands: Array<{
			sha: string;
			at: string;
			from: Array<{ branch: string; sha: string }>;
			deploy: Run | null;
			check: Run | null;
		}>;
		active: Array<Run & { kind: string }>;
	}
</script>

<script lang="ts">
	import { base } from '$app/paths';
	// The owner asked for a view that refreshes by itself "every minute or so" (2026-10-29, msg mvtfuqd3).
	const REFRESH_MS = 60_000;

	let status = $state.raw<GitStatus | null>(null);
	let failed = $state<string | null>(null);
	let now = $state(Date.now());

	$effect(() => {
		let live = true;
		const read = () =>
			fetch(`${base}/api/git-status`, { cache: 'no-store' })
				.then((response) => {
					if (!response.ok) throw new Error(`/api/git-status answered ${response.status}`);
					return response.json() as Promise<GitStatus>;
				})
				.then(
					(next) => {
						if (!live) return;
						status = next;
						failed = null;
						now = Date.now();
					},
					(error: unknown) => {
						if (live) failed = error instanceof Error ? error.message : String(error);
					},
				);
		void read();
		const timer = setInterval(read, REFRESH_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	});

	const short = (sha: string) => sha.slice(0, 9);
	const commitUrl = (sha: string) => `${status?.repoUrl}/commit/${sha}`;

	function ago(iso: string | null): string {
		if (!iso) return 'unknown';
		const minutes = Math.round((now - Date.parse(iso)) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return `${hours} h ${minutes % 60} min ago`;
		return `${Math.floor(hours / 24)} days ago`;
	}

	function clock(iso: string): string {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	const STATE_WORDS: Record<RunStateName, string> = {
		running: 'running',
		queued: 'waiting to start',
		passed: 'passed',
		failed: 'failed',
		cancelled: 'cancelled',
		skipped: 'skipped',
	};
	const LAND_WORDS = {
		passes: 'the land can take it',
		blocks: 'a land check failed',
		checking: 'land checks running',
		unknown: 'no land checks read',
	};
	const LAND_TONE = { passes: 'passed', blocks: 'failed', checking: 'running', unknown: 'cancelled' } as const;
</script>

{#snippet pill(label: string, run: Run | null)}
	{#if run}
		<a class="pill {run.state}" href={run.url} target="_blank" rel="noreferrer" title="Started {clock(run.startedAt)}">
			{label}
			{STATE_WORDS[run.state]}
		</a>
	{:else}
		<span class="pill none">{label} not in the CI cache</span>
	{/if}
{/snippet}

{#snippet sha(value: string)}
	<a class="sha" href={commitUrl(value)} target="_blank" rel="noreferrer">{short(value)}</a>
{/snippet}

<section class="git-status" aria-label="Live git branch status">
	{#if status}
		<header>
			<strong>Branches right now</strong>
			<span>git read {ago(status.fetchedAt)}, CI read {ago(status.ciAt)}, refreshes every minute</span>
		</header>

		<div class="flow" style="--lanes: {status.dev.length}">
			{#each status.dev as dev, lane (dev.branch)}
				<article class="card" style="grid-area: 1 / {lane + 1}">
					<h4>{dev.branch} <small>{dev.host === 'mac' ? 'the Mac' : dev.host}</small></h4>
					<p class="big"><b>{dev.sinceLand ?? '?'}</b> commits since its last land</p>
					{#if dev.unpushed}
						<p>{dev.unpushed} more on the box, not pushed yet</p>
					{/if}
					<p>Tip {@render sha(dev.tip.sha)} pushed {ago(dev.tip.at)}</p>
					<p class="subject" title={dev.tip.subject}>{dev.tip.subject}</p>
					<div class="pills">
						{#if dev.verify}
							{@render pill('CI on the tip', dev.verify)}
							<a class="pill {LAND_TONE[dev.verify.land]}" href={dev.verify.url} target="_blank" rel="noreferrer"
								>{LAND_WORDS[dev.verify.land]}</a
							>
						{:else}
							<span class="pill none">no CI run for the tip yet</span>
						{/if}
					</div>
					<p class="who">
						{dev.pusher === 'release-owner'
							? 'Only the release owner pushes it.'
							: 'Any session on its machine pushes it.'}
					</p>
				</article>
				<div class="arrow" style="grid-area: 2 / {lane + 1}">
					<i></i>
					<span><b>land</b> {dev.lastLand ? `last ${ago(dev.lastLand.at)}` : 'never yet'}</span>
				</div>
			{/each}

			<article class="card trunk">
				<h4>staging <small>the trunk</small></h4>
				<p>
					Tip {@render sha(status.staging.sha)} landed {ago(status.staging.at)}, {status.staging.subject.replace(
						/^land: /,
						'from ',
					)}
				</p>
				<div class="pills">
					{@render pill('deploy', status.staging.deploy)}
					{@render pill('check', status.staging.check)}
				</div>
			</article>

			<div class="arrow promote">
				<i></i>
				<span><b>promote</b> <b class="count">{status.main.waiting}</b> lands waiting</span>
			</div>

			<article class="card prod">
				<h4>main <small>production</small></h4>
				<p>
					Tip {@render sha(status.main.sha)} since {ago(status.main.movedAt)}{status.main.movedAt
						? ` (${clock(status.main.movedAt)})`
						: ''}
				</p>
				<div class="pills">
					{#if status.main.promote}
						{@render pill('last promote', status.main.promote)}
					{:else}
						<a class="pill none" href="{status.repoUrl}/actions/workflows/promote.yml" target="_blank" rel="noreferrer"
							>promote runs</a
						>
					{/if}
				</div>
			</article>
		</div>

		<h4 class="label">Running now</h4>
		{#if status.active.length === 0}
			<p class="quiet">No land, staging check, staging deploy or promote is running.</p>
		{:else}
			<div class="pills">
				{#each status.active as run (run.url)}
					<a class="pill {run.state}" href={run.url} target="_blank" rel="noreferrer"
						>{run.kind} {STATE_WORDS[run.state]}, started {ago(run.startedAt)}</a
					>
				{/each}
			</div>
		{/if}

		<h4 class="label">Last lands on staging</h4>
		<table>
			<thead><tr><th>When</th><th>From</th><th>Staging commit</th><th>Deploy</th><th>Check</th></tr></thead>
			<tbody>
				{#each status.lands as land (land.sha)}
					<tr>
						<td title={land.at}>{clock(land.at)} <small>{ago(land.at)}</small></td>
						<td>
							{#each land.from as from (from.branch)}
								<span class="from">{from.branch} {@render sha(from.sha)}</span>
							{/each}
						</td>
						<td>{@render sha(land.sha)}</td>
						<td>{@render pill('deploy', land.deploy)}</td>
						<td>{@render pill('check', land.check)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else if failed}
		<p class="quiet" role="alert">Branch status did not load: {failed}</p>
	{:else}
		<div class="wait" aria-hidden="true"></div>
	{/if}
</section>

<style>
	.git-status {
		--ok: #1a7f37;
		--bad: #cf222e;
		--run: #9a6700;
		--idle: #66736f;
		margin: 1rem 0 1.5rem;
		padding: 1rem;
		border: 1px solid var(--border, #dfe5e2);
		border-radius: 10px;
		background: var(--surface, #fff);
		font-size: 0.85rem;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
		margin-bottom: 0.75rem;
	}
	header span,
	small,
	.quiet,
	.who {
		color: var(--ink-muted, #66736f);
	}
	.flow {
		display: grid;
		grid-template-columns: repeat(var(--lanes), minmax(0, 1fr));
		gap: 0 0.75rem;
	}
	.card {
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border, #dfe5e2);
		border-radius: 8px;
		background: var(--surface-alt, #fbfcfb);
		min-width: 0;
	}
	.trunk,
	.prod,
	.promote {
		grid-column: 1 / -1;
	}
	.trunk {
		border-color: var(--accent, #1d4f43);
	}
	.arrow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.6rem;
		padding-left: 1.5rem;
		font-size: 0.8rem;
		color: var(--ink-muted, #66736f);
	}
	.promote {
		justify-content: center;
		padding-left: 0;
	}
	.arrow i {
		position: relative;
		align-self: stretch;
		width: 2px;
		margin: 0.2rem 0 0.45rem;
		background: var(--idle);
	}
	.arrow i::after {
		content: '';
		position: absolute;
		bottom: -6px;
		left: -4px;
		border: 5px solid transparent;
		border-top: 8px solid var(--idle);
		border-bottom: 0;
	}
	.arrow b {
		color: var(--ink, #16211f);
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: 0.95rem;
	}
	h4.label {
		margin: 1rem 0 0.4rem;
		font-size: 0.85rem;
	}
	.card p {
		margin: 0.15rem 0;
	}
	.big b,
	.count {
		font-size: 1.25rem;
	}
	.subject {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--ink-soft, #3a4a45);
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.35rem;
	}
	.pill {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		border: 1px solid currentColor;
		font-size: 0.75rem;
		text-decoration: none;
		white-space: nowrap;
	}
	.pill.passed {
		color: var(--ok);
		background: #e9f6ec;
	}
	.pill.failed {
		color: var(--bad);
		background: #fdecec;
	}
	.pill.running,
	.pill.queued {
		color: var(--run);
		background: #fdf4dc;
	}
	.pill.cancelled,
	.pill.skipped,
	.pill.none {
		color: var(--idle);
	}
	.sha {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}
	.from {
		display: block;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: 0.25rem 0.5rem 0.25rem 0;
		text-align: left;
		border-bottom: 1px solid var(--border-soft, #eef2f0);
		vertical-align: top;
	}
	.wait {
		height: 220px;
		border-radius: 8px;
		background: var(--surface-alt, #fbfcfb);
	}
</style>
