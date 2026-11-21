<script lang="ts">
  import { SHORTCUT_GROUPS, keyCaps } from "$lib/shortcuts";

  /** Every shortcut in lib/shortcuts.ts, grouped by area, for the Cmd+/ sheet and Settings > Keyboard. */
</script>

<div class="groups" data-testid="shortcut-list">
  {#each SHORTCUT_GROUPS as group (group.id)}
    <section aria-labelledby="shortcuts-{group.id}">
      <h3 id="shortcuts-{group.id}" class="t-label-sm">{group.label}</h3>
      <dl>
        {#each group.shortcuts as s (s.id)}
          <div class="row" data-shortcut={s.id}>
            <dt>
              {s.label}
              {#if "scope" in s}<span class="scope">{s.scope}</span>{/if}
            </dt>
            <dd>{#each keyCaps(s.keys) as cap, i (i)}<kbd>{cap}</kbd>{/each}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}
</div>

<style>
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-6) var(--space-8);
  }
  h3 {
    margin: 0 0 var(--space-2);
  }
  dl {
    display: flex;
    flex-direction: column;
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 36px;
    border-bottom: 1px solid var(--border-standard);
  }
  .row:last-child {
    border-bottom: 0;
  }
  dt {
    display: flex;
    flex-direction: column;
    font: var(--text-body-sm);
  }
  .scope {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  dd {
    display: flex;
    flex: none;
    gap: var(--space-1);
    margin: 0;
  }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--border-standard);
    border-radius: 6px;
    background: var(--surface-inset);
    color: var(--text-subtle);
    font: var(--text-caption);
  }
</style>
