<script lang="ts">
  /**
   * The busy spinner every view uses. It turns with a transform, which the compositor runs alone. Its delay is minus the page clock modulo one
   * turn, set once at mount, so every spinner turns in one phase however late it mounted, with no listener or timer. On 10-19 an
   * animationstart listener that set each remounted spinner's startTime to 0 ran 58 style recalcs a second on the live sidebar.
   */
  let { size = "tiny", quiet = false }: { size?: "tiny" | "normal"; quiet?: boolean } = $props();
  const TURN_MS = 900;
  const phase = -(performance.now() % TURN_MS);
</script>

<span class="spinner" class:tiny={size === "tiny"} class:quiet style:animation-duration="{TURN_MS}ms" style:animation-delay="{phase}ms" aria-hidden="true"></span>

<style>
  .spinner { --size: 14px; display: inline-block; flex: none; box-sizing: border-box; width: var(--size); height: var(--size); min-width: var(--size); min-height: var(--size); aspect-ratio: 1; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin linear infinite; vertical-align: -2px; }
  .tiny { --size: 11px; border-width: 1.5px; }
  .quiet { opacity: 0.4; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: var(--text-muted); } }
</style>
