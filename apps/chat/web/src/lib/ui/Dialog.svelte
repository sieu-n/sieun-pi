<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import IconButton from "./IconButton.svelte";
  import { nextLayer, portal } from "./floating";
  import { trapFocus } from "./keyboard";

  type Props = {
    open: boolean;
    title?: string;
    /** Plain-text description under the title. */
    description?: string;
    /** Accessible name when there is no visible title. */
    label?: string;
    /** center: a 28 px radius card in the middle. search: a 640 px palette anchored 128 px from the top. */
    presentation?: "center" | "search";
    width?: number;
    /** Esc and an outside click close the dialog. With `dirty`, an outside click is ignored so typed input is never lost. */
    dismissible?: boolean;
    dirty?: boolean;
    /** CSS selector of the element to focus first. Defaults to [data-autofocus], then the first field or button. */
    initialFocus?: string;
    showClose?: boolean;
    onclose?: () => void;
    /** Footer buttons, right aligned. */
    actions?: Snippet;
    children: Snippet;
  };
  let {
    open = $bindable(),
    title,
    description,
    label,
    presentation = "center",
    width,
    dismissible = true,
    dirty = false,
    initialFocus,
    showClose = true,
    onclose,
    actions,
    children,
  }: Props = $props();

  let card = $state<HTMLDivElement>();
  let z = $state(2000);
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;

  function close() {
    open = false;
    onclose?.();
  }

  $effect(() => {
    if (!open) return;
    z = nextLayer() + 1000;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (!card) return;
      const target =
        (initialFocus ? card.querySelector<HTMLElement>(initialFocus) : null) ??
        card.querySelector<HTMLElement>("[data-autofocus]") ??
        card.querySelector<HTMLElement>("input, textarea, select, [contenteditable=true]") ??
        card.querySelector<HTMLElement>(".dialog-body button, .dialog-actions button");
      (target ?? card).focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  });

  function onScrimPointer(e: PointerEvent) {
    if (e.target === e.currentTarget && dismissible && !dirty) close();
  }
</script>

{#if open}
  <div use:portal class="scrim {presentation}" style:z-index={z} onpointerdown={onScrimPointer} role="presentation">
    <div
      bind:this={card}
      use:trapFocus
      class="dialog {presentation}"
      style:width={width ? `${width}px` : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : label}
      tabindex="-1"
    >
      {#if title}
        <header class="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {#if description}<p>{description}</p>{/if}
          </div>
          {#if showClose && dismissible}<IconButton icon="close" label="Close" size="sm" onclick={close} />{/if}
        </header>
      {/if}
      <div class="dialog-body">{@render children()}</div>
      {#if actions}<footer class="dialog-actions">{@render actions()}</footer>{/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 24px;
    background: var(--bg-scrim);
    animation: fade var(--duration-base) var(--ease-standard);
  }
  .scrim.search {
    align-items: flex-start;
    padding-top: 128px;
  }
  .dialog {
    display: flex;
    flex-direction: column;
    width: 480px;
    max-width: 100%;
    max-height: calc(100vh - 48px);
    border-radius: var(--radius-panel);
    background: var(--surface-popover);
    box-shadow: var(--shadow-float);
    color: var(--text-standard);
    overflow: hidden;
    animation: pop var(--duration-medium) var(--ease-enter);
  }
  .dialog.search {
    width: 640px;
    max-height: calc(100vh - 128px - 48px);
    padding: 0 12px;
    border-radius: 32px;
    box-shadow: var(--shadow-sm);
  }
  .dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 24px 24px 8px;
  }
  .dialog-header h2 {
    margin: 0;
    font: var(--text-heading);
    letter-spacing: var(--tracking-heading);
  }
  .dialog-header p {
    margin: 8px 0 0;
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .dialog-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .center .dialog-body {
    padding: 8px 24px 16px;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 24px 24px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.98) translateY(4px);
    }
  }
</style>
