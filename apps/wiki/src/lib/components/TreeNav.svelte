<script lang="ts">
	import { base } from '$app/paths';
	import type { WikiTreeNode } from '$lib/server/wiki-tree';

	let { nodes, activePath = '' }: { nodes: WikiTreeNode[]; activePath?: string } = $props();

	/** Folders the server sent without children, loaded from /api/agent/tree when opened. */
	let loaded = $state<Record<string, WikiTreeNode[]>>({});
	let loading = $state<Record<string, boolean>>({});
	let failed = $state<Record<string, string>>({});

	function isOpen(node: WikiTreeNode): boolean {
		return activePath === node.path || activePath.startsWith(`${node.path}/`);
	}
	function countOf(node: WikiTreeNode): number {
		return node.childCount ?? node.children.length;
	}
	function childrenOf(node: WikiTreeNode): WikiTreeNode[] {
		return node.children.length > 0 ? node.children : (loaded[node.path] ?? []);
	}

	async function load(node: WikiTreeNode): Promise<void> {
		if (node.children.length > 0 || countOf(node) === 0 || loaded[node.path] || loading[node.path]) return;
		loading[node.path] = true;
		delete failed[node.path];
		try {
			const response = await fetch(`${base}/api/agent/tree?path=${encodeURIComponent(node.path)}&depth=1`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			loaded[node.path] = ((await response.json()) as { tree: WikiTreeNode[] }).tree;
		} catch (error) {
			failed[node.path] = `Could not load this folder: ${error instanceof Error ? error.message : 'request failed'}`;
		} finally {
			loading[node.path] = false;
		}
	}
</script>

{#snippet tree(items: WikiTreeNode[])}
	<ul class="tree">
		{#each items as node (node.path)}
			<li>
				{#if node.type === 'dir' && node.pagePath && countOf(node) === 0}
					<!-- Folder whose only page is its index (e.g. a session log): one plain row. -->
					<a
						class="file"
						class:active={node.pagePath === activePath}
						href="{base}/page/{node.pagePath}"
						title={node.title}
						data-sveltekit-preload-data="tap"
					>
						{node.title || node.name}
					</a>
				{:else if node.type === 'dir'}
					<details open={isOpen(node)} ontoggle={(event) => event.currentTarget.open && load(node)}>
						<summary>
							{#if node.pagePath}
								<!-- Folder-as-page: the label navigates to the hub; the chevron still toggles. -->
								<a
									class="tw dir-link"
									class:active={node.pagePath === activePath}
									href="{base}/page/{node.pagePath}"
									title={node.title}
									data-sveltekit-preload-data="tap"
									onclick={(e) => e.stopPropagation()}
								>
									{node.name}
								</a>
							{:else}
								<span class="tw">{node.name}</span>
							{/if}
							{#if countOf(node) > 0}<span class="count">{countOf(node)}</span>{/if}
						</summary>
						{#if loading[node.path]}
							<p class="tree-note">Loading…</p>
						{:else if failed[node.path]}
							<p class="tree-note tree-note--bad" role="alert">{failed[node.path]}</p>
						{/if}
						{@render tree(childrenOf(node))}
					</details>
				{:else}
					<a
						class="file"
						class:active={node.path === activePath}
						href="{base}/page/{node.path}"
						title={node.title}
						data-sveltekit-preload-data="tap"
					>
						{node.title || node.name}
					</a>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

{@render tree(nodes)}

<style>
	.tree {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tree :global(.tree) {
		margin-left: 10px;
		padding-left: 9px;
		border-left: 1px solid #e3e9e6;
	}

	li {
		margin: 1px 0;
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
		content: '▸';
		color: #9aa8a3;
		font-size: 10px;
		transition: transform 0.12s ease;
	}

	details[open] > summary::before {
		transform: rotate(90deg);
	}

	.tw {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dir-link {
		color: inherit;
		border-radius: 4px;
	}

	.dir-link:hover {
		color: #12433a;
		text-decoration: underline;
	}

	.dir-link.active {
		color: #12433a;
	}

	summary:hover {
		background: #eef4f1;
		color: #16211f;
	}

	.count {
		color: #aab6b1;
		font-size: 11px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.file {
		display: block;
		overflow: hidden;
		border-radius: 6px;
		padding: 4px 8px;
		color: #55635e;
		font-size: 13px;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file:hover {
		background: #eef4f1;
		color: #16211f;
	}

	.file.active {
		background: #e4efe9;
		color: #12433a;
		font-weight: 600;
	}

	.tree-note {
		margin: 2px 0 2px 19px;
		color: #8a9893;
		font-size: 12px;
	}

	.tree-note--bad {
		color: #a2413a;
	}
</style>
