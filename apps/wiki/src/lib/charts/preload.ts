/**
 * The chart registries as one import each per tab. EChart.svelte's first load reads the same promise, so the registry
 * is imported once (EChart.svelte loadRegistry says why that matters); a Retry there imports a fresh URL.
 */
type Registry = typeof import('./registry');

const started: { basic?: Promise<Registry>; full?: Promise<Registry> } = {};

/** The basic (line, area) or the full chart registry, imported on the first call. */
export function chartRegistry(full: boolean): Promise<Registry> {
	if (full) return (started.full ??= import('$lib/charts/registry'));
	return (started.basic ??= import('$lib/charts/registry-basic') as Promise<Registry>);
}
