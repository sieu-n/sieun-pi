<script lang="ts">
  import { pictureSvg } from "./agent-picture";
  import { pictureStyle } from "./picture-style.svelte";

  type Props = {
    /** The agent id or name; the same seed and name always draw the same picture. */
    seed: string;
    /** The display name, which the Letters and Symbol styles read; defaults to the seed. */
    name?: string;
    size?: number;
    label?: string;
    class?: string;
  };
  let { seed, name, size = 64, label, class: className = "" }: Props = $props();
  const svg = $derived(pictureSvg(pictureStyle.value, seed, name ?? seed));
</script>

<span class="picture {className}" style:width="{size}px" style:height="{size}px" role={label ? "img" : undefined} aria-label={label}>
  {@html svg}
</span>

<style>
  .picture {
    display: inline-block;
    flex: none;
    line-height: 0;
  }
  .picture :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
