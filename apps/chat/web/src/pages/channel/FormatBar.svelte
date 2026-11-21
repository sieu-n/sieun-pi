<script lang="ts">
  import IconButton from "$lib/ui/IconButton.svelte";
  import { FORMAT_GROUPS, shortcutLabel, type Format } from "./composer-format";

  /**
   * Slack's formatting bar over the composer's box: bold, italic, strikethrough, link, lists, quote, code and code block, each with its key in
   * the tooltip. A press keeps the focus and selection in the box. One Tab stop, with the arrow keys moving along the bar (a toolbar).
   */
  type Props = { active: ReadonlySet<Format>; onformat: (format: Format) => void };
  let { active, onformat }: Props = $props();

  let bar = $state<HTMLDivElement>();
  let current = $state<Format>("bold");
  const order = FORMAT_GROUPS.flat().map((s) => s.format);

  function onkeydown(e: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const index = order.indexOf(current);
    const next = step ? order[(index + step + order.length) % order.length] : e.key === "Home" ? order[0] : e.key === "End" ? order.at(-1) : undefined;
    if (!next) return;
    e.preventDefault();
    current = next;
    bar?.querySelector<HTMLButtonElement>(`[data-format="${next}"]`)?.focus();
  }
</script>

<div bind:this={bar} class="format-bar" role="toolbar" aria-label="Formatting" tabindex="-1" data-testid="format-bar" {onkeydown}>
  {#each FORMAT_GROUPS as group, g (g)}
    {#if g}<span class="separator" role="separator" aria-orientation="vertical"></span>{/if}
    {#each group as spec (spec.format)}
      <IconButton
        icon={spec.icon}
        label={spec.label}
        shortcut={shortcutLabel(spec.keys)}
        size="sm"
        pressed={spec.format === "link" ? undefined : active.has(spec.format)}
        tabindex={spec.format === current ? 0 : -1}
        data-format={spec.format}
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onfocus={() => (current = spec.format)}
        onclick={() => onformat(spec.format)}
      />
    {/each}
  {/each}
</div>

<style>
  .format-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    color: var(--text-metadata);
    outline: none;
  }
  .separator {
    height: 16px;
    margin: 0 4px;
    border-left: 1px solid var(--border-standard);
  }
</style>
