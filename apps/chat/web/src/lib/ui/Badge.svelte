<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    /** A number shows as a count, capped at "99+". */
    value?: number | string | null;
    /** warning and success are for states, such as an account in cooldown or a reset ready to use. */
    tone?: "neutral" | "accent" | "danger" | "strong" | "outline" | "warning" | "success";
    /** A bare 8 px dot instead of a count. */
    dot?: boolean;
    children?: Snippet;
    title?: string;
  };
  let { value, tone = "neutral", dot = false, children, title }: Props = $props();
  const text = $derived(typeof value === "number" ? (value > 99 ? "99+" : String(value)) : (value ?? ""));
</script>

{#if dot}
  <span class="dot {tone}" {title} aria-label={title}></span>
{:else}
  <span class="badge {tone}" {title}>{#if children}{@render children()}{:else}{text}{/if}</span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: var(--radius-pill);
    font: 500 11px/1 var(--font-sans);
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .neutral {
    background: var(--affordance-subtle);
    color: var(--text-standard);
  }
  .accent {
    background: var(--affordance-accent-prominent);
    color: var(--text-on-accent);
  }
  .danger {
    background: var(--border-danger);
    color: #fff;
  }
  .warning {
    background: var(--status-away);
    color: #000;
  }
  .success {
    background: var(--status-online);
    color: #fff;
  }
  .strong {
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
  }
  .outline {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border-standard);
    color: var(--text-subtle);
  }
  .dot {
    display: inline-block;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot.neutral {
    background: var(--text-standard);
  }
</style>
