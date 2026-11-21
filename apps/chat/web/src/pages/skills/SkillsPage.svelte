<script lang="ts">
  import { api } from "$lib/api";
  import { live } from "$lib/api/live.svelte";
  import type { SkillsView } from "$lib/api/shared/skills";
  import { router } from "$lib/router.svelte";
  import { Button, IconButton, Page, PanelHeader, Tabs } from "$lib/ui";
  import { LAYOUTS, layoutOf } from "./layouts/registry";

  /**
   * Settings > Skills: one read of GET /api/skills (the skills DB read model, server/skills-db.ts) handed to the layout that
   * `?layout=<id>` names, with a switcher in the header. The header's scan button starts a scan, and the `skills` live event says when it
   * ends; the page reads the view again then, so every layout shows the new scan.
   */
  let view = $state<SkillsView | null>(null);
  let error = $state<string | null>(null);
  let scanning = $state(false);

  async function reload(): Promise<void> {
    try {
      view = await api.skills();
      scanning = view.scan.running;
      error = null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }

  async function scan(): Promise<void> {
    try {
      scanning = (await api.scanSkills()).scan.running;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }

  $effect(() => {
    void reload();
    return live.on(event => {
      if (event.type !== "skills") return;
      scanning = event.scan.running;
      if (!event.scan.running) void reload();
    });
  });

  const layout = $derived(layoutOf(router.route.params.layout));
  const tabs = $derived(LAYOUTS.map(entry => ({ id: entry.id, label: entry.label })));
</script>

<Page measure={layout?.measure ?? "wide"}>
  {#snippet header()}
    <PanelHeader title="Skills" icon="spark" level={1}>
      {#snippet actions()}
        {#if tabs.length > 1}<Tabs items={tabs} value={layout?.id ?? ""} size="sm" label="Layout" onchange={id => router.setParams({ layout: id }, { replace: true })} />{/if}
        <Button variant="outline" size="sm" href="#/settings/skills/review">Review cleanup</Button>
        <IconButton icon="refresh" label={scanning ? "Scanning the boxes" : "Scan again"} size="sm" loading={scanning} onclick={() => void scan()} />
      {/snippet}
    </PanelHeader>
  {/snippet}

  {#if error}<p class="notice" role="status">The last read failed: {error}</p>{/if}
  {#if layout && (view || layout.id === "current")}
    {@const Layout = layout.component}
    <Layout view={view!} {reload} />
  {/if}
</Page>

<style>
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
</style>
