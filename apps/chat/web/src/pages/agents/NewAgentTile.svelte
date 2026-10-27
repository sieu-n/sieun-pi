<script lang="ts">
  import { Mascot } from "$lib/ui";

  type Props = {
    label: string;
    /** A quieter label, for a tile beside a more important one. */
    secondary?: boolean;
    /** Seeds for the mascots scattered behind the label. */
    seeds?: string[];
    onclick: () => void;
  };
  const SEEDS = ["Vent", "Crawler VP", "frontend bro", "slack green guy", "chat shell", "search page", "pi durable fit", "usage and hosts"];
  let { label, secondary = false, seeds = SEEDS, onclick }: Props = $props();
</script>

<button type="button" class="tile" {onclick}>
  <span class="art" aria-hidden="true">
    {#each seeds.slice(0, 8) as seed, i (seed)}<span class="m m{i + 1}"><Mascot {seed} size={72} id="tile-{i}-{secondary ? 'b' : 'a'}" /></span>{/each}
  </span>
  <span class="label t-label-sm" data-tone={secondary ? "secondary" : undefined}>{label}</span>
</button>

<style>
  .tile {
    position: relative;
    isolation: isolate;
    display: grid;
    place-items: center;
    min-height: 244px;
    overflow: hidden;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    cursor: pointer;
  }
  .tile:hover {
    background: var(--affordance-subtle-hover);
  }
  .art {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
  }
  .m {
    position: absolute;
    width: 72px;
    height: 72px;
  }
  .m1 { left: -8%; top: 12%; transform: rotate(-12deg); }
  .m2 { right: -9%; top: 8%; transform: rotate(12deg); }
  .m3 { left: 34%; top: 0; }
  .m4 { left: 35%; bottom: 0; transform: rotate(-10deg); }
  .m5 { left: -10%; bottom: 10%; }
  .m6 { right: -8%; bottom: 0; }
  .m7 { right: -20%; top: 43%; }
  .m8 { left: -24%; top: 45%; }
  .label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-pill);
    color: var(--text-on-prominent);
    background: var(--affordance-prominent);
  }
  .label[data-tone="secondary"] {
    color: var(--text-standard);
    background: var(--affordance-subtle);
  }
</style>
