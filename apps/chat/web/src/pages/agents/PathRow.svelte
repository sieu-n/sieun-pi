<script lang="ts">
  import { stampLabel } from "$lib/ui";
  import CopyPath from "./CopyPath.svelte";
  import { compactPath } from "./knowledge";

  /** One file the agent can use, a skill or a script: its name, one line on what it is, and its path to copy, each on one line. */
  let { name, detail, path, changedAt = null }: { name: string; detail: string; path: string; changedAt?: number | null } = $props();
</script>

<li class="path-row" data-path={path}>
  <div class="line">
    <span class="t-label-sm name">{name}</span>
    <span class="t-caption detail" title={detail}>{detail}</span>
  </div>
  <div class="line">
    <CopyPath value={path} label="path of {name}" shown={compactPath(path)} />
    {#if changedAt}<span class="t-caption changed">changed {stampLabel(changedAt)}</span>{/if}
  </div>
</li>

<style>
  .path-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-standard);
  }
  .path-row:last-child {
    border-bottom: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    white-space: nowrap;
  }
  .name {
    flex: none;
    color: var(--text-standard);
  }
  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-subtle);
  }
  .line :global(.path) {
    min-width: 0;
  }
  .line :global(.path code) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-metadata);
  }
  .changed {
    flex: none;
    margin-left: auto;
    color: var(--text-metadata);
  }
</style>
