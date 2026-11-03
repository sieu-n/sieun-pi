<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';

	let { data } = $props();

	let value = $state(data.content);
	let saving = $state(false);
	let saveError = $state('');

	async function save() {
		saving = true;
		saveError = '';
		try {
			const res = await fetch(`${base}/api/agent/page`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: data.slug, content: value, author: 'human', summary: 'editor save' }),
			});
			if (!res.ok) {
				const detail = await res.json().catch(() => ({}));
				throw new Error(detail.error ?? detail.message ?? `Save failed (HTTP ${res.status})`);
			}
			await goto(`${base}/page/${encodeURI(data.slug)}`);
		} catch (err) {
			saveError = (err as Error).message;
			saving = false;
		}
	}
</script>

<svelte:head><title>Editing {data.slug} · llm-wiki</title></svelte:head>

<div class="edit-wrap">
	<header class="edit-bar">
		<div class="edit-meta">
			<span class="tag">{data.exists ? 'Editing' : 'New page'}</span>
			<code>{data.slug}</code>
		</div>
		<div class="edit-actions">
			{#if saveError}<span class="save-error">{saveError}</span>{/if}
			<a class="ghost" href={data.exists ? `${base}/page/${data.slug}` : `${base}/`}>Cancel</a>
			<button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
		</div>
	</header>
	<div class="editor-host">
		<textarea
			class="html-editor"
			bind:value
			spellcheck="false"
			placeholder="Write the page in HTML — leading wiki meta comment, one h1, then your markup. No markdown."
		></textarea>
	</div>
</div>

<style>
	.edit-wrap {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 49px);
	}

	.edit-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.edit-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.tag {
		border-radius: 999px;
		background: var(--accent-soft);
		padding: 3px 10px;
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
	}

	.edit-meta code {
		overflow: hidden;
		color: var(--ink-muted);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.edit-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.save-error {
		color: #b4541f;
		font-size: 13px;
	}

	.ghost,
	.primary {
		border-radius: 8px;
		padding: 8px 16px;
		font-size: 14px;
		font-weight: 600;
	}

	.ghost {
		border: 1px solid var(--border);
		color: var(--ink-soft);
	}

	.primary {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}

	.primary:disabled {
		opacity: 0.6;
	}

	.editor-host {
		flex: 1;
		min-height: 0;
	}

	.html-editor {
		width: 100%;
		height: 100%;
		border: none;
		padding: 20px 24px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 13px;
		line-height: 1.6;
		color: var(--ink);
		background: var(--surface);
		resize: none;
		outline: none;
	}
</style>
