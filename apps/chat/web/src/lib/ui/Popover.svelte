<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { anchorRect, cssWidth, nextLayer, place, portal, type Anchor, type Placement } from "./floating";

  type Props = {
    open: boolean;
    /** The element or viewport point the popover sits next to. A point, such as a right-click's, gets no gap, so a context menu opens at the pointer. */
    anchor: Anchor | null | undefined;
    placement?: Placement;
    gap?: number;
    /** solid, the default, is the opaque card of menus, pickers and popovers, as in Slack; glass is a blurred see-through fill. */
    surface?: "glass" | "solid";
    width?: number | "anchor" | "auto";
    maxHeight?: number;
    padding?: number;
    radius?: "row" | "container";
    /** Called on Esc and on a pointer press outside the popover, its anchor and any popover opened above it, such as a submenu. */
    onclose?: () => void;
    /** Move focus into the popover when it opens. */
    autofocus?: boolean;
    role?: string;
    label?: string;
    class?: string;
    element?: HTMLDivElement | undefined;
    children: Snippet;
  };
  let {
    open = $bindable(),
    anchor,
    placement = "bottom-start",
    gap = 6,
    surface = "solid",
    width = "auto",
    maxHeight = 480,
    padding = 6,
    radius = "container",
    onclose,
    autofocus = true,
    role = "dialog",
    label,
    class: className = "",
    element = $bindable(),
    children,
  }: Props = $props();

  let x = $state(0);
  let y = $state(0);
  let z = $state(1000);
  let side = $state("bottom");
  let fit = $state(Infinity);
  let measured = $state(false);
  let returnFocus: HTMLElement | null = null;
  /**
   * A popover anchored inside a top-layer surface, such as a toast's Snooze menu, joins the top layer itself, so the surface and the toasts
   * stacked over it never cover it.
   */
  const topLayer = $derived(anchor instanceof HTMLElement && !!anchor.closest(":popover-open"));

  function close() {
    open = false;
    onclose?.();
  }

  function reposition() {
    if (!element || !anchor) return;
    const pos = place(anchorRect(anchor), element, placement, anchor instanceof HTMLElement ? gap : 0);
    x = pos.x;
    y = pos.y;
    side = pos.side;
    fit = pos.maxHeight;
    measured = true;
  }

  $effect(() => {
    if (!open) {
      measured = false;
      fit = Infinity;
      return;
    }
    z = nextLayer();
    // A click does not focus a button in WebKit, so the anchor stands in for a focus that sat on body.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    returnFocus = focused ?? (anchor instanceof HTMLElement ? anchor : null);
    void tick().then(() => {
      if (topLayer && element?.showPopover && !element.matches(":popover-open")) element.showPopover();
      reposition();
      if (autofocus && element && !element.contains(document.activeElement)) {
        const target = element.querySelector<HTMLElement>("[data-autofocus], input, [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], button");
        (target ?? element).focus({ preventScroll: true });
      }
    });
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (element?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      const above = t instanceof Element ? t.closest<HTMLElement>(".popover[data-layer]") : null;
      if (above && Number(above.dataset.layer) > z) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onResize = () => reposition();
    const sizes = new ResizeObserver(onResize);
    void tick().then(() => {
      if (element) sizes.observe(element);
      if (anchor instanceof HTMLElement) sizes.observe(anchor);
    });
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      sizes.disconnect();
      // By the time this runs the popover may be gone with the focus it held, which leaves focus on body.
      const lost = !document.activeElement || document.activeElement === document.body;
      if (returnFocus?.isConnected && (lost || element?.contains(document.activeElement))) returnFocus.focus({ preventScroll: true });
    };
  });

  const widthStyle = $derived(
    width === "anchor" && anchor instanceof HTMLElement ? `${cssWidth(anchor.getBoundingClientRect())}px` : typeof width === "number" ? `${width}px` : undefined,
  );
  const height = $derived(Math.min(maxHeight, fit));
</script>

{#if open}
  <div
    use:portal
    bind:this={element}
    class="popover {surface} {className}"
    class:measured
    data-side={side}
    data-layer={z}
    style:transform="translate({Math.round(x)}px, {Math.round(y)}px)"
    style:z-index={z}
    style:width={widthStyle}
    style:max-height="{height}px"
    style:--popover-available-height="{Math.max(0, height - 2 * padding)}px"
    style:padding="{padding}px"
    style:border-radius={radius === "row" ? "var(--radius-row)" : "var(--radius-container)"}
    {role}
    aria-label={label}
    tabindex="-1"
    popover={topLayer ? "manual" : undefined}
  >
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    top: 0;
    left: 0;
    min-width: 160px;
    overflow: auto;
    box-shadow: var(--shadow-float);
    color: var(--text-standard);
    opacity: 0;
  }
  .popover[popover] {
    inset: 0 auto auto 0;
    margin: 0;
    border: 0;
  }
  .popover.measured {
    opacity: 1;
    animation: enter var(--duration-medium) var(--ease-enter);
  }
  .glass {
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .solid {
    background: var(--surface-popover);
  }
  @keyframes enter {
    from {
      opacity: 0;
      scale: 0.97;
    }
  }
</style>
