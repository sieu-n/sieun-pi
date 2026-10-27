<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { anchorRect, nextLayer, place, portal, type Anchor, type Placement } from "./floating";

  type Props = {
    open: boolean;
    /** The element or viewport point the popover sits next to. */
    anchor: Anchor | null | undefined;
    placement?: Placement;
    gap?: number;
    /** glass is the blurred menu fill; solid is the opaque popover fill. */
    surface?: "glass" | "solid";
    width?: number | "anchor" | "auto";
    maxHeight?: number;
    padding?: number;
    radius?: "row" | "container";
    /** Called on Esc and on a pointer press outside both the popover and the anchor. */
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
    surface = "glass",
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
  let measured = $state(false);
  let returnFocus: HTMLElement | null = null;

  function close() {
    open = false;
    onclose?.();
  }

  function reposition() {
    if (!element || !anchor) return;
    const pos = place(anchorRect(anchor), element.getBoundingClientRect(), placement, gap);
    x = pos.x;
    y = pos.y;
    side = pos.side;
    measured = true;
  }

  $effect(() => {
    if (!open) {
      measured = false;
      return;
    }
    z = nextLayer();
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
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
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onResize = () => reposition();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      if (returnFocus?.isConnected && element?.contains(document.activeElement)) returnFocus.focus({ preventScroll: true });
    };
  });

  const widthStyle = $derived(
    width === "anchor" && anchor instanceof HTMLElement ? `${anchor.getBoundingClientRect().width}px` : typeof width === "number" ? `${width}px` : undefined,
  );
</script>

{#if open}
  <div
    use:portal
    bind:this={element}
    class="popover {surface} {className}"
    class:measured
    data-side={side}
    style:transform="translate({Math.round(x)}px, {Math.round(y)}px)"
    style:z-index={z}
    style:width={widthStyle}
    style:max-height="{maxHeight}px"
    style:padding="{padding}px"
    style:border-radius={radius === "row" ? "var(--radius-row)" : "var(--radius-container)"}
    {role}
    aria-label={label}
    tabindex="-1"
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
