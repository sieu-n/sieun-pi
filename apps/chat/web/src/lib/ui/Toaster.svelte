<script lang="ts">
  import Icon from "./Icon.svelte";
  import { toast } from "./toast.svelte";
</script>

<div class="toaster" role="region" aria-label="Notifications" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div class="toast {t.tone}" role={t.tone === "danger" ? "alert" : "status"}>
      {#if t.tone === "success"}<Icon name="check" size={16} />{:else if t.tone === "danger"}<Icon name="warning" size={16} />{/if}
      <span class="text">{t.text}</span>
      {#if t.action}
        {@const action = t.action}
        <button
          type="button"
          class="action"
          onclick={() => {
            action.run();
            toast.dismiss(t.id);
          }}>{action.label}</button
        >
      {/if}
      <button type="button" class="close" aria-label="Dismiss" onclick={() => toast.dismiss(t.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 50000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    max-width: min(520px, calc(100vw - 32px));
    padding: 8px 8px 8px 16px;
    border-radius: var(--radius-pill);
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
    box-shadow: var(--shadow-float);
    font: var(--text-body-sm);
    pointer-events: auto;
    animation: rise var(--duration-slow) var(--ease-enter);
  }
  .success :global(.icon) {
    color: var(--accent-9);
  }
  .danger :global(.icon) {
    color: var(--border-danger);
  }
  .text {
    flex: 1;
  }
  .action {
    border: 0;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--text-on-prominent) 16%, transparent);
    font: var(--text-label-sm);
  }
  .close {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    opacity: 0.7;
  }
  .close:hover {
    opacity: 1;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
