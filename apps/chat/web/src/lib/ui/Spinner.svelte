<script lang="ts">
  type Props = { size?: number; label?: string };
  let { size = 16, label = "Loading" }: Props = $props();
</script>

<span class="spinner" style:width="{size}px" style:height="{size}px" role="status" aria-label={label}></span>

<style>
  .spinner {
    display: inline-block;
    flex: none;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    opacity: 0.7;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
