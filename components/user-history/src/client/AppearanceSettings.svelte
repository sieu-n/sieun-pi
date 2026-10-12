<script lang="ts">
  import { ACCENTS, applyAppearance, browserStorage, DENSITIES, loadAppearance, saveAppearance, TEXT_SIZES, THEMES, type Accent, type Appearance } from "./appearance.ts";

  let appearance = $state<Appearance>(loadAppearance(browserStorage()));
  function set<K extends keyof Appearance>(field: K, value: Appearance[K]): void {
    appearance = { ...appearance, [field]: value };
    saveAppearance(browserStorage(), appearance);
    applyAppearance(document, appearance);
  }

  const THEME_LABELS = { system: "Match system", light: "Light", dark: "Dark" } as const;
  const SIZE_LABELS = { small: "Small", normal: "Normal", large: "Large" } as const;
  const DENSITY_LABELS = { comfortable: "Comfortable", compact: "Compact" } as const;
  const ACCENT_LABELS: Record<Accent, string> = { ocean: "Ocean", violet: "Violet", green: "Green", amber: "Amber", rose: "Rose", graphite: "Graphite" };
</script>

<section class="pane" aria-label="Appearance">

  <div class="field">
    <span class="label" id="appearance-theme">Theme</span>
    <div class="segmented" role="radiogroup" aria-labelledby="appearance-theme">
      {#each THEMES as value (value)}
        <button role="radio" aria-checked={appearance.theme === value} class:on={appearance.theme === value} onclick={() => set("theme", value)}>{THEME_LABELS[value]}</button>
      {/each}
    </div>
  </div>

  <div class="field">
    <span class="label" id="appearance-accent">Accent color</span>
    <div class="swatches" role="radiogroup" aria-labelledby="appearance-accent">
      {#each ACCENTS as value (value)}
        <button role="radio" aria-checked={appearance.accent === value} class="swatch" class:on={appearance.accent === value} data-swatch={value} onclick={() => set("accent", value)}>
          <span class="dot"></span>{ACCENT_LABELS[value]}
        </button>
      {/each}
    </div>
  </div>

  <div class="field">
    <span class="label" id="appearance-size">Text size</span>
    <div class="segmented" role="radiogroup" aria-labelledby="appearance-size">
      {#each TEXT_SIZES as value (value)}
        <button role="radio" aria-checked={appearance.textSize === value} class:on={appearance.textSize === value} onclick={() => set("textSize", value)}>{SIZE_LABELS[value]}</button>
      {/each}
    </div>
  </div>

  <div class="field">
    <span class="label" id="appearance-density">Spacing</span>
    <div class="segmented" role="radiogroup" aria-labelledby="appearance-density">
      {#each DENSITIES as value (value)}
        <button role="radio" aria-checked={appearance.density === value} class:on={appearance.density === value} onclick={() => set("density", value)}>{DENSITY_LABELS[value]}</button>
      {/each}
    </div>
  </div>

  <div class="preview" aria-hidden="true">
    <div class="line mine"><span class="bubble mine">Can you switch the chat to dark?</span></div>
    <div class="line"><span class="bubble theirs">Done. The whole app follows the theme you pick here.</span></div>
    <div class="preview-row"><button class="button primary small" tabindex="-1">Primary</button><span class="chip active">Selected</span><a href="#appearance" tabindex="-1" onclick={event => event.preventDefault()}>A link</a></div>
  </div>
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .field { display: grid; grid-template-columns: 120px minmax(0, 1fr); align-items: center; gap: 12px; }
  .label { font-weight: 500; }
  .segmented { justify-self: start; }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; }
  .swatch { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-elevated); font-size: 12.5px; color: var(--text-muted); }
  .swatch:hover { border-color: var(--border-strong); color: var(--text); }
  .swatch.on { border-color: var(--text-muted); color: var(--text); font-weight: 600; }
  .swatch .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
  .preview { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); font-size: var(--chat-text); line-height: 1.45; }
  .line { display: flex; }
  .line.mine { justify-content: flex-end; }
  .bubble { max-width: 80%; padding: 8px 14px; border-radius: 18px; }
  .bubble.mine { background: var(--mine-bubble); border-bottom-right-radius: 5px; }
  .bubble.theirs { background: var(--user-bubble); border-bottom-left-radius: 5px; }
  .preview-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 13px; }
  :global(:root[data-density="compact"]) .bubble { padding: 5px 12px; }
</style>
