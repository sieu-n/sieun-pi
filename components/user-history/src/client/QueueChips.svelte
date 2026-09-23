<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { QueueState } from "../shared/types.ts";
  import Icon from "./Icon.svelte";

  type Lane = keyof QueueState;
  let { threadId, queue }: { threadId: string; queue: QueueState } = $props();
  let editing = $state<{ lane: Lane; index: number; text: string } | null>(null);
  const LANES: readonly { lane: Lane; label: string }[] = [{ lane: "steering", label: "Steer" }, { lane: "followUp", label: "Next" }];

  async function remove(lane: Lane, index: number, expectedText: string): Promise<void> {
    await store.run(api.queue(threadId, { lane, index, expectedText }));
  }
  async function save(): Promise<void> {
    const current = editing;
    editing = null;
    if (!current) return;
    const expectedText = queue[current.lane][current.index];
    const text = current.text.trim();
    if (expectedText === undefined || !text || text === expectedText) return;
    await store.run(api.queue(threadId, { lane: current.lane, index: current.index, expectedText, text }));
  }
  function onEditKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); void save(); }
    else if (event.key === "Escape") { event.stopPropagation(); editing = null; }
  }
  function focusAndSelect(node: HTMLInputElement): void { node.focus(); node.select(); }
</script>

{#if queue.steering.length || queue.followUp.length}
  <div class="queue" aria-label="Queued messages">
    {#each LANES as { lane, label } (lane)}
      {#each queue[lane] as text, index (lane + ":" + index)}
        <div class="queued fade-in" class:steer={lane === "steering"}>
          <span class="lane">{label}</span>
          {#if editing?.lane === lane && editing.index === index}
            <input class="field edit" bind:value={editing.text} aria-label="Edit queued message" use:focusAndSelect onkeydown={onEditKey} onblur={() => void save()} />
          {:else}
            <span class="text">{text}</span>
            <button type="button" class="icon-button small" aria-label="Edit queued message" onclick={() => { editing = { lane, index, text }; }}><Icon name="pencil" size={13} /></button>
            <button type="button" class="icon-button small" aria-label="Remove queued message" onclick={() => void remove(lane, index, text)}><Icon name="x" size={13} /></button>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .queue { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .queued { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-radius: 999px; border: 1px dashed var(--border-strong); background: var(--bg-elevated); font-size: 13px; }
  .queued.steer { border-color: var(--accent); }
  .lane { font-size: 11.5px; font-weight: 600; color: var(--text-muted); flex: none; }
  .steer .lane { color: var(--accent); }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edit { flex: 1; padding: 2px 8px; font-size: 13px; border-radius: 999px; }
</style>
