<script lang="ts">
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import type { MenuEntry } from "./menu";
  import { toast, type ToastAction } from "./toast.svelte";

  let toaster = $state<HTMLDivElement>();
  /**
   * The toaster is a manual popover in the top layer, shown again for each new toast, so a toast lands above an open modal dialog instead
   * of under its backdrop.
   */
  $effect(() => {
    void toast.items.length;
    if (!toaster?.showPopover) return;
    if (toaster.matches(":popover-open")) toaster.hidePopover();
    toaster.showPopover();
  });

  /** The toast whose button menu is open, such as a reminder's Snooze, with the button it opens above. */
  let menu = $state<{ toast: number; label: string; items: MenuEntry[]; anchor: HTMLElement } | null>(null);
  let menuOpen = $state(false);

  function press(id: number, action: ToastAction, e: MouseEvent) {
    if ("menu" in action) {
      menu = { toast: id, label: action.label, items: action.menu(), anchor: e.currentTarget as HTMLElement };
      menuOpen = true;
      return;
    }
    action.run();
    toast.dismiss(id);
  }
</script>

<div bind:this={toaster} popover="manual" class="toaster" role="region" aria-label="Notifications" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div class="toast {t.tone}" role={t.tone === "danger" ? "alert" : "status"}>
      {#if t.tone === "success"}<Icon name="check" size={16} />{:else if t.tone === "danger"}<Icon name="warning" size={16} />{/if}
      <span class="text">{t.text}</span>
      {#each t.actions as action (action.label)}
        <button type="button" class="action" aria-haspopup={"menu" in action ? "menu" : undefined} onclick={(e) => press(t.id, action, e)}>{action.label}</button>
      {/each}
      <button type="button" class="close" aria-label="Dismiss" onclick={() => toast.dismiss(t.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>
{#if menu && menuOpen}
  {@const id = menu.toast}
  <Menu bind:open={menuOpen} anchor={menu.anchor} items={menu.items} placement="top-end" label={menu.label} onpick={() => toast.dismiss(id)} />
{/if}

<style>
  .toaster {
    position: fixed;
    inset: auto auto 24px 50%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    overflow: visible;
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
