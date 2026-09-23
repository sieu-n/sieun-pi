<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { labels } from "./labels.ts";
  import { PRIORITY_LABEL, PROGRESS_LABEL } from "./organize.ts";
  import { PROGRESS_STEPS, type Priority } from "../shared/types.ts";
  import type { Anchor } from "./ui/floating.ts";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";

  /** Thread options: rename, priority, progress, tags and archive. Opened from the row menu button, a right click, or Shift+F10. */
  let { ids, at, onclose, onrename, onarchive }: { ids: string[]; at: Anchor; onclose: () => void; onrename?: () => void; onarchive?: () => void } = $props();

  const LEVELS: readonly Priority[] = [0, 1, 2, 3];
  const rows = $derived(store.sessions.filter(row => ids.includes(row.id)));
  const priority = $derived(rows.length && rows.every(row => row.priority === rows[0]!.priority) ? rows[0]!.priority : null);
  const progress = $derived(rows.length && rows.every(row => row.progress === rows[0]!.progress) ? rows[0]!.progress : null);
  const running = $derived(rows.some(row => row.status === "running"));

  function onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const group = (event.target as HTMLElement).closest(".levels");
      const buttons = group ? [...group.querySelectorAll<HTMLElement>(".level")] : [];
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }
</script>

<Floating anchor={at} width={260} maxHeight={480} label={ids.length > 1 ? `Labels for ${ids.length} threads` : "Thread options"} {onclose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onkeydown={onKey}>
    {#if onrename && ids.length === 1}
      <button type="button" class="menu-item" data-autofocus onclick={() => { onclose(); onrename(); }}><Icon name="pencil" size={14} />Rename</button>
    {/if}
    {#if onarchive}
      <button type="button" class="menu-item" class:danger={running} onclick={onarchive}><Icon name="archive" size={14} />{running ? "Stop and archive" : "Archive"}</button>
    {/if}
    {#if onrename || onarchive}<div class="menu-separator"></div>{/if}
    <div class="menu-heading" id="priority-heading">Priority</div>
    <div class="levels" role="radiogroup" aria-labelledby="priority-heading">
      {#each LEVELS as level (level)}
        <button type="button" class="level" class:on={priority === level} role="radio" aria-checked={priority === level} aria-label={PRIORITY_LABEL[level]}
          tabindex={priority === level || (priority === null && level === 0) ? 0 : -1} data-autofocus={!onrename && (priority === level || (priority === null && level === 0)) ? true : undefined}
          onclick={() => void labels.setPriority(ids, level)}>
          {#if level === 0}<span class="none">None</span>{:else}<PriorityBars {level} size={13} />{/if}
        </button>
      {/each}
    </div>
    <div class="menu-heading" id="progress-heading">Progress</div>
    <div class="levels flex" role="radiogroup" aria-labelledby="progress-heading">
      {#each PROGRESS_STEPS as step (step)}
        <button type="button" class="level" class:on={progress === step} role="radio" aria-checked={progress === step} aria-label={PROGRESS_LABEL[step]}
          tabindex={progress === step || (progress === null && step === "none") ? 0 : -1} onclick={() => void labels.setProgress(ids, step)}>
          <span class="none">{step === "none" ? "None" : PROGRESS_LABEL[step]}</span>
        </button>
      {/each}
    </div>
    <div class="menu-separator"></div>
    <div class="menu-heading">Tags</div>
    <TagPicker {ids} autofocus={false} />
  </div>
</Floating>

<style>
  .levels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin: 2px 2px 4px; padding: 2px; border-radius: 8px; background: var(--bg-sunken); }
  .levels.flex { display: flex; }
  .levels.flex .level { flex: 1 1 auto; padding: 0 6px; }
  .level { display: inline-flex; align-items: center; justify-content: center; height: 26px; border-radius: var(--radius-small); transition: background-color 0.12s; }
  .level:hover:not(.on) { background: var(--bg-hover); }
  .level.on { background: var(--accent-soft); }
  .none { font-size: 12px; color: var(--text-muted); }
  .level.on .none { color: var(--accent-bold); font-weight: 600; }
</style>
