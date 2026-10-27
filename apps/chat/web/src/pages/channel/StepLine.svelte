<script lang="ts">
  import type { Step } from "$lib/api";
  import Icon from "$lib/ui/Icon.svelte";
  import Spinner from "$lib/ui/Spinner.svelte";
  import { stepsSummary } from "./present";

  type Props = { steps: Step[]; live?: boolean; liveLabel?: string | null; onjob?: (job: string) => void };
  let { steps, live = false, liveLabel = null, onjob }: Props = $props();

  let open = $state(false);
  let shownOutput = $state<Record<string, boolean>>({});
  const summary = $derived(live && liveLabel ? liveLabel : stepsSummary(steps));
</script>

<div class="steps" data-steps>
  <button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
    {#if live}<Spinner size={12} />{:else}<span class="chev" class:open><Icon name="chevron-right" size={12} /></span>{/if}
    <span class="summary" class:live>{summary}</span>
    {#if steps.length}<span class="count">· {steps.length} {steps.length === 1 ? "step" : "steps"}</span>{/if}
  </button>
  {#if open}
    <ol class="list">
      {#each steps as step, index (index)}
        {#if step.kind === "thinking"}
          <li class="thinking">{step.text}</li>
        {:else}
          <li class="tool" data-status={step.status}>
            <div class="head">
              <span class="mark">
                {#if step.status === "running"}<Spinner size={12} />{:else if step.status === "error"}<Icon name="warning" size={13} />{:else}<Icon name="check" size={13} />{/if}
              </span>
              <span class="name">{step.name}</span>
              {#if step.job && onjob}
                <button type="button" class="summary-text link" onclick={() => onjob?.(step.job!)}>{step.summary}</button>
              {:else}
                <span class="summary-text">{step.summary}</span>
              {/if}
              {#if step.output}
                <button type="button" class="more" aria-expanded={!!shownOutput[step.id]} onclick={() => (shownOutput[step.id] = !shownOutput[step.id])}>{shownOutput[step.id] ? "Hide" : "Output"}</button>
              {/if}
            </div>
            {#if step.output && shownOutput[step.id]}<pre class="output">{step.output}</pre>{/if}
          </li>
        {/if}
      {/each}
    </ol>
  {/if}
</div>

<style>
  .steps {
    margin: 0 0 6px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px 2px 4px;
    margin-left: -4px;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .toggle:hover {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary.live {
    flex-shrink: 0;
  }
  .count {
    flex: none;
    color: var(--text-metadata);
  }
  .chev {
    display: inline-flex;
    transition: transform var(--duration-fast) var(--ease-standard);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0 2px;
    padding: 8px 10px;
    list-style: none;
    border-radius: 12px;
    background: var(--surface-panel);
  }
  .thinking {
    font-style: italic;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .mark {
    display: inline-flex;
    flex: none;
    align-self: center;
  }
  .tool[data-status="error"] .mark {
    color: var(--border-danger);
  }
  .name {
    flex: none;
    font-weight: 500;
    color: var(--text-standard);
  }
  .summary-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-message-link);
    text-align: left;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .more {
    flex: none;
    margin-left: auto;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-metadata);
    font: inherit;
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-standard);
  }
  .output {
    max-height: 240px;
    margin: 4px 0 2px 19px;
    padding: 6px 8px;
    overflow: auto;
    border-radius: 8px;
    background: var(--surface-inset);
    font: 11.5px/1.5 var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
