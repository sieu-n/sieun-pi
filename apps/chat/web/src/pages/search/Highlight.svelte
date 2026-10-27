<script lang="ts">
  import type { Piece } from "./match";

  let { pieces }: { pieces: Piece[] } = $props();
</script>

{#each pieces as piece, index (index)}{#if piece.mark}<mark class="match">{piece.text}</mark>{:else}{piece.text}{/if}{/each}

<style>
  .match {
    background: none;
    color: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
</style>
