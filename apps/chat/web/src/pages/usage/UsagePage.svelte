<script lang="ts">
  import { api, type AccountsView, type UsageReport } from "$lib/api";
  import { hrefFor, router } from "$lib/router.svelte";
  import { Avatar, Button, CardGroup, EmptyState, Icon, IconButton, LoadingText, Page, PageHeader, PanelHeader, Select } from "$lib/ui";
  import DailyCostChart from "./DailyCostChart.svelte";
  import PoolCard from "./PoolCard.svelte";
  import { cost, count, exactCost, full, percent } from "./format";
  import { cacheHit, KIND_LABEL, KINDS, modelName, modelsByCost, seriesOf, summarize } from "./stats";

  /**
   * Usage: what every chat spent, from pi-host's own usage rows, with each token kind priced apart (c157) and every count exact (c191),
   * plus the account pool. The period and the chat and host filters live in the URL, as #/settings/usage?days=7&thread=<id>&host=<box>.
   */
  const PERIODS = ["1", "7", "30", "90"] as const;
  type Period = (typeof PERIODS)[number];
  const PERIOD_LABEL: Record<Period, string> = { "1": "Today", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" };
  const ALL = "all";
  const REFRESH_MS = 60_000;

  const params = $derived(router.route.params);
  const period = $derived<Period>(PERIODS.includes(params.days as Period) ? (params.days as Period) : "30");
  const thread = $derived(params.thread ?? ALL);
  const host = $derived(params.host ?? ALL);

  let report = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let pool = $state<AccountsView | null>(null);
  let poolError = $state<string | null>(null);
  /** Every chat and host seen in a report, so a filter keeps its other choices. */
  let chats = $state<Record<string, string>>({});
  let hosts = $state<string[]>([]);
  let request = 0;

  const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

  async function load(): Promise<void> {
    const id = ++request;
    loading = true;
    const filters = { days: Number(period), ...(thread === ALL ? {} : { thread }), ...(host === ALL ? {} : { host }) };
    try {
      const next = await api.usage(filters);
      if (id !== request) return;
      report = next;
      error = null;
      const seen = { ...chats };
      for (const row of next.rows) seen[row.thread] = row.threadName;
      chats = seen;
      hosts = [...new Set([...hosts, ...next.rows.map(row => row.host)])].sort();
    } catch (reason) {
      if (id === request) error = message(reason);
    } finally {
      if (id === request) loading = false;
    }
  }
  async function loadPool(): Promise<void> {
    try {
      pool = await api.pool();
      poolError = null;
    } catch (reason) {
      poolError = message(reason);
    }
  }
  function refresh(): void {
    void load();
    void loadPool();
  }

  $effect(() => {
    void period;
    void thread;
    void host;
    void load();
  });
  $effect(() => {
    void loadPool();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const setFilter = (key: "days" | "thread" | "host", value: string) => router.setParams({ [key]: value === ALL ? null : value }, { replace: true });

  const summary = $derived(report ? summarize(report.rows) : null);
  const total = $derived(summary?.total ?? null);
  const series = $derived(report ? seriesOf(modelsByCost(report.days)) : []);
  const periodText = $derived(period === "1" ? "today" : `the last ${period} days`);
  const change = $derived.by(() => {
    if (!report || !total || !report.previous.complete || report.previous.cost <= 0) return null;
    return (total.cost.total - report.previous.cost) / report.previous.cost;
  });
  const hit = $derived(total ? cacheHit(total.tokens) : null);
  const top = $derived(summary?.chats[0] ?? null);
  const maxChat = $derived(Math.max(0, ...(summary?.chats ?? []).map(chat => chat.cost.total)));
  const chatOptions = $derived([{ value: ALL, label: "All chats" }, ...Object.entries(chats).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))]);
  const hostOptions = $derived([{ value: ALL, label: "All hosts" }, ...hosts.map(value => ({ value, label: value }))]);
  const kindTitle = (tokens: number, usd: number) => `${full(tokens)} tokens, ${exactCost(usd)}`;
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Usage" icon="chart-bar" level={1}>
      {#snippet actions()}
        <IconButton icon="refresh" label="Refresh usage" size="sm" {loading} onclick={refresh} />
      {/snippet}
    </PanelHeader>
  {/snippet}

  {#if !report && error}
    <EmptyState icon="chart-bar" title="Usage isn't available" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" {loading} onclick={refresh}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !report || !summary || !total}
    <LoadingText text="Reading usage…" />
  {:else}
    <div class="filters" data-testid="usage-filters">
      <Select label="Period" size="sm" value={period} options={PERIODS.map(value => ({ value, label: PERIOD_LABEL[value] }))} onchange={value => setFilter("days", value)} />
      {#if chatOptions.length > 2}
        <Select label="Chat" size="sm" value={thread} options={chatOptions} onchange={value => setFilter("thread", value)} />
      {/if}
      {#if hostOptions.length > 2}
        <Select label="Host" size="sm" value={host} options={hostOptions} onchange={value => setFilter("host", value)} />
      {/if}
    </div>
    {#if error}
      <p class="notice" role="status">Couldn't read the latest usage: {error.replace(/\.$/, "")}. Showing what was read before. <Button variant="ghost" size="sm" {loading} onclick={refresh}>Try again</Button></p>
    {/if}

    {#if !report.rows.length}
      <EmptyState icon="chart-bar" title="No usage in this period" description="No chat ran a model call in {periodText}. Choose a longer period or another chat." />
    {:else}
      <p class="summary" data-testid="usage-summary">
        {#if summary.chats.length === 1 && top}
          <b>{top.name}</b> ran <b>{full(total.turns)} {total.turns === 1 ? "turn" : "turns"}</b>
        {:else}
          Your <b>{summary.chats.length} chats</b> ran <b>{full(total.turns)} {total.turns === 1 ? "turn" : "turns"}</b>
        {/if}
        {#if summary.models.length > 1}on <b>{summary.models.length} models</b>{/if}
        in {periodText}.
        {#if top && summary.chats.length > 1 && total.cost.total > 0}
          <b>{top.name}</b> accounts for <b>{percent(top.cost.total / total.cost.total)}</b> of the cost{#if top.model}, mostly on <b>{modelName(top.model)}</b>{/if}.
        {/if}
      </p>

      <section class="hero" aria-label="Cost">
        <p class="caption">Cost · {period === "1" ? "today" : `last ${period} days`}</p>
        <p class="hero-value" data-testid="usage-cost" title={exactCost(total.cost.total)}>{cost(total.cost.total)}</p>
        <p class="meta">
          {#if change !== null}
            {#if Math.abs(change) < 0.005}
              <span>No change from the {period === "1" ? "day" : `${period} days`} before</span>
            {:else}
              <span class="delta"><Icon name={change > 0 ? "arrow-up" : "arrow-down"} size={14} />{percent(Math.abs(change))} {change > 0 ? "more" : "less"} than the {period === "1" ? "day" : `${period} days`} before</span>
            {/if}
          {/if}
          {#if period !== "1"}<span>{cost(total.cost.total / Number(period))} a day</span>{/if}
        </p>
        <p class="footnote" role="note">
          <Icon name="info" size={14} />
          Summed from every model call pi-host recorded, at list prices, with cache reads and cache writes priced apart from fresh input.
        </p>
      </section>

      <div class="tiles">
        <div class="tile">
          <p class="caption">Tokens</p>
          <p class="tile-value" data-testid="usage-tokens" title="{full(total.tokens.input + total.tokens.output + total.tokens.cacheRead + total.tokens.cacheWrite)} tokens">{count(total.tokens.input + total.tokens.output + total.tokens.cacheRead + total.tokens.cacheWrite)}</p>
          <p class="caption" title="{full(total.tokens.output)} output tokens">{count(total.tokens.output)} output</p>
        </div>
        <div class="tile">
          <p class="caption">Cache hit rate</p>
          <p class="tile-value">{hit === null ? "—" : percent(hit)}</p>
          <p class="caption">Prompt tokens read from cache</p>
        </div>
        <div class="tile">
          <p class="caption">Turns</p>
          <p class="tile-value" data-testid="usage-turns">{full(total.turns)}</p>
          <p class="caption">In {summary.chats.length} {summary.chats.length === 1 ? "chat" : "chats"}</p>
        </div>
        <div class="tile">
          <p class="caption">Cache reads</p>
          <p class="tile-value" title={exactCost(total.cost.cacheRead)}>{cost(total.cost.cacheRead)}</p>
          <p class="caption" title="{full(total.tokens.cacheRead)} tokens">{count(total.tokens.cacheRead)} tokens at the cache rate</p>
        </div>
      </div>

      <CardGroup title="Cost by token kind" description="Each kind at its own rate, so the shared prompt read from cache never counts as fresh input.">
        <div class="kind head" aria-hidden="true"><span>Kind</span><span class="num">Tokens</span><span class="num">Share of cost</span><span class="num">Cost</span></div>
        {#each KINDS as kind (kind)}
          <div class="kind" data-testid="usage-kind-{kind}" title={kindTitle(total.tokens[kind], total.cost[kind])}>
            <span>{KIND_LABEL[kind]}</span>
            <span class="num">{full(total.tokens[kind])}</span>
            <span class="num">{total.cost.total > 0 ? percent(total.cost[kind] / total.cost.total) : "—"}</span>
            <span class="num">{cost(total.cost[kind])}</span>
          </div>
        {/each}
      </CardGroup>

      <section class="section">
        <PageHeader title="Daily cost" size="section" />
        <DailyCostChart days={report.days} {series} />
      </section>
    {/if}


    {#if report.rows.length}
      <div class="columns">
        <section class="section">
          <PageHeader title="By chat" size="section" />
          <ul class="list" data-testid="usage-by-chat">
            {#each summary.chats as chat (chat.thread)}
              <li>
                <a class="chat-row" href={hrefFor("messages", [chat.thread])} title="{chat.name}, {full(chat.turns)} turns, {exactCost(chat.cost.total)}. Open chat">
                  <Avatar name={chat.name} seed={chat.thread} kind="agent" size={24} />
                  <span class="row-text">
                    <span class="name">{chat.name}</span>
                    <span class="caption">{[modelName(chat.model), chat.host, `${full(chat.turns)} ${chat.turns === 1 ? "turn" : "turns"}`].join(" · ")}</span>
                    <span class="track" aria-hidden="true"><span class="bar" style:width="{maxChat ? (chat.cost.total / maxChat) * 100 : 0}%"></span></span>
                  </span>
                  <span class="value">{cost(chat.cost.total)}</span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
        <section class="section">
          <PageHeader title="By model" size="section" />
          <ul class="list" data-testid="usage-by-model">
            {#each summary.models as model (model.model)}
              <li class="model-row" title={model.model}>
                <span class="row-text">
                  <span class="name">{modelName(model.model)}</span>
                  <span class="caption">{full(model.turns)} {model.turns === 1 ? "turn" : "turns"} · {full(model.tokens.input + model.tokens.output + model.tokens.cacheRead + model.tokens.cacheWrite)} tokens · {full(model.tokens.output)} output</span>
                </span>
                <span class="value" title={exactCost(model.cost.total)}>{cost(model.cost.total)}</span>
              </li>
            {/each}
          </ul>
        </section>
      </div>
    {/if}
    {#if pool}
      {#each pool.providers.filter(provider => provider.rows.length) as provider (provider.provider)}
        <PoolCard {provider} view={pool} />
      {/each}
    {:else if poolError}
      <p class="notice" role="status">Couldn't read the account pool: {poolError.replace(/\.$/, "")}. <Button variant="ghost" size="sm" onclick={() => void loadPool()}>Try again</Button></p>
    {/if}
  {/if}
</Page>

<style>
  .filters { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-subtle); font: var(--text-body); }
  .summary { max-width: 44rem; margin: 0; color: var(--text-subtle); font: var(--text-body-lg); letter-spacing: var(--tracking-body-lg); text-wrap: pretty; }
  .summary b { color: var(--text-standard); font-weight: 500; }
  .hero { display: flex; flex-direction: column; gap: var(--space-1); }
  .hero p, .tile p { margin: 0; }
  .caption { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .hero-value { color: var(--text-standard); font: var(--text-display); letter-spacing: var(--tracking-display); font-variant-numeric: tabular-nums; }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); color: var(--text-subtle); font: var(--text-body); }
  .delta { display: inline-flex; align-items: center; gap: var(--space-1); }
  .footnote { display: flex; gap: var(--space-1); color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .footnote :global(svg) { flex-shrink: 0; height: 16px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--space-4); }
  .tile { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4); border: 1px solid var(--border-standard); border-radius: var(--radius-container); }
  .tile-value { color: var(--text-standard); font: var(--text-heading); letter-spacing: var(--tracking-heading); font-variant-numeric: tabular-nums; }
  .kind { display: grid; grid-template-columns: minmax(0, 1fr) 10rem 8rem 7rem; gap: var(--space-4); padding: var(--space-3) var(--space-4); font: var(--text-body); font-variant-numeric: tabular-nums; }
  .kind.head { padding-block: var(--space-2); color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .num { text-align: right; }
  .section { display: flex; min-width: 0; flex-direction: column; gap: var(--space-3); }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: var(--space-8); }
  .list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
  .chat-row, .model-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-2); margin-inline: calc(-1 * var(--space-2)); border-radius: var(--radius-row); color: inherit; text-decoration: none; }
  .chat-row:hover { background: var(--affordance-subtle); }
  .row-text { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: var(--space-1); }
  .name { overflow: hidden; color: var(--text-standard); font: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
  .row-text .caption { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { display: block; margin-top: var(--space-1); height: 4px; }
  .bar { display: block; min-width: 4px; height: 100%; border-radius: 0 2px 2px 0; background: var(--chart-series-1); }
  .value { color: var(--text-standard); font: var(--text-body); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
