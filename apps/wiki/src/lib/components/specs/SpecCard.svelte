<script lang="ts">
	import { base, resolve } from '$app/paths';
	import KindIcon from './KindIcon.svelte';
	import { ENV_LABEL, type Criterion, type Row, type Spec, type SpecPatch } from './types';

	let {
		spec,
		days,
		local,
		onrefresh,
		onsay,
	}: {
		spec: Spec;
		days: string[];
		local: boolean;
		/** the page reloads its data; called after a run ends and after a save */
		onrefresh: () => Promise<void>;
		onsay: (text: string, bad?: boolean) => void;
	} = $props();

	let editing = $state(false);
	let saving = $state(false);
	let draft = $state({ title: '', journey: '', notes: '', criteria: [] as string[] });
	let log = $state<string | null>(null);
	let running = $state(false);
	let runWhat = $state('');
	let logBox: HTMLPreElement | undefined = $state();

	const today = $derived(days.at(-1));
	const canRun = $derived(spec.criteria.some((c) => c.check !== 'none'));

	function startEdit() {
		draft = { title: spec.title, journey: spec.journey, notes: spec.notes, criteria: spec.criteria.map((c) => c.text) };
		editing = true;
	}
	async function patch(
		body: SpecPatch,
	): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
		const response = await fetch(`${base}/api/specs/${spec.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const value = (await response.json().catch(() => null)) as { message?: string } | null;
		if (!response.ok) return { ok: false, message: value?.message ?? `HTTP ${response.status}` };
		return { ok: true, value: value ?? {} };
	}
	async function save() {
		saving = true;
		const body: SpecPatch = {
			title: draft.title,
			journey: draft.journey,
			notes: draft.notes,
			criteria: draft.criteria
				.map((text, index) => ({ index, text }))
				.filter((c) => c.text !== spec.criteria[c.index].text),
		};
		const result = await patch(body);
		saving = false;
		if (!result.ok) return onsay(result.message, true);
		editing = false;
		await onrefresh();
		onsay(`${spec.id} saved`);
	}
	async function setStatus(status: 'draft' | 'approved') {
		if (status === 'approved' && !confirm(`Approve ${spec.id}? The draft line is removed and the file is committed.`))
			return;
		saving = true;
		const result = await patch({ status });
		saving = false;
		await onrefresh();
		if (!result.ok) return onsay(result.message, true);
		onsay(status === 'approved' ? `${spec.id} approved and committed` : `${spec.id} is a draft again`);
	}

	/** Runs the runner for the whole spec, or one criterion by its check name and env. */
	async function play(criterion: Criterion | null) {
		if (running) return;
		running = true;
		runWhat = criterion ? `${ENV_LABEL[criterion.env]}: ${criterion.text}` : 'every criterion';
		log = '';
		try {
			const response = await fetch(`${base}/api/specs/run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					criterion ? { spec: spec.id, check: criterion.check, env: criterion.env } : { spec: spec.id },
				),
			});
			if (!response.ok || !response.body) {
				const value = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(value?.message ?? `HTTP ${response.status}`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let cut: number;
				while ((cut = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					const isDone = block.startsWith('event: done');
					const data = block
						.split('\n')
						.filter((line) => line.startsWith('data: '))
						.map((line) => line.slice(6))
						.join('\n');
					if (isDone) {
						const end = JSON.parse(data) as { code: number | null };
						log += `\nrunner exited with code ${end.code ?? 'none'}\n`;
					} else log += data + '\n';
					queueMicrotask(() => logBox?.scrollTo(0, logBox.scrollHeight));
				}
			}
		} catch (failure) {
			log += `\n${failure instanceof Error ? failure.message : 'run failed'}\n`;
			onsay(failure instanceof Error ? failure.message : 'Run failed.', true);
		} finally {
			running = false;
			await onrefresh();
		}
	}

	const metricText = (row: Row) =>
		Object.entries(row.metrics ?? {})
			.map(([k, v]) => `${k}=${v}`)
			.join('  ');
	const fileName = (path: string) => path.split('/').at(-1) ?? path;
	const artifactUrl = (path: string) => `${resolve('/api/specs/artifact')}?path=${encodeURIComponent(path)}`;
	/** `2026-10-06 03:02` in the owner's zone, the same calendar the day cells use */
	const stamp = (at: string) => {
		const d = new Date(at);
		if (Number.isNaN(d.getTime())) return at;
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Asia/Seoul',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).formatToParts(d);
		const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
		return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
	};
</script>

<article class="spec" id={spec.id}>
	<header>
		<div class="head-text">
			{#if editing}
				<label class="field"><span>Title</span><input bind:value={draft.title} aria-label="Title" /></label>
			{:else}
				<h3><span class="id">{spec.id}</span>{spec.title}</h3>
			{/if}
			<div class="tags">
				{#if spec.status === 'draft'}<span class="badge draft">draft</span>{/if}
				{#if spec.every !== 'daily'}<span class="badge">{spec.every}</span>{/if}
				<span class="file" title={spec.file}>{spec.file}</span>
			</div>
		</div>
		{#if local}
			<div class="actions">
				{#if editing}
					<button class="primary" onclick={save} disabled={saving}>Save</button>
					<button class="ghost" onclick={() => (editing = false)} disabled={saving}>Cancel</button>
				{:else}
					<button
						class="ghost"
						onclick={() => play(null)}
						disabled={running || !canRun}
						title="Run every criterion of this spec"
					>
						<KindIcon name="play" size={12} />Play
					</button>
					<button class="ghost" onclick={startEdit} disabled={saving}><KindIcon name="pencil" size={12} />Edit</button>
					{#if spec.status === 'draft'}
						<button class="primary" onclick={() => setStatus('approved')} disabled={saving}>
							<KindIcon name="check" size={13} />Approve
						</button>
					{:else}
						<button class="ghost quiet" onclick={() => setStatus('draft')} disabled={saving}>Mark draft</button>
					{/if}
				{/if}
			</div>
		{/if}
	</header>

	{#if editing}
		<label class="field"
			><span>Journey</span><textarea rows="2" bind:value={draft.journey} aria-label="Journey"></textarea></label
		>
		<label class="field"
			><span>Notes</span><textarea rows="2" bind:value={draft.notes} aria-label="Notes"></textarea></label
		>
	{:else}
		{#if spec.journey}<p class="journey">{spec.journey}</p>{/if}
		{#if spec.notes}<p class="notes">{spec.notes}</p>{/if}
	{/if}

	{#if log !== null}
		<div class="run" aria-live="polite">
			<div class="run-head">
				<span>{running ? 'Running' : 'Ran'} {runWhat}</span>
				{#if !running}<button class="ghost quiet" onclick={() => (log = null)}>Close</button>{/if}
			</div>
			<pre bind:this={logBox}>{log}{#if running}<span class="cursor">▍</span>{/if}</pre>
		</div>
	{/if}

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th class="env">Env</th>
					<th>Criterion</th>
					<th class="check">Check</th>
					{#each days as day (day)}
						<th class="cell" class:today={day === today} title={day}>{day.slice(8)}</th>
					{/each}
					{#if local}<th class="play"></th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each spec.criteria as c (c.index)}
					<tr>
						<td class="env"><span class="badge env-{c.env}">{ENV_LABEL[c.env]}</span></td>
						<td class="text">
							{#if editing}
								<input bind:value={draft.criteria[c.index]} aria-label={`Criterion ${c.index + 1}`} />
							{:else}
								<div>{c.text}</div>
								{#if c.latest}
									<div class="latest" class:bad={!c.latest.pass}>
										<span class="when" title={c.latest.at}>{stamp(c.latest.at)}, {c.latest.duration_ms} ms</span>
										{c.latest.note || c.latest.error || (c.latest.pass ? 'passed' : 'failed')}
									</div>
									{#if Object.keys(c.latest.metrics ?? {}).length}<div class="metrics">{metricText(c.latest)}</div>{/if}
									{#if c.latest.artifacts?.length}
										<div class="files">
											{#each [...new Set(c.latest.artifacts)] as path (path)}
												<a href={artifactUrl(path)} target="_blank" rel="noopener">{fileName(path)}</a>
											{/each}
										</div>
									{/if}
								{/if}
							{/if}
						</td>
						<td class="check"><code>{c.check}</code></td>
						{#each c.cells as cell, i (days[i])}
							<td class="cell" class:today={days[i] === today} title={days[i]}>
								{#if cell !== null}<span class="chip" class:p={cell} class:f={!cell}>{cell ? 'P' : 'F'}</span>{/if}
							</td>
						{/each}
						{#if local}
							<td class="play">
								{#if c.check !== 'none'}
									<button
										onclick={() => play(c)}
										disabled={running}
										aria-label={`Run ${c.check} for ${ENV_LABEL[c.env]}`}
										title="Run this criterion"
									>
										<KindIcon name="play" size={12} />
									</button>
								{/if}
							</td>
						{/if}
					</tr>
				{:else}
					<tr><td colspan={3 + days.length + (local ? 1 : 0)} class="none">No criteria yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</article>

<style>
	.spec {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 16px 18px 6px;
		margin: 0 0 14px;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 12px;
	}
	.head-text {
		min-width: min(100%, 320px);
		flex: 1;
	}
	h3 {
		margin: 0;
		font-size: 15.5px;
		font-weight: 650;
		line-height: 1.35;
	}
	.id {
		font-weight: 500;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
		margin-right: 8px;
	}
	.tags {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		font-size: 11.5px;
		color: var(--ink-muted);
	}
	.file {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		display: inline-block;
		font-size: 10.5px;
		font-weight: 600;
		line-height: 1;
		padding: 3px 6px;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--ink-soft);
		background: var(--surface-alt);
		white-space: nowrap;
	}
	.badge.draft {
		border-style: dashed;
		color: #8a5a00;
		background: #fbf3e3;
		border-color: #e9d4a3;
	}
	.badge.env-local {
		color: var(--ink-soft);
	}
	.badge.env-staging {
		color: #1f4f8a;
		background: #e9f0fa;
		border-color: #c9d9ef;
	}
	.badge.env-prod {
		color: #1f7a45;
		background: #eaf6ee;
		border-color: #c4e3cf;
	}
	.actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}
	.primary,
	.ghost {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font: inherit;
		font-size: 12.5px;
		font-weight: 600;
		border-radius: 7px;
		padding: 5px 10px;
		cursor: pointer;
	}
	.primary {
		background: var(--accent);
		border: 1px solid var(--accent);
		color: #fff;
	}
	.ghost {
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--ink-soft);
	}
	.ghost:hover:not(:disabled) {
		color: var(--ink);
		border-color: var(--ink-muted);
	}
	.ghost.quiet {
		border-color: transparent;
		font-weight: 500;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.journey {
		margin: 10px 0 0;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--ink-soft);
		max-width: 80ch;
	}
	.notes {
		margin: 6px 0 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-muted);
		white-space: pre-line;
		max-width: 80ch;
	}
	.field {
		display: block;
		margin-top: 8px;
	}
	.field span {
		display: block;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink-muted);
		margin-bottom: 3px;
	}
	input,
	textarea {
		width: 100%;
		font: inherit;
		font-size: 13px;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 8px;
		background: var(--surface);
		color: var(--ink);
		resize: vertical;
	}
	input:focus-visible,
	textarea:focus-visible,
	button:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.run {
		margin-top: 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: #1f1f24;
		color: #e6e6e6;
		overflow: hidden;
	}
	.run-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px;
		font-size: 12px;
		color: #c8c8c8;
		border-bottom: 1px solid #333;
	}
	.run-head .ghost {
		background: transparent;
		color: #c8c8c8;
		padding: 2px 6px;
	}
	.run pre {
		margin: 0;
		padding: 10px;
		font-size: 11.5px;
		line-height: 1.5;
		max-height: 320px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.cursor {
		animation: blink 1s steps(2) infinite;
	}
	@keyframes blink {
		to {
			opacity: 0;
		}
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 12px;
		font-size: 13px;
	}
	th {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--ink-muted);
		text-align: left;
		padding: 0 6px 6px;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	td {
		padding: 8px 6px;
		border-bottom: 1px solid var(--border-soft);
		vertical-align: top;
	}
	tr:last-child td {
		border-bottom: 0;
	}
	td.env,
	th.env {
		width: 1%;
		padding-left: 0;
	}
	td.text {
		min-width: 280px;
		line-height: 1.45;
	}
	td.text input {
		font-size: 13px;
	}
	.latest {
		margin-top: 4px;
		font-size: 12px;
		color: var(--ink-soft);
	}
	.latest.bad {
		color: #b03a22;
	}
	.when {
		color: var(--ink-muted);
		margin-right: 6px;
		font-variant-numeric: tabular-nums;
	}
	.metrics {
		margin-top: 2px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 11px;
		color: var(--ink-muted);
		white-space: pre-wrap;
	}
	.files {
		margin-top: 3px;
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-size: 11.5px;
	}
	.files a {
		color: var(--accent);
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	td.check,
	th.check {
		width: 1%;
		white-space: nowrap;
	}
	code {
		font-size: 11.5px;
		color: var(--ink-soft);
	}
	th.cell,
	td.cell {
		width: 22px;
		min-width: 22px;
		padding: 8px 0;
		text-align: center;
		font-size: 10.5px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	th.cell {
		padding-bottom: 6px;
	}
	th.cell.today,
	td.cell.today {
		background: color-mix(in srgb, var(--ink) 4%, transparent);
	}
	.chip {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
		color: #fff;
	}
	.chip.p {
		background: #2a9d4a;
	}
	.chip.f {
		background: #c0392b;
	}
	th.play,
	td.play {
		width: 26px;
		padding-right: 0;
		text-align: right;
	}
	td.play button {
		border: 0;
		background: none;
		color: var(--ink-muted);
		cursor: pointer;
		padding: 2px;
		border-radius: 4px;
		display: inline-grid;
	}
	td.play button:hover:not(:disabled) {
		color: var(--ink);
		background: var(--surface-alt);
	}
	.none {
		color: var(--ink-muted);
		font-size: 12.5px;
	}
</style>
