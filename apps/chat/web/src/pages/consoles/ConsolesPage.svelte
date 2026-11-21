<script lang="ts">
  import { api } from "$lib/api";
  import { groupRows, refText, resolveCell, type ConsolesReport } from "$lib/api/shared/consoles";
  import { Badge, Button, EmptyState, IconButton, LoadingText, Page, PanelHeader, toast } from "$lib/ui";

  /**
   * Consoles: one row per console, dashboard and database login, one column per tier, from auto-sns-agent's consoles.json (server/consoles.ts),
   * the file the wiki page domains/devops/consoles renders too. A cell links its URL and shows the tunnel to run first, the TablePlus group,
   * whether the login is read-only and the key names the logins script reads.
   */
  const GROUP_NAMES: Record<string, string> = { data: "Data stores", obs: "Observability", app: "Apps", hosting: "Hosting", vendor: "Vendors" };

  let report = $state<ConsolesReport | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load(): Promise<void> {
    loading = true;
    try {
      report = await api.consoles();
      error = null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
  });

  const table = $derived(report?.table ?? null);
  const groups = $derived(table ? groupRows(table.rows) : []);
  const tierName = (id: string): string => table?.tiers.find(t => t.id === id)?.name ?? id;
  const shortUrl = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  async function copy(command: string): Promise<void> {
    await navigator.clipboard.writeText(command);
    toast.show("Tunnel command copied");
  }
</script>

<Page measure="full">
  {#snippet header()}
    <PanelHeader title="Consoles" icon="external" level={1}>
      {#snippet actions()}<IconButton icon="refresh" label="Read again" size="sm" {loading} onclick={() => void load()} />{/snippet}
    </PanelHeader>
  {/snippet}

  {#if !report && error}
    <EmptyState icon="external" title="Consoles aren't available" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void load()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !report}
    <LoadingText text="Reading the consoles…" />
  {:else if !table}
    <EmptyState icon="external" title="No consoles table" description={report.readError ?? report.file} />
  {:else}
    <div class="wrap">
      {#if table.logins}<p class="logins">Logins: <code>{table.logins}</code></p>{/if}
      <table class="consoles" data-testid="consoles-table">
        <thead>
          <tr><th scope="col" class="name">Console</th>{#each table.tiers as tier (tier.id)}<th scope="col">{tier.name}</th>{/each}</tr>
        </thead>
        {#each groups as group (group.group)}
          <tbody>
            <tr class="group"><th scope="rowgroup" colspan={table.tiers.length + 1}>{GROUP_NAMES[group.group] ?? group.group}</th></tr>
            {#each group.rows as row (row.id)}
              <tr data-console={row.id}>
                <th scope="row" class="name">{row.name}</th>
                {#each table.tiers as tier (tier.id)}
                  {@const { cell, sameAs } = resolveCell(row, tier.id)}
                  <td data-tier={tier.id}>
                    {#if sameAs}<span class="meta">Same as {tierName(sameAs)}</span>{/if}
                    {#if cell.kind === "none"}
                      <span class="none">{cell.text || "None"}</span>
                    {:else}
                      <div class="open">
                        {#if cell.url}<a href={cell.url} target="_blank" rel="noreferrer">{shortUrl(cell.url)}</a>{/if}
                        {#if cell.tableplus}<span class="tp">TablePlus · {cell.tableplus}</span>{/if}
                        {#if cell.access === "ro"}<Badge tone="outline">read-only</Badge>{:else if cell.access === "rw"}<Badge tone="warning">read-write</Badge>{/if}
                      </div>
                      {#if cell.tunnel}
                        <div class="tunnel"><code>{cell.tunnel}</code><IconButton icon="copy" label="Copy the tunnel command" size="xs" onclick={() => void copy(cell.tunnel ?? "")} /></div>
                      {/if}
                      {#if cell.signIn || cell.user || cell.secret}
                        <div class="meta">
                          {#if cell.signIn}<span>{cell.signIn}</span>{/if}
                          {#if cell.user}<code>{refText(cell.user)}</code>{/if}
                          {#if cell.secret}<code>{refText(cell.secret)}</code>{/if}
                        </div>
                      {/if}
                      {#if cell.note}<div class="meta">{cell.note}</div>{/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    </div>
  {/if}
</Page>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--space-3); }
  .logins { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  code { font: var(--text-mono); color: var(--text-standard); word-break: break-all; }
  .consoles { width: 100%; border-collapse: collapse; table-layout: fixed; font: var(--text-body-sm); color: var(--text-standard); }
  .consoles th, .consoles td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-standard); text-align: left; vertical-align: top; }
  .consoles thead th { color: var(--text-metadata); font: var(--text-caption); font-weight: 500; }
  .consoles .name { width: 12rem; font: var(--text-label-sm); }
  .group th { padding-top: var(--space-4); color: var(--text-subtle); font: var(--text-caption); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .open { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1-5) var(--space-2); }
  .open a { color: var(--text-message-link); word-break: break-all; }
  .tp { white-space: nowrap; }
  .tunnel { display: flex; align-items: flex-start; gap: var(--space-1); margin-top: var(--space-1); }
  .tunnel code { flex: 1; min-width: 0; color: var(--text-subtle); }
  .meta { display: flex; flex-wrap: wrap; gap: 2px var(--space-2); margin-top: var(--space-1); color: var(--text-subtle); font: var(--text-caption); }
  .meta code { color: var(--text-subtle); font-size: 11px; }
  .none { color: var(--text-metadata); }
</style>
