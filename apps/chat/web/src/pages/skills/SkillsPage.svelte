<script lang="ts">
  import { api } from "$lib/api";
  import type { SkillsReport } from "$lib/api/shared/skills";
  import { openView } from "$lib/shell/viewer.svelte";
  import { Badge, Button, CardGroup, EmptyState, IconButton, LoadingText, NavItem, Page, PanelHeader, SearchField, Tabs } from "$lib/ui";
  import { FILTERS, VERDICT_TONE, agoText, flagBadges, grouped, isFlagged, needsAction, rowDetail, type Filter } from "./model";

  /**
   * Skills: every skill on the boxes from the skills inventory (server/skills.ts), grouped by kind, with its path, box, loaders, last use
   * and flags. Opening the page starts a scan; the page shows the last inventory at once and the new one when the scan ends. A row opens its
   * SKILL.md in the viewer popup.
   */
  let report = $state<SkillsReport | null>(null);
  let error = $state<string | null>(null);
  let filter = $state<Filter>("all");
  let text = $state("");
  let now = $state(Date.now());

  /** Read the inventory, which starts a scan, then wait for that scan and show the inventory it wrote. */
  async function load(): Promise<void> {
    try {
      report = await api.skills();
      error = null;
      if (report.scan.running) report = await api.skills({ wait: true });
      now = Date.now();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  $effect(() => {
    void load();
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(tick);
  });

  const rows = $derived(report?.inventory?.skills ?? []);
  const groups = $derived(grouped(rows, filter, text));
  const boxes = $derived(report?.inventory?.boxes ?? []);
  const flagged = $derived(rows.filter(isFlagged).length);
  const toAct = $derived(rows.filter(needsAction).length);
  const generated = $derived(report?.inventory?.generatedAt ? Date.parse(report.inventory.generatedAt) : null);
  const scanning = $derived(report?.scan.running ?? false);
  const tabs = $derived(FILTERS.map(f => ({ id: f.id, label: f.label, badge: f.id === "flagged" ? flagged : f.id === "act" ? toAct : rows.length })));
  const shown = $derived(groups.reduce((sum, entry) => sum + entry.rows.length, 0));
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Skills" icon="spark" level={1}>
      {#snippet actions()}<IconButton icon="refresh" label={scanning ? "Scanning the boxes" : "Scan again"} size="sm" loading={scanning} onclick={() => void load()} />{/snippet}
    </PanelHeader>
  {/snippet}

  {#if !report && error}
    <EmptyState icon="spark" title="Skills aren't available" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void load()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !report}
    <LoadingText text="Reading the skills…" />
  {:else if !report.inventory}
    <EmptyState icon="spark" title={scanning ? "Scanning the boxes for skills" : "No skills inventory yet"} description={scanning ? "The first scan is running. The list shows here when it ends." : (report.scan.error ?? report.readError ?? "")}>
      {#snippet action()}{#if !scanning}<Button variant="outline" size="sm" onclick={() => void load()}>Scan now</Button>{/if}{/snippet}
    </EmptyState>
  {:else}
    <div class="intro">
      <p class="summary" data-testid="skills-summary">
        <b>{rows.length} skills</b> on {boxes.length === 1 ? "1 box" : `${boxes.length} boxes`}. <b>{flagged} flagged</b> for duplication, drift or no use, and <b>{toAct} to merge or remove</b>.
        {#if generated !== null}Scanned {agoText(generated, now)}{scanning ? ", and a new scan runs now." : "."}{/if}
      </p>
      {#if report.inventory.definition}<p class="definition">{report.inventory.definition}</p>{/if}
      {#each boxes.filter(b => !b.ok) as box (box.box)}<p class="notice" role="status">{box.box} did not scan: {box.error ?? "the scanner gave no reason"}</p>{/each}
      {#if report.scan.error}<p class="notice" role="status">The last scan failed: {report.scan.error}</p>{/if}
      {#if error}<p class="notice" role="status">The last read failed: {error}</p>{/if}
    </div>

    <div class="controls">
      <div class="search"><SearchField bind:value={text} placeholder="Filter by name, path or box" label="Filter skills" clearable /></div>
      <Tabs items={tabs} value={filter} size="sm" label="Which skills" onchange={next => (filter = next)} />
    </div>

    {#if shown === 0}
      <EmptyState icon="filter" title="No skill matches" description="Clear the filter to see every skill." />
    {/if}
    {#each groups as { group, rows: list } (group.kind)}
      <CardGroup title={`${group.title} (${list.length})`} description={group.description}>
        {#each list as row (row.id)}
          {@const badges = flagBadges(row)}
          <NavItem variant="card" icon={group.icon} label={row.name} detail={rowDetail(row, now)} onclick={() => openView({ kind: "skill", id: row.id })} data-testid="skill-row" data-skill={row.id}>
            {#snippet labelContent()}
              <span class="name">{row.name}</span>
              <Badge tone="outline" title="Box">{row.box}</Badge>
              {#if row.group}<span class="group">{row.group}</span>{/if}
            {/snippet}
            {#snippet trailing()}
              <span class="trail">
                {#each badges as badge (badge.label)}<Badge tone={badge.tone} title={badge.detail}>{badge.label}</Badge>{/each}
                {#if row.useful.verdict && row.useful.verdict !== "keep"}<Badge tone={VERDICT_TONE[row.useful.verdict]} title={row.useful.reason}>{row.useful.verdict}</Badge>{/if}
                {#if row.uses7d !== null}<span class="uses" title="Uses in the last 7 days">{row.uses7d} {row.uses7d === 1 ? "use" : "uses"} in 7 d</span>{/if}
              </span>
            {/snippet}
          </NavItem>
        {/each}
      </CardGroup>
    {/each}
  {/if}
</Page>

<style>
  .intro { display: flex; flex-direction: column; gap: 8px; max-width: 48rem; }
  .summary { margin: 0; color: var(--text-subtle); font: var(--text-body-lg); letter-spacing: var(--tracking-body-lg); }
  .summary b { color: var(--text-standard); font-weight: 500; }
  .definition { margin: 0; color: var(--text-subtle); font: var(--text-body); }
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .search { flex: 1 1 16rem; max-width: 24rem; }
  .name { font-weight: 500; }
  .group { color: var(--text-subtle); font: var(--text-body-sm); }
  .trail { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
  .uses { min-width: 6.5em; color: var(--text-subtle); font: var(--text-body-sm); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
</style>
