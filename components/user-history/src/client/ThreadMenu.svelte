<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { labels, threadTags } from "./labels.ts";
  import type { Anchor } from "./ui/floating.ts";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import Icon from "./Icon.svelte";
  import PriorityPicker from "./PriorityPicker.svelte";
  import ProgressPicker from "./ProgressPicker.svelte";

  /** Thread options: rename, priority, progress, tags and archive. Opened from the row menu button, a right click, or Shift+F10. */
  let { ids, at, onclose, onrename, onarchive }: { ids: string[]; at: Anchor; onclose: () => void; onrename?: () => void; onarchive?: () => void } = $props();

  const rows = $derived(store.sessions.filter(row => ids.includes(row.id)));
  const priority = $derived(rows.length && rows.every(row => row.priority === rows[0]!.priority) ? rows[0]!.priority : null);
  const progress = $derived(rows.length && rows.every(row => row.progress === rows[0]!.progress) ? rows[0]!.progress : null);
  const running = $derived(rows.some(row => row.working));
</script>

<Floating anchor={at} width={260} maxHeight={480} label={ids.length > 1 ? `Labels for ${ids.length} threads` : "Thread options"} {onclose}>
  {#if onrename && ids.length === 1}
    <button type="button" class="menu-item" data-autofocus onclick={() => { onclose(); onrename(); }}><Icon name="pencil" size={14} />Rename</button>
  {/if}
  {#if onarchive}
    <button type="button" class="menu-item" class:danger={running} onclick={onarchive}><Icon name="archive" size={14} />{running ? "Stop and archive" : "Archive"}</button>
  {/if}
  {#if onrename || onarchive}<div class="menu-separator"></div>{/if}
  <div class="menu-heading">Priority</div>
  <PriorityPicker value={priority} autofocus={!onrename} onchange={level => void labels.setPriority(ids, level)} />
  <div class="menu-heading">Progress</div>
  <ProgressPicker value={progress} onchange={step => void labels.setProgress(ids, step)} />
  <div class="menu-separator"></div>
  <div class="menu-heading">Tags</div>
  <TagPicker selection={threadTags(ids)} autofocus={false} />
</Floating>
