<script lang="ts">
	import { base } from '$app/paths';
	const PAGES = [
		{
			uid: 'ci',
			title: 'CI speed',
			answers:
				'the four CI targets, what waits and runs now, why jobs wait, runner capacity, and one workflow, job or run in rows at the bottom.',
		},
		{
			uid: 'ci-failures',
			title: 'CI failures',
			answers:
				'whether the shared branches are green, what fails, what flakes, which tests earn their time, and the CI feeds and alerts.',
		},
		{
			uid: 'ci-code',
			title: 'CI code and tests size',
			answers: 'code lines, test lines and test cases per app on dev/sieun per day.',
		},
	];
</script>

<svelte:head><title>CI · Playground · llm-wiki</title></svelte:head>

<div class="ci">
	<p class="crumb"><a href="{base}/playground">Playground</a> / CI</p>
	<h1>CI</h1>
	<p class="lede">
		The CI charts moved to the CI app in Grafana, which reads every GitHub Actions run since March from one ClickHouse
		store. Each board links to the others across its top.
	</p>
	<ul>
		{#each PAGES as p (p.uid)}
			<li><a href="https://obs.virev.ai/d/{p.uid}">{p.title}</a>: {p.answers}</li>
		{/each}
	</ul>
</div>

<style>
	.ci {
		max-width: 48rem;
	}
	.crumb {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-muted);
	}
	.crumb a,
	li a {
		color: var(--accent);
	}
	.lede {
		color: var(--ink-muted);
	}
	li {
		margin: 0.35rem 0;
	}
</style>
