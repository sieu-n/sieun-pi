<script lang="ts">
  type Props = {
    /** working: staggered fade loop. waiting: the three dots breathe together. */
    mode?: "working" | "waiting";
    label?: string;
    size?: number;
  };
  let { mode = "working", label, size = 4 }: Props = $props();
</script>

<span class="dots {mode}" style:--d="{size}px" role={label ? "status" : undefined} aria-label={label}>
  <i></i><i></i><i></i>
</span>

<style>
  .dots {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--d) * 0.75);
    height: 16px;
    color: currentColor;
  }
  i {
    width: var(--d);
    height: var(--d);
    border-radius: 50%;
    background: currentColor;
  }
  .working i {
    animation: fade 1.4s ease-in-out infinite;
  }
  .working i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .working i:nth-child(3) {
    animation-delay: 0.4s;
  }
  .waiting i {
    animation: breathe 2.4s ease-in-out infinite;
  }
  @keyframes fade {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 0.9;
    }
  }
</style>
