<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    title: string;
    description?: string;
    icon?: string;
    /** Buttons under the text. */
    action?: Snippet;
    /** Art above the title, replacing the icon. */
    art?: Snippet;
    size?: "sm" | "md";
  };
  let { title, description, icon, action, art, size = "md" }: Props = $props();
</script>

<div class="empty {size}">
  {#if art}{@render art()}{:else if icon}<span class="icon-wrap"><Icon name={icon} size={size === "sm" ? 20 : 24} /></span>{/if}
  <p class="title">{title}</p>
  {#if description}<p class="desc">{description}</p>{/if}
  {#if action}<div class="actions">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 48px 24px;
    text-align: center;
  }
  .sm {
    padding: 24px 16px;
  }
  .icon-wrap {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: 8px;
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    color: var(--text-subtle);
  }
  .sm .icon-wrap {
    width: 36px;
    height: 36px;
  }
  .title {
    margin: 0;
    font: var(--text-label);
    color: var(--text-standard);
  }
  .sm .title {
    font: var(--text-label-sm);
  }
  .desc {
    margin: 0;
    max-width: 40ch;
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
</style>
