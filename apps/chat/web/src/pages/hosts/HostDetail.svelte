<script lang="ts">
  import type { HostView } from "$lib/api";
  import { conversationHref } from "$lib/router.svelte";
  import { ageLabel, Checkbox, Disclosure, IconButton, Menu, StatusDot, Tabs, toast, tooltip, type MenuEntry } from "$lib/ui";
  import { agentRelayLine, gb, machineRelayLine, piHostLine, RUN_DOT, RUN_LABEL, shownThreads, threadTabs, useRows, type ThreadFilter } from "./hosts";

  /** The selected box: its memory and CPU by group, its services and the threads its pi-host holds. */
  let { host, now, onrefresh }: { host: HostView; now: number; onrefresh: () => void } = $props();

  const machine = $derived(host.machine);
  const rows = $derived(machine ? useRows(machine) : []);
  const usedRam = $derived(rows.reduce((sum, row) => sum + (row.ram ?? 0), 0));
  const hasCores = $derived(rows.some(row => row.cores !== null));
  const services = $derived([piHostLine(host), agentRelayLine(host, now), machineRelayLine(host)].filter(line => line !== null));
  const PRESSURE: Record<string, string> = { warn: "memory pressure high", critical: "memory pressure critical" };
  const facts = $derived(
    machine
      ? [
          host.address,
          `${machine.cpu.cores} cores, load ${machine.cpu.load[0].toFixed(1)}`,
          machine.memory.swapUsedBytes !== null ? `swap ${gb(machine.memory.swapUsedBytes)}${machine.memory.swapTotalBytes ? ` / ${gb(machine.memory.swapTotalBytes)}` : ""} GB` : null,
        ].filter(fact => fact !== null)
      : [host.address],
  );
  const pressure = $derived(machine?.memory.pressure ? (PRESSURE[machine.memory.pressure] ?? null) : null);
  const consequence = $derived(
    host.agentRelay?.state === "away" ? "Posts to its agents wait until the box is back." : host.piHost.state === "down" ? "Its threads can't run until pi-host answers." : null,
  );

  let filter = $state<ThreadFilter>("working");
  let showTests = $state(false);
  const testCount = $derived(host.threads.filter(thread => thread.test).length);
  const pool = $derived(showTests ? host.threads : host.threads.filter(thread => !thread.test));
  const tabs = $derived(threadTabs(pool));
  const threads = $derived(shownThreads(pool, filter));

  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLElement | null>(null);
  const copy = (text: string, done: string) => void navigator.clipboard.writeText(text).then(() => toast.show(done), () => toast.show("Copy failed"));
  const menuItems = $derived<MenuEntry[]>([
    { id: "refresh", label: "Refresh", icon: "refresh", onselect: onrefresh },
    { id: "address", label: "Copy address", detail: host.address, onselect: () => copy(host.address, "Address copied") },
    ...(host.piHost.state === "answering" && host.piHost.socket ? [{ id: "socket", label: "Copy pi-host socket", detail: host.piHost.socket, onselect: () => copy(host.piHost.state === "answering" ? (host.piHost.socket ?? "") : "", "Socket path copied") }] : []),
  ]);
</script>

<section class="detail" data-testid="host-{host.name}" aria-label={host.name}>
  <header class="head">
    <h2>{host.name}</h2>
    <span class="facts">{facts.join(" · ")}{#if pressure}<span class="warn">{` · ${pressure}`}</span>{/if}</span>
    <span class="more" bind:this={menuAnchor}><IconButton icon="more" label="Host actions" size="sm" pressed={menuOpen} onclick={() => (menuOpen = !menuOpen)} /></span>
  </header>
  {#if menuOpen}<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement="bottom-end" label="Host actions" />{/if}
  {#if consequence}<p class="consequence" role="status">{consequence}</p>{/if}

  <div class="grid" class:solo={!machine}>
    {#if machine}
      <div class="block" aria-label="Memory and CPU by group" role="group">
        <div class="cols" aria-hidden="true"><span></span><span class="num">GB</span>{#if hasCores}<span class="num">Cores</span>{/if}</div>
        {#each rows as row (row.id)}
          <div class="use" class:cores={hasCores}>
            <Disclosure title={row.label}>
              {#snippet actions()}
                <span class="bar" use:tooltip={row.ram !== null && usedRam ? `${Math.round((100 * row.ram) / usedRam)}% of used memory` : null}><span style:width="{row.ram !== null && usedRam ? (100 * row.ram) / usedRam : 0}%"></span></span>
                <span class="num">{row.ram !== null ? gb(row.ram) : ""}</span>
                {#if hasCores}<span class="num">{row.cores !== null ? row.cores.toFixed(1) : ""}</span>{/if}
              {/snippet}
              <ul class="holders" class:cores={hasCores}>
                {#each row.top as item (item.label)}<li><span class="holder" use:tooltip={item.label}>{item.label}</span><span class="num">{gb(item.ram)}</span></li>
                {:else}<li><span class="holder">Nothing running</span></li>{/each}
                {#if row.swap}<li><span class="holder">In swap</span><span class="num">{gb(row.swap)}</span></li>{/if}
              </ul>
            </Disclosure>
          </div>
        {/each}
      </div>
    {/if}

    <ul class="block services" aria-label="Services">
      {#each services as line (line.name)}
        <li data-testid={line.name === "Agent relay" ? `agent-relay-${host.name}` : undefined}>
          <StatusDot status={line.dot} />
          <span class="name">{line.name}</span>
          <span class="value" use:tooltip={line.tip}>{line.text}</span>
        </li>
      {/each}
    </ul>
  </div>

  {#if host.piHost.state !== "absent"}
    <div class="threads">
      <div class="threads-head">
        <h3>Threads</h3>
        <div class="filters">
          {#if testCount}<Checkbox bind:checked={showTests} label="Show {testCount} test {testCount === 1 ? 'thread' : 'threads'}" />{/if}
          <Tabs items={tabs.map(tab => ({ id: tab.id, label: tab.label }))} bind:value={filter} size="sm" label="Show threads" />
        </div>
      </div>
      {#if threads.length}
        <ul class="list">
          {#each threads as thread (thread.id)}
            <li>
              <a class="thread" href={conversationHref(thread.id)} data-testid="host-thread-{thread.id}">
                <StatusDot status={RUN_DOT[thread.status]} label={RUN_LABEL[thread.status]} />
                <span class="name">{thread.name}</span>
                <span class="meta">{thread.model?.replace(/^[a-z0-9-]+\//i, "") ?? ""}</span>
                <span class="meta num">{thread.children ? `${thread.children} ${thread.children === 1 ? "job" : "jobs"}` : ""}</span>
                <span class="meta num" use:tooltip={new Date(thread.updatedAt).toLocaleString()}>{ageLabel(thread.updatedAt, now)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="none">{filter === "working" ? "Nothing working right now" : "No threads"}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .detail { display: flex; flex-direction: column; gap: var(--space-4); container-type: inline-size; }
  .head { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--space-1) var(--space-3); }
  .more { align-self: center; margin-left: auto; }
  .filters { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-4); }
  .filters :global(.checkbox) { color: var(--text-subtle); font: var(--text-caption); }
  h2 { margin: 0; font: var(--text-label); }
  h3 { margin: 0; font: var(--text-label-sm); }
  .facts { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); font-variant-numeric: tabular-nums; }
  .warn { color: var(--text-danger); }
  .consequence { margin: calc(-1 * var(--space-2)) 0 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: start; gap: var(--space-4); }
  .grid.solo { grid-template-columns: minmax(0, 1fr); }
  @container (width < 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .block { margin: 0; padding: var(--space-1) 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); list-style: none; }
  .num { color: var(--text-standard); font: var(--text-caption); font-variant-numeric: tabular-nums; text-align: right; }
  .cols, .use :global(.head > .actions) { display: grid; grid-template-columns: 72px 48px; align-items: center; gap: var(--space-3); }
  .cols { grid-template-columns: minmax(0, 1fr) 48px; padding: var(--space-1) var(--space-3) 0; }
  .cols .num, .cols span { color: var(--text-metadata); }
  .block:has(.use.cores) .cols { grid-template-columns: minmax(0, 1fr) 48px 44px; }
  .use.cores :global(.head > .actions) { grid-template-columns: 72px 48px 44px; }
  .use { padding: 0 var(--space-3) 0 var(--space-1); }
  .use :global(.head > .toggle) { min-height: 30px; font: var(--text-body-sm); }
  .bar { display: block; height: 4px; border-radius: var(--radius-pill); background: var(--affordance-subtle); overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: inherit; background: var(--text-standard); }
  .holders { display: flex; flex-direction: column; margin: 0 0 var(--space-1); padding: 0; list-style: none; }
  .holders li { display: grid; grid-template-columns: minmax(0, 1fr) 48px; gap: var(--space-3); padding: 2px 0; }
  .holders.cores li { grid-template-columns: minmax(0, 1fr) 48px 44px; }
  .holder { overflow: hidden; color: var(--text-subtle); font: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .services li { display: grid; grid-template-columns: 8px auto minmax(0, 1fr); align-items: center; gap: var(--space-2); min-height: 30px; padding: 0 var(--space-3); }
  .services .name { font: var(--text-body-sm); }
  .services .value { overflow: hidden; color: var(--text-subtle); font: var(--text-caption); text-align: right; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .threads { display: flex; flex-direction: column; gap: var(--space-2); }
  .threads-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
  .list { margin: 0; padding: var(--space-1) 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); list-style: none; }
  .thread { display: grid; grid-template-columns: 8px minmax(0, 1fr) minmax(0, 9rem) 4rem 3rem; align-items: center; gap: var(--space-3); min-height: 32px; margin: 0 var(--space-1); padding: 0 var(--space-2); border-radius: 8px; color: var(--text-standard); text-decoration: none; }
  .thread:hover { background: var(--affordance-ghost-hover); }
  .thread:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .thread .name { overflow: hidden; font: var(--text-body-sm); text-overflow: ellipsis; white-space: nowrap; }
  .meta { overflow: hidden; color: var(--text-subtle); font: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .meta.num { color: var(--text-subtle); }
  @container (width < 560px) { .thread { grid-template-columns: 8px minmax(0, 1fr) 3rem; } .thread .meta:not(:last-child) { display: none; } }
  .none { margin: 0; padding: var(--space-2) 0; color: var(--text-subtle); font: var(--text-body-sm); }
</style>
