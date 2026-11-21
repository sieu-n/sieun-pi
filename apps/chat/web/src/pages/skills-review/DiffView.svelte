<script lang="ts">
  import type { DiffLine } from "./model";

  /** A unified diff, one row per line, with added and removed lines in the theme's colors. */
  let { lines, label }: { lines: DiffLine[]; label: string } = $props();
</script>

<pre class="diff" title={label} data-testid="review-diff">{#each lines as line, i (i)}<span class="line {line.kind}">{line.text || " "}</span>{/each}</pre>

<style>
  .diff {
    margin: 0;
    max-height: 28rem;
    overflow: auto;
    padding: 8px 0;
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    color: var(--text-standard);
    font: var(--text-mono);
    letter-spacing: var(--tracking-mono);
  }
  .line {
    display: block;
    min-width: max-content;
    padding: 0 12px;
    white-space: pre;
  }
  .add {
    background: var(--accent-4);
    color: var(--accent-12);
  }
  .del {
    background: var(--surface-danger);
    color: var(--text-danger);
  }
  .hunk {
    color: var(--text-subtle);
    background: var(--affordance-subtle);
  }
  .meta {
    color: var(--text-metadata);
  }
</style>
