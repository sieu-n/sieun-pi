<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import IconButton from "./IconButton.svelte";
  import { portal } from "./floating";

  type Props = {
    open: boolean;
    title?: string;
    /** Plain-text description under the title. */
    description?: string;
    /** Accessible name when there is no visible title. */
    label?: string;
    /** center: a 28 px radius card in the middle. search: a 640 px palette anchored 128 px from the top. sheet: a reader as tall as the window, up to 1200 px wide, with an unpadded body. */
    presentation?: "center" | "search" | "sheet";
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
    /** Header buttons, drawn before the close button. */
    headerActions?: Snippet;
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
    headerActions,
    children,
  }: Props = $props();

  let card = $state<HTMLDialogElement>();
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;

  function close() {
    open = false;
    onclose?.();
  }

  /**
   * Opens the dialog in the top layer, where the browser makes the page behind it inert, so Tab stays inside it. showModal moves focus
   * into the dialog, so the element to give it back to is read before it.
   */
  function modal(node: HTMLDialogElement) {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    return {
      destroy() {
        node.close();
        if (returnTo?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) returnTo.focus({ preventScroll: true });
      },
    };
  }

  $effect(() => {
    if (!open) return;
    void tick().then(() => {
      if (!card) return;
      const target =
        (initialFocus ? card.querySelector<HTMLElement>(initialFocus) : null) ??
        card.querySelector<HTMLElement>("[data-autofocus]") ??
        card.querySelector<HTMLElement>("input, textarea, select, [contenteditable=true]") ??
        card.querySelector<HTMLElement>(".dialog-body button, .dialog-actions button");
      (target ?? card).focus({ preventScroll: true });
    });
  });

  /** Esc fires cancel; a menu or picker inside the dialog takes its own Esc first and prevents it. */
  function onCancel(e: Event) {
    e.preventDefault();
    if (dismissible) close();
  }

  /** The browser can close a modal without a cancel it lets us prevent, such as a second Esc in Safari, so the state follows it. */
  function onNativeClose() {
    if (open && card?.isConnected) close();
  }

  /** A press and a release both on the backdrop close the dialog, so a text selection dragged out of it does not. */
  let pressedOutside = false;
  const outside = (e: PointerEvent): boolean => {
    const r = card!.getBoundingClientRect();
    return e.target === card && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  function onPointerDown(e: PointerEvent) {
    pressedOutside = outside(e);
  }
  function onPointerUp(e: PointerEvent) {
    if (pressedOutside && outside(e) && dismissible && !dirty) close();
    pressedOutside = false;
  }
</script>

{#if open}
  <dialog
    bind:this={card}
    use:portal
    use:modal
    class="dialog {presentation}"
    style:width={width ? `${width}px` : undefined}
    aria-labelledby={title ? titleId : undefined}
    aria-label={title ? undefined : label}
    tabindex="-1"
    oncancel={onCancel}
    onclose={onNativeClose}
    onpointerdown={onPointerDown}
    onpointerup={onPointerUp}
  >
    {#if title}
      <header class="dialog-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {#if description}<p>{description}</p>{/if}
        </div>
        {#if headerActions || (showClose && dismissible)}
          <div class="dialog-header-actions">
            {#if headerActions}{@render headerActions()}{/if}
            {#if showClose && dismissible}<IconButton icon="close" label="Close" size="sm" onclick={close} />{/if}
          </div>
        {/if}
      </header>
    {/if}
    <div class="dialog-body">{@render children()}</div>
    {#if actions}<footer class="dialog-actions">{@render actions()}</footer>{/if}
  </dialog>
{/if}

<style>
  .dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .dialog {
    width: 480px;
    max-width: calc(100% - 48px);
    max-height: calc(100vh - 48px);
    margin: auto;
    padding: 0;
    border: none;
    border-radius: var(--radius-panel);
    background: var(--surface-popover);
    box-shadow: var(--shadow-float);
    color: var(--text-standard);
    overflow: hidden;
    overscroll-behavior: contain;
    animation: pop var(--duration-medium) var(--ease-enter);
  }
  .dialog::backdrop {
    overflow: hidden;
    overscroll-behavior: contain;
    background: var(--bg-scrim);
    animation: fade var(--duration-base) var(--ease-standard);
  }
  .dialog.search {
    width: 640px;
    margin-top: 128px;
    max-height: calc(100vh - 128px - 48px);
    padding: 0 12px;
    border-radius: var(--radius-control);
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
    font: var(--text-label);
  }
  .dialog-header p {
    margin: 4px 0 0;
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
  .dialog-header-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }
  .dialog.sheet {
    width: 1200px;
    height: calc(100vh - 48px);
  }
  .sheet .dialog-header {
    align-items: center;
    padding: 10px 12px 10px 20px;
    border-bottom: 1px solid var(--border-standard);
  }
  .sheet .dialog-header > div:first-child {
    min-width: 0;
  }
  .sheet .dialog-header h2 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet .dialog-header p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet .dialog-body {
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
