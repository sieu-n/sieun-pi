<script lang="ts">
  import { encode } from "uqr";

  /** A QR code drawn as one SVG path, so the page's CSP (no inline styles) still applies. */
  let { text, size = 184, label }: { text: string; size?: number; label: string } = $props();
  const code = $derived(encode(text, { ecc: "M", border: 2 }));
  const path = $derived.by(() => {
    let d = "";
    code.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return d;
  });
</script>

<svg class="qr" width={size} height={size} viewBox="0 0 {code.size} {code.size}" role="img" aria-label={label} shape-rendering="crispEdges">
  <rect width={code.size} height={code.size} fill="#fff" />
  <path d={path} fill="#000" />
</svg>

<style>
  .qr { display: block; border-radius: 6px; }
</style>
