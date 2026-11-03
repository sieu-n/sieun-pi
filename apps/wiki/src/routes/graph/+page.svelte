<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	let container = $state<HTMLDivElement | null>(null);
	let status = $state('Loading graph…');
	let stats = $state({ nodes: 0, edges: 0 });

	onMount(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Sigma is dynamically imported; typing the instance precisely requires generics that change across sigma versions
		let renderer: any = null;

		(async () => {
			const [{ default: Graph }, { default: Sigma }, { default: forceAtlas2 }, res] = await Promise.all([
				import('graphology'),
				import('sigma'),
				import('graphology-layout-forceatlas2'),
				fetch(`${base}/api/agent/graph`),
			]);
			const data = await res.json();
			const graph = new Graph();

			const degree = new Map<string, number>();
			for (const edge of data.edges) {
				degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
				degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
			}

			const palette: Record<string, string> = {
				md: '#1d4f43',
				mdx: '#1d4f43',
				yaml: '#9a6b1f',
				yml: '#9a6b1f',
				json: '#7c8884',
				txt: '#7c8884',
			};

			for (const node of data.nodes) {
				const deg = degree.get(node.id) ?? 0;
				graph.addNode(node.id, {
					label: node.title,
					x: Math.random(),
					y: Math.random(),
					size: Math.min(3 + Math.sqrt(deg) * 1.6, 14), // out of scope: a node's drawn size, not a limit
					color: palette[node.kind] ?? '#7c8884',
				});
			}
			for (const edge of data.edges) {
				if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.source, edge.target)) {
					graph.addEdge(edge.source, edge.target, { color: '#dde5e1', size: 0.6 });
				}
			}

			stats = { nodes: graph.order, edges: graph.size };
			if (graph.order === 0) {
				status = 'No linked pages to graph.';
				return;
			}

			forceAtlas2.assign(graph, {
				iterations: graph.order > 300 ? 120 : 250,
				settings: { ...forceAtlas2.inferSettings(graph), gravity: 1.2, scalingRatio: 18, barnesHutOptimize: true },
			});

			if (!container) return;
			renderer = new Sigma(graph, container, {
				labelRenderedSizeThreshold: 9,
				defaultEdgeColor: '#dde5e1',
				labelFont: 'Inter, system-ui, sans-serif',
				labelColor: { color: '#3a4a45' },
			});
			renderer.on('clickNode', ({ node }: { node: string }) => goto(`${base}/page/${encodeURI(node)}`));
			status = '';
		})().catch((err) => {
			status = `Failed to load graph: ${err.message}`;
		});

		return () => renderer?.kill();
	});
</script>

<svelte:head><title>Graph · llm-wiki</title></svelte:head>

<div class="graph-wrap">
	<div class="graph-bar">
		<div>
			<h1>Link graph</h1>
			<p class="muted">{stats.nodes} pages · {stats.edges} links · click a node to open</p>
		</div>
		{#if status}<span class="graph-status">{status}</span>{/if}
	</div>
	<div class="graph-canvas" bind:this={container}></div>
</div>

<style>
	.graph-wrap {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 49px);
	}

	.graph-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 16px 28px;
		border-bottom: 1px solid var(--border);
	}

	.graph-bar h1 {
		margin: 0;
		font-size: 20px;
	}

	.graph-bar .muted {
		margin: 3px 0 0;
		font-size: 13px;
	}

	.graph-status {
		color: var(--ink-muted);
		font-size: 13px;
	}

	.graph-canvas {
		flex: 1;
		min-height: 0;
		background: radial-gradient(circle at 50% 40%, #ffffff, #f1f4f2);
	}
</style>
