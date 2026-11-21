<script lang="ts">
  import { agents, api, type AccountsView, type UsageBucket, type UsageRange, type UsageReport } from "$lib/api";
  import { bucketFor, isRange, RANGE_BUCKETS, USAGE_RANGES } from "$lib/api/shared/usage-range";
  import { hrefFor, router } from "$lib/router.svelte";
  import { Avatar, Button, CardGroup, EmptyState, IconButton, LoadingText, Page, PageHeader, PanelHeader, Select, Tabs } from "$lib/ui";
  import PoolCard from "./PoolCard.svelte";
  import TpsCard from "./TpsCard.svelte";
  import UsageChart from "./UsageChart.svelte";
  import { chartFormat, cost, count, exactCost, full, percent, type TipRow } from "./format";
  import { bucketValue, cacheHit, cellsOf, KIND_LABEL, KINDS, METRIC_LABEL, modelName, modelsByCost, seriesOf, summarize, tokenSum, type Measure, type Metric, type Unit } from "./stats";

  /**
   * Usage: what every chat spent, from pi-host's own usage rows, with each token kind priced apart (c157) and every count exact (c191),
   * plus the account pool. The chart comes first, grouped by minute, hour or day over a range, as Prime's chat Usage page draws it (owner
   * p132). The chart counts dollars or tokens, all of them or output only (owner p162). The unit, the token kind, the range, the grouping and
   * the chat and host filters live in the URL, as #/settings/usage?unit=tokens&metric=output&range=7d&by=hour&thread=<id>&host=<box>.
   */
  const RANGE_LABEL: Record<UsageRange, string> = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days" };
  const BUCKET_LABEL: Record<UsageBucket, string> = { minute: "Minute", hour: "Hour", day: "Day" };
  const BUCKETS: readonly UsageBucket[] = ["minute", "hour", "day"];
  const UNIT_ITEMS: { id: Unit; label: string }[] = [{ id: "usd", label: "$" }, { id: "tokens", label: "Tokens" }];
  const METRIC_ITEMS: { id: Metric; label: string }[] = [{ id: "total", label: METRIC_LABEL.total }, { id: "output", label: METRIC_LABEL.output }];
  /** An old #/settings/usage?days=7 link opens the range it meant. */
  const OLD_DAYS: Record<string, UsageRange> = { "1": "24h", "7": "7d", "30": "30d", "90": "90d" };
  const ALL = "all";
  const REFRESH_MS = 60_000;
  /** The agent a pi-host thread belongs to, as its work thread or one of its comm threads, so its row shows that agent's mascot. */
  const ownerOf = (thread: string) => agents.list.find((agent) => agent.thread === thread || agent.comm?.some((comm) => comm.thread === thread));

  const params = $derived(router.route.params);
  const range = $derived<UsageRange>(isRange(params.range) ? params.range : (OLD_DAYS[params.days ?? ""] ?? "24h"));
  const bucket = $derived(bucketFor(range, params.by));
  const unit = $derived<Unit>(params.unit === "tokens" ? "tokens" : "usd");
  const metric = $derived<Metric>(params.metric === "output" ? "output" : "total");
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
    const filters = { range, bucket, ...(thread === ALL ? {} : { thread }), ...(host === ALL ? {} : { host }) };
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
    void range;
    void bucket;
    void thread;
    void host;
    void load();
  });
  $effect(() => {
    void loadPool();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const setParams = (next: Record<string, string | null>) => router.setParams({ days: null, ...next }, { replace: true });
  const setFilter = (key: "thread" | "host", value: string) => setParams({ [key]: value === ALL ? null : value });
  /** A new range keeps the grouping when it offers it, as Prime's page does not; else the range's own default. */
  const pickRange = (next: UsageRange) => setParams({ range: next, by: RANGE_BUCKETS[next].includes(bucket) ? bucket : null });
  const pickBucket = (next: UsageBucket) => setParams({ range, by: next });
  const pickUnit = (next: Unit) => setParams({ unit: next === "usd" ? null : next });
  const pickMetric = (next: Metric) => setParams({ metric: next === "total" ? null : next });

  const summary = $derived(report ? summarize(report.rows) : null);
  const total = $derived(summary?.total ?? null);
  const series = $derived(report ? seriesOf(modelsByCost(report.buckets)) : []);
  const measure = $derived<Measure>(unit === "usd" ? { unit } : { unit, metric });
  const format = $derived(chartFormat(measure));
  const cells = $derived(report ? cellsOf(report.buckets, series, measure) : []);
  /** The range's sum from the buckets, as the table under the chart sums it. */
  const chartSum = $derived(report ? report.buckets.reduce((all, entry) => all + bucketValue(entry, measure), 0) : 0);
  const chartTotal = $derived(unit === "usd" ? { text: `${cost(chartSum)} in total`, title: exactCost(chartSum) } : { text: `${count(chartSum)} ${format.label.toLowerCase()} in total`, title: full(chartSum) });
  /** The tip's rows under the split: in dollars the cache reads, in tokens the other token kind and the cost, then turns and cache hit. */
  function tipRows(index: number): TipRow[] {
    const entry = report?.buckets[index];
    if (!entry) return [];
    const hit = cacheHit(entry.tokens);
    const priced = { label: "Cost", value: cost(entry.cost.total), title: exactCost(entry.cost.total) };
    const kind = unit === "usd"
      ? [{ label: "Cache reads", value: cost(entry.cost.cacheRead), title: exactCost(entry.cost.cacheRead) }]
      : [metric === "total" ? { label: "Output", value: full(entry.tokens.output) } : { label: "All tokens", value: full(tokenSum(entry.tokens)) }, priced];
    return [...kind, { label: "Turns", value: full(entry.turns) }, { label: "Cache hit", value: hit === null ? "–" : percent(hit) }];
  }
  const maxChat = $derived(Math.max(0, ...(summary?.chats ?? []).map(chat => chat.cost.total)));
  const chatOptions = $derived([{ value: ALL, label: "All chats" }, ...Object.entries(chats).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))]);
  const hostOptions = $derived([{ value: ALL, label: "All hosts" }, ...hosts.map(value => ({ value, label: value }))]);
  const rangeItems = $derived(USAGE_RANGES.map(id => ({ id, label: id })));
  const bucketItems = $derived(BUCKETS.map(id => ({ id, label: BUCKET_LABEL[id], disabled: !RANGE_BUCKETS[range].includes(id) })));
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

  <div class="controls" role="group" aria-label="Unit, range and grouping" data-testid="usage-filters">
    <Tabs label="Unit" size="sm" items={UNIT_ITEMS} value={unit} onchange={pickUnit} />
    <Tabs label="Token kind" size="sm" items={METRIC_ITEMS} value={metric} onchange={pickMetric} />
    <Tabs label="Range" size="sm" items={rangeItems} value={range} onchange={pickRange} />
    <span class="control">
      <span class="caption" aria-hidden="true">Group by</span>
      <Tabs label="Group by" size="sm" items={bucketItems} value={bucket} onchange={pickBucket} />
    </span>
    {#if chatOptions.length > 2}
      <Select label="Chat" size="sm" value={thread} options={chatOptions} onchange={value => setFilter("thread", value)} />
    {/if}
    {#if hostOptions.length > 2}
      <Select label="Host" size="sm" value={host} options={hostOptions} onchange={value => setFilter("host", value)} />
    {/if}
  </div>

  {#if !report && error}
    <EmptyState icon="chart-bar" title="Usage isn't available" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" {loading} onclick={refresh}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !report || !summary || !total}
    <LoadingText text="Reading usage…" />
  {:else}
    {#if error}
      <p class="notice" role="status">Couldn't read the latest usage: {error.replace(/\.$/, "")}. Showing what was read before. <Button variant="ghost" size="sm" {loading} onclick={refresh}>Try again</Button></p>
    {/if}

    {#if !report.rows.length}
      <EmptyState icon="chart-bar" title="No usage in this range" description="No chat ran a model call in {RANGE_LABEL[report.range]}. Choose a longer range or another chat." />
    {:else}
      <section class="section" aria-label="{format.label} per {report.bucket}" aria-busy={loading}>
        <UsageChart buckets={report.buckets} {series} bucket={report.bucket} {cells} {format} total={chartTotal} tip={tipRows} />
      </section>
      <TpsCard {report} {series} {metric} thread={thread === ALL ? undefined : thread} host={host === ALL ? undefined : host} />

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
        <div class="kind sum" data-testid="usage-kind-total" title={kindTitle(total.tokens.input + total.tokens.output + total.tokens.cacheRead + total.tokens.cacheWrite, total.cost.total)}>
          <span>Total, {full(total.turns)} {total.turns === 1 ? "turn" : "turns"}</span>
          <span class="num">{full(total.tokens.input + total.tokens.output + total.tokens.cacheRead + total.tokens.cacheWrite)}</span>
          <span class="num">{total.cost.total > 0 ? "100%" : "—"}</span>
          <span class="num" data-testid="usage-cost">{cost(total.cost.total)}</span>
        </div>
      </CardGroup>
    {/if}


    {#if report.rows.length}
      <div class="columns">
        <section class="section">
          <PageHeader title="By chat" size="section" />
          <ul class="list" data-testid="usage-by-chat">
            {#each summary.chats as chat (chat.thread)}
              {@const owner = ownerOf(chat.thread)}
              <li>
                <a class="chat-row" href={hrefFor("messages", [chat.thread])} title="{chat.name}, {full(chat.turns)} turns, {exactCost(chat.cost.total)}. Open chat">
                  <Avatar name={chat.name} seed={owner?.id ?? chat.thread} kind="agent" size={24} />
                  <span class="row-text">
                    <span class="name">{chat.name}{#if owner && owner.thread !== chat.thread}<span class="role"> · comm thread</span>{/if}</span>
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
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); }
  .control { display: inline-flex; align-items: center; gap: var(--space-2); }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-subtle); font: var(--text-body); }
  .caption { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .kind { display: grid; grid-template-columns: minmax(0, 1fr) 10rem 8rem 7rem; gap: var(--space-4); padding: var(--space-3) var(--space-4); font: var(--text-body); font-variant-numeric: tabular-nums; }
  .kind.sum { border-top: 1px solid var(--border-standard); color: var(--text-standard); font-weight: 500; }
  .kind.head { padding-block: var(--space-2); color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .num { text-align: right; }
  .section { display: flex; min-width: 0; flex-direction: column; gap: var(--space-3); }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: var(--space-8); }
  .list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
  .chat-row, .model-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-2); margin-inline: calc(-1 * var(--space-2)); border-radius: var(--radius-row); color: inherit; text-decoration: none; }
  .chat-row:hover { background: var(--affordance-subtle); }
  .row-text { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: var(--space-1); }
  .name { overflow: hidden; color: var(--text-standard); font: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
  .role { color: var(--text-subtle); }
  .row-text .caption { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { display: block; margin-top: var(--space-1); height: 4px; }
  .bar { display: block; min-width: 4px; height: 100%; border-radius: 0 2px 2px 0; background: var(--chart-series-1); }
  .value { color: var(--text-standard); font: var(--text-body); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
