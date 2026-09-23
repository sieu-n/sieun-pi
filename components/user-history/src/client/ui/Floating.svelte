<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { place, placementStyle, type Anchor, type Placement } from "./floating.ts";

  /**
   * A transient panel anchored to an element or a point, per the Virev menu recipe: fixed and top-layer so no overflow container clips it,
   * flips above when below is short, closes on an outside press, Escape or focus leaving, and gives focus back to its anchor.
   * It mounts inside an open modal dialog when there is one, because everything outside a modal dialog is inert.
   */
  let { anchor, width, maxHeight = 420, align = "start", role = "dialog", label, onclose, children }: {
    anchor: Anchor; width: number; maxHeight?: number; align?: "start" | "end"; role?: "dialog" | "menu" | "listbox" | "none"; label?: string | undefined;
    onclose: () => void; children: Snippet;
  } = $props();

  let panel: HTMLElement | undefined = $state();
  let placement = $state<Placement | null>(null);

  function position(): void { placement = place(anchor, { width, maxHeight, align }); }

  $effect(() => {
    const node = panel;
    if (!node) return;
    return untrack(() => mount(node));
  });

  function mount(node: HTMLElement): () => void {
    const host = (anchor instanceof HTMLElement ? anchor.closest("dialog[open]") : null) ?? document.querySelector("dialog[open]") ?? document.body;
    host.appendChild(node);
    node.showPopover();
    position();
    const target = node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), [tabindex='0']") ?? node;
    target.focus({ preventScroll: true });
    const inAnchor = (target: EventTarget | null) => anchor instanceof HTMLElement && target instanceof Node && anchor.contains(target);
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !node.contains(event.target) && !inAnchor(event.target)) onclose(); };
    const onFocus = (event: FocusEvent) => { if (event.target instanceof Node && !node.contains(event.target) && !inAnchor(event.target)) onclose(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onclose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus);
    node.addEventListener("keydown", onKey);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus);
      node.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", position);
      const hadFocus = !document.activeElement || document.activeElement === document.body || node.contains(document.activeElement);
      if (node.matches(":popover-open")) node.hidePopover();
      node.remove();
      if (hadFocus && anchor instanceof HTMLElement && anchor.isConnected) queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected) anchor.focus({ preventScroll: true }); });
    };
  }
</script>

<div bind:this={panel} class="floating panel-surface fade-in" popover="manual" role={role === "none" ? undefined : role} aria-label={label} tabindex="-1"
  style={placement ? placementStyle(placement) + `;max-height:${placement.maxHeight}px` : "opacity:0"}>
  {@render children()}
</div>

<style>
  .floating { position: fixed; inset: auto; margin: 0; padding: 4px; overflow: auto; overscroll-behavior: contain; font-size: 13px; }
  .floating:focus { outline: none; }
</style>
