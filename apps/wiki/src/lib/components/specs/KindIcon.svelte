<script lang="ts">
	export type IconName =
		| 'browser'
		| 'flask'
		| 'pulse'
		| 'play'
		| 'stop'
		| 'window'
		| 'code'
		| 'folder'
		| 'plus'
		| 'trash'
		| 'pencil'
		| 'agent'
		| 'close'
		| 'chevron'
		| 'layers'
		| 'check';
	let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'browser'}<rect x="3" y="4" width="18" height="16" rx="2.5" /><path
			d="M3 9h18M6.5 6.5h.01M9 6.5h.01M9.5 12.5l3 2.5-3 2.5"
		/>
	{:else if name === 'flask'}<path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path
			d="M7.5 15h9"
		/>
	{:else if name === 'pulse'}<path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
	{:else if name === 'play'}<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" />
	{:else if name === 'stop'}<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
	{:else if name === 'window'}<path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
	{:else if name === 'code'}<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
	{:else if name === 'folder'}<path
			d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
		/>
	{:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
	{:else if name === 'trash'}<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
	{:else if name === 'pencil'}<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" />
	{:else if name === 'agent'}<path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4L4.5 10.5 10.2 9Z" /><path
			d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"
		/>
	{:else if name === 'close'}<path d="m6 6 12 12M6 18 18 6" />
	{:else if name === 'chevron'}<path d="m9 6 6 6-6 6" />
	{:else if name === 'layers'}<path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 13 9 5 9-5" />
	{:else if name === 'check'}<path d="m5 12.5 4.5 4.5L19 7.5" />{/if}
</svg>
