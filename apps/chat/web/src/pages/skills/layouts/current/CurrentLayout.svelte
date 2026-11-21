<script lang="ts">
  import { api } from "$lib/api";
  import { live } from "$lib/api/live.svelte";
  import type { SkillsReport } from "$lib/api/shared/skills";
  import { openView } from "$lib/shell/viewer.svelte";
  import { Badge, Button, CardGroup, Disclosure, EmptyState, LoadingText, Markdown, NavItem, SearchField, Tabs } from "$lib/ui";
  import { FILTERS, VERDICT_TONE, agoText, definitionMarkdown, flagBadges, grouped, isFlagged, needsAction, rowDetail, type Filter } from "../../model";

  /**
   * The `current` layout: the Skills page as it was before the skills DB, every row of the scanner's inventory (GET /api/skills/inventory)
   * grouped by kind, with its path, box, loaders, last use and flags. It reads the inventory again when the `skills` live event says a scan
   * ended. A row opens its SKILL.md in the viewer popup.
   */
  let report = $state<SkillsReport | null>(null);
  let error = $state<string | null>(null);
  let filter = $state<Filter>("all");
  let text = $state("");
  let now = $state(Date.now());
  let definitionOpen = $state(false);

  async function read(): Promise<void> {
    try {
      report = await api.skillsInventory();
      error = null;
      now = Date.now();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }

  /** Shows the last inventory, then starts a scan, whose end the live event brings. */
  async function load(): Promise<void> {
    await read();
    try {
      const { scan } = await api.scanSkills();
      if (report) report = { ...report, scan };
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  $effect(() => {
    void read();
    const off = live.on(event => {
      if (event.type !== "skills") return;
      if (event.scan.running) {
        if (report) report = { ...report, scan: event.scan };
      } else void read();
    });
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      off();
      clearInterval(tick);
    };
  });

  const rows = $derived(report?.inventory?.skills ?? []);
  const groups = $derived(grouped(rows, filter, text));
  const boxes = $derived(report?.inventory?.boxes ?? []);
  const flagged = $derived(rows.filter(isFlagged).length);
  const toAct = $derived(rows.filter(needsAction).length);
  const generated = $derived(report?.inventory?.generatedAt ? Date.parse(report.inventory.generatedAt) : null);
  const scanning = $derived(report?.scan.running ?? false);
  const tabs = $derived(FILTERS.map(f => ({ id: f.id, label: f.label, badge: String(f.id === "flagged" ? flagged : f.id === "act" ? toAct : rows.length) })));
  const shown = $derived(groups.reduce((sum, entry) => sum + entry.rows.length, 0));
</script>

<div class="layout">
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
      {#if report.inventory.definition}
        <Disclosure title="What a useful skill is" bind:open={definitionOpen}><div class="definition"><Markdown text={definitionMarkdown(report.inventory.definition)} /></div></Disclosure>
      {/if}
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
</div>

<style>
  .layout { display: flex; flex-direction: column; gap: 16px; }
  .intro { display: flex; flex-direction: column; gap: 8px; max-width: 48rem; }
  .summary { margin: 0; color: var(--text-subtle); font: var(--text-body-lg); letter-spacing: var(--tracking-body-lg); }
  .summary b { color: var(--text-standard); font-weight: 500; }
  .definition { color: var(--text-subtle); }
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .search { flex: 1 1 16rem; max-width: 24rem; }
  .name { font-weight: 500; }
  .group { color: var(--text-subtle); font: var(--text-body-sm); }
  .trail { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
  .uses { min-width: 6.5em; color: var(--text-subtle); font: var(--text-body-sm); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
</style>
