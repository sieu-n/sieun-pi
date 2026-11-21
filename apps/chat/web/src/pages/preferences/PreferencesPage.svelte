<script lang="ts">
  import { CardGroup, IconButton, Button, Page, PanelHeader, Select } from "$lib/ui";
  import { theme, type ColorMode } from "$lib/shell/theme.svelte";
  import { ZOOM_MAX, ZOOM_MIN, setZoom, zoom } from "$lib/shell/zoom.svelte";
  import { shortcutLabel } from "$lib/shortcuts";
  import SettingRow from "$pages/settings/SettingRow.svelte";

  /** Preferences: this browser's color mode and interface size, the same settings the avatar menu and Cmd +, Cmd - and Cmd 0 change. */
  const MODES: { value: ColorMode; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  const percent = $derived(Math.round(zoom.scale * 100));
  /** The row shows the size itself, so a step here raises no size toast. */
  const size = (scale: number) => setZoom(scale, { toast: false });
</script>

<Page measure="narrow">
  {#snippet header()}
    <PanelHeader title="Preferences" icon="sun" level={1} />
  {/snippet}

  <CardGroup>
    <SettingRow label="Color mode" for="pref-color-mode">
      <Select id="pref-color-mode" label="Color mode" size="sm" value={theme.mode} options={MODES} onchange={(mode) => theme.set(mode)} />
    </SettingRow>
    <SettingRow label="Interface size">
      {#if percent !== 100}<Button variant="ghost" size="sm" onclick={() => size(1)}>Reset</Button>{/if}
      <div class="stepper" role="group" aria-label="Interface size">
        <IconButton icon="minus" label="Zoom out" shortcut={shortcutLabel("zoom-out")} size="sm" disabled={zoom.scale <= ZOOM_MIN} onclick={() => size(zoom.scale - 0.1)} />
        <output class="percent" aria-live="polite" data-testid="interface-size">{percent}%</output>
        <IconButton icon="plus" label="Zoom in" shortcut={shortcutLabel("zoom-in")} size="sm" disabled={zoom.scale >= ZOOM_MAX} onclick={() => size(zoom.scale + 0.1)} />
      </div>
    </SettingRow>
  </CardGroup>
</Page>

<style>
  .stepper {
    display: flex;
    align-items: center;
    border-radius: var(--radius-pill);
    box-shadow: inset 0 0 0 1px var(--border-standard);
  }
  .percent {
    min-width: 48px;
    text-align: center;
    font: var(--text-body-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
