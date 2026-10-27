<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    /** own is the soft accent bubble for the owner's messages; received is the neutral one. */
    own?: boolean;
    /** Tighter corner on the avatar side for a grouped stack: first, middle, last or single. */
    position?: "single" | "first" | "middle" | "last";
    /** Reactions or attachments drawn inside the bubble at its bottom edge. */
    footer?: Snippet;
    highlighted?: boolean;
    class?: string;
    children: Snippet;
    [key: string]: unknown;
  };
  let { own = false, position = "single", footer, highlighted = false, class: className = "", children, ...rest }: Props = $props();
</script>

<div class="bubble {position} {className}" class:own class:highlighted data-own={own || undefined} {...rest}>
  <div class="content t-message">{@render children()}</div>
  {#if footer}<div class="footer">{@render footer()}</div>{/if}
</div>

<style>
  .bubble {
    --bubble-radius: 21px;
    display: inline-flex;
    flex-direction: column;
    max-width: min(100%, calc(60ch + 32px));
    min-width: 0;
    padding: 8px 16px;
    border-radius: var(--bubble-radius);
    background: var(--surface-message);
    color: var(--text-standard);
    overflow-wrap: anywhere;
    transition: box-shadow var(--duration-slow) var(--ease-standard);
  }
  .own {
    background: var(--surface-message-own);
    color: var(--text-message-own);
  }
  .content :global(a) {
    color: var(--text-message-link);
  }
  .own .content :global(a) {
    color: var(--text-message-link-own);
  }
  .content :global(p) {
    margin: 0;
  }
  .content :global(p + p) {
    margin-top: 8px;
  }
  .footer {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 6px -8px -2px;
  }
  .highlighted {
    box-shadow: 0 0 0 2px var(--affordance-accent-prominent);
  }
</style>
