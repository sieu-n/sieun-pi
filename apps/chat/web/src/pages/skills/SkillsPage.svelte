<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$lib/api";
  import { live } from "$lib/api/live.svelte";
  import { router } from "$lib/router.svelte";
  import { Button, IconButton, Page, PanelHeader, Tabs } from "$lib/ui";
  import { skillsInventory, skillsView } from "./kept.svelte";
  import { INVENTORY_LAYOUT, LAYOUTS, layoutOf } from "./layouts/registry";

  /**
   * Settings > Skills: GET /api/skills (the skills DB read model, server/skills-db.ts) handed to the layout that `?layout=<id>` names,
   * with a switcher in the header; with no `?layout=` it opens `tree`. The `current` layout draws the scanner's inventory instead, so there the view is only read ahead, behind
   * the inventory, for a switch to another layout. Both are kept (kept.svelte.ts), so an open draws the last answer at once and reads it
   * again behind. The header's scan button starts a scan, and the `skills` live event says when it ends; the page reads the view again
   * then, so every layout shows the new scan.
   */
  let scanError = $state<string | null>(null);
  let scanState = $state<boolean | null>(null);

  const layout = $derived(layoutOf(router.route.params.layout));
  const drawsView = $derived(layout?.id !== INVENTORY_LAYOUT);
  const view = $derived(skillsView.value);
  const error = $derived(scanError ?? (drawsView ? skillsView.error : null));
  const scanning = $derived(scanState ?? (drawsView ? view : skillsInventory.value)?.scan.running ?? false);

  const reload = (): Promise<void> => skillsView.read();

  async function scan(): Promise<void> {
    try {
      scanState = (await api.scanSkills()).scan.running;
      scanError = null;
    } catch (reason) {
      scanError = reason instanceof Error ? reason.message : String(reason);
    }
  }

  $effect(() => {
    const shows = drawsView;
    untrack(() => void (shows ? skillsView.open() : skillsInventory.open().then(() => skillsView.ahead())));
  });

  $effect(() =>
    live.on(event => {
      if (event.type !== "skills") return;
      scanState = event.scan.running;
      if (event.scan.running) return;
      // On `current` the view's read ahead goes once the inventory's refresh, which the layout asks for at this event, has its answer:
      // in full2-1119bea the two left together after each scan, and the inventory's answer waited 868 to 1,236 ms behind the view's.
      if (untrack(() => drawsView)) void skillsView.read("shown");
      else void skillsInventory.read("shown").then(() => skillsView.read("ahead"));
    }));

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
  {#if layout && (view || !drawsView)}
    {@const Layout = layout.component}
    <Layout view={view!} {reload} />
  {/if}
</Page>

<style>
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
</style>
