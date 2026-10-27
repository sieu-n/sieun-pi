<script lang="ts">
  type Props = {
    /** Current size in px of the pane this handle resizes. */
    size: number;
    min: number;
    max: number;
    /** start: the pane sits left of the handle and grows when dragged right. end: the pane sits right and grows when dragged left. */
    edge?: "start" | "end";
    label: string;
    onresize: (px: number) => void;
    /** Called once when a drag ends, to save the size. */
    oncommit?: (px: number) => void;
    ondoubleclick?: () => void;
  };
  let { size, min, max, edge = "start", label, onresize, oncommit, ondoubleclick }: Props = $props();
  let dragging = $state(false);

  function clamp(px: number) {
    return Math.min(max, Math.max(min, px));
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startSize = size;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    let last = startSize;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      last = clamp(edge === "start" ? startSize + dx : startSize - dx);
      onresize(last);
    };
    const up = () => {
      dragging = false;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      oncommit?.(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function onKeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 10;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = clamp(size + (edge === "start" ? -step : step));
    else if (e.key === "ArrowRight") next = clamp(size + (edge === "start" ? step : -step));
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onresize(next);
    oncommit?.(next);
  }
</script>

<!-- A focusable separator is an ARIA widget that takes arrow keys. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="handle {edge}"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={Math.round(size)}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  onpointerdown={onPointerDown}
  onkeydown={onKeydown}
  ondblclick={ondoubleclick}
></div>

<style>
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 5;
    width: 14px;
    cursor: col-resize;
    touch-action: none;
  }
  .start {
    right: -11px;
  }
  .end {
    left: -11px;
  }
  .handle::after {
    content: "";
    position: absolute;
    top: 24px;
    bottom: 24px;
    left: 6px;
    width: 2px;
    border-radius: 2px;
    background: transparent;
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .handle:hover::after,
  .dragging::after,
  .handle:focus-visible::after {
    background: var(--border-prominent);
  }
  :global(body:has(.handle.dragging)) {
    cursor: col-resize;
    user-select: none;
  }
</style>
