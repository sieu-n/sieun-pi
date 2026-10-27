<script lang="ts">
  import type { Snippet } from "svelte";
  import AvatarStack from "./AvatarStack.svelte";
  import type { StackMember } from "./types";

  type Props = {
    /** Up to 3 small avatars shown before the text. */
    members?: StackMember[];
    text?: string;
    children?: Snippet;
  };
  let { members = [], text, children }: Props = $props();
</script>

<div class="system" role="note">
  {#if members.length}<AvatarStack {members} size={16} max={3} />{/if}
  <span>{#if children}{@render children()}{:else}{text}{/if}</span>
</div>

<style>
  .system {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 8px 0;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
    text-align: center;
  }
</style>
