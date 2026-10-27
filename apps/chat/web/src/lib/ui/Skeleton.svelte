<script lang="ts">
  type Props = { width?: string; height?: string; radius?: string; lines?: number };
  let { width = "100%", height = "14px", radius = "8px", lines = 1 }: Props = $props();
</script>

<span class="skeleton-group" aria-hidden="true">
  {#each Array.from({ length: lines }) as _, i (i)}
    <span class="skeleton" style:width={lines > 1 && i === lines - 1 ? "60%" : width} style:height style:border-radius={radius}></span>
  {/each}
</span>

<style>
  .skeleton-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .skeleton {
    display: block;
    background: linear-gradient(90deg, var(--surface-inset) 0%, var(--affordance-subtle) 50%, var(--surface-inset) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.6s ease-in-out infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: -100% 0;
    }
  }
</style>
