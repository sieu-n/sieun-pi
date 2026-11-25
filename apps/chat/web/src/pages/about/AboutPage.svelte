<script lang="ts">
  import { reads, view, type ReleaseView } from "$lib/api";
  import { Badge, Button, CardGroup, EmptyState, IconButton, LoadingText, Page, PanelHeader, StatusDot, stampLabel, tooltip } from "$lib/ui";
  import SettingRow from "$pages/settings/SettingRow.svelte";
  import { commitUrl, newer, short } from "./about";

  /**
   * About: what each box runs, read from GET /api/about. One card per box with its Pi, pi-host and apps/chat releases and the Prime release
   * the vendored harness came from and the daemon runs. An away box keeps the values of its last good read and says when that was.
   */
  const about = view(() => reads.about());
  const report = $derived(about.value);
  const hhmm = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const built = (release: ReleaseView): string => (release.builtAt ? `${release.release}, built ${stampLabel(Date.parse(release.builtAt))}` : release.release);
</script>

{#snippet commit(sha: string)}
  <a class="sha" href={commitUrl(sha)} target="_blank" rel="noreferrer" use:tooltip={sha}>{short(sha)}</a>
{/snippet}

<Page measure="narrow">
  {#snippet header()}
    <PanelHeader title="About" icon="info" level={1}>
      {#snippet actions()}<IconButton icon="refresh" label="Read again" size="sm" loading={about.loading} onclick={() => void about.refresh()} />{/snippet}
    </PanelHeader>
  {/snippet}

  {#if !report && about.error}
    <EmptyState icon="info" title="Versions didn't load" description={about.error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void about.refresh()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !report}
    <LoadingText text="Reading each box's versions…" />
  {:else}
    <div class="boxes" data-testid="about-hosts">
      {#each report.hosts as host (host.box)}
        {@const v = host.versions}
        <div data-testid="about-host-{host.box}" data-state={host.state}>
          <CardGroup title={host.box}>
            {#snippet actions()}
              <span class="state" use:tooltip={host.error}>
                <StatusDot status={host.state === "up" ? "online" : "away"} />
                {host.state === "away" ? (host.readAt ? `Away, last read ${hhmm(host.readAt)}` : "Away, never read") : host.error ? "Up, read failed" : "Up"}
              </span>
            {/snippet}
            {#if !v}
              <SettingRow label="Versions" detail={host.error ?? undefined}><span class="none">Not read</span></SettingRow>
            {:else}
              <SettingRow label="Pi" detail={report.piLatest ? `Newest on npm ${report.piLatest.version}` : undefined}>
                {#if v.pi}
                  {#if report.piLatest && newer(report.piLatest.version, v.pi)}<Badge tone="warning" title="npm has a newer Pi">{report.piLatest.version} out</Badge>{/if}
                  <span class="value" data-testid="pi-version">{v.pi}</span>
                {:else}<span class="none">Not found</span>{/if}
              </SettingRow>
              <SettingRow label="pi-host" detail={v.piHost ? built(v.piHost) : undefined}>
                {#if v.piHost}{@render commit(v.piHost.sha)}{:else}<span class="none">Not installed</span>{/if}
              </SettingRow>
              <SettingRow label="apps/chat" detail={v.appsChat ? built(v.appsChat) : undefined}>
                {#if v.appsChat}{@render commit(v.appsChat.sha)}{:else}<span class="none">Not installed</span>{/if}
              </SettingRow>
              <SettingRow label="Prime vendored from" detail={v.primeVendored?.version}>
                {#if v.primeVendored}<span class="value mono" use:tooltip={v.primeVendored.sha}>{short(v.primeVendored.sha)}</span>{:else}<span class="none">Not found</span>{/if}
              </SettingRow>
              <SettingRow label="Prime daemon" detail={v.primeDaemon ?? undefined}>
                {#if !v.primeDaemon}<span class="none">Not running</span>{:else if v.primeDaemon === v.primeVendored?.version}<span class="value">Same as vendored</span>{/if}
              </SettingRow>
            {/if}
          </CardGroup>
        </div>
      {/each}
    </div>
  {/if}
</Page>

<style>
  .boxes {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .value {
    font: var(--text-body-sm);
    color: var(--text-standard);
    font-variant-numeric: tabular-nums;
  }
  .mono,
  .sha {
    font-family: var(--font-mono);
  }
  .sha {
    font-size: 13px;
    color: var(--text-message-link);
  }
  .none {
    font: var(--text-body-sm);
    color: var(--text-metadata);
  }
</style>
