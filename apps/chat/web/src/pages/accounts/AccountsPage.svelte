<script lang="ts">
  import { agents, conversations, jobs } from "$lib/api";
  import type { AccountAction, AccountLogin as Login, AccountsView, PoolAccount, PoolPriority, UsageRefresh, UsageRefreshAccount } from "$lib/api/shared/types.ts";
  import { POOL_PRIORITIES } from "$lib/api/shared/types.ts";
  import { tick } from "svelte";
  import { hrefFor, router } from "$lib/router.svelte";
  import { Button, Dialog, EmptyState, IconButton, Input, LoadingText, Menu, Page, PanelHeader, Picker, Tabs, toast, tooltip, type MenuEntry, type PickerItem } from "$lib/ui";
  import AccountLogin from "./AccountLogin.svelte";
  import AccountRow from "./AccountRow.svelte";
  import NoModelRoom from "./NoModelRoom.svelte";
  import PoolMeters from "./PoolMeters.svelte";
  import { accountsApi } from "./api";
  import {
    accountState, isManualAccount, pendingReset, POOL_PRIORITY_HINT, POOL_PRIORITY_LABEL, PROVIDER_LABEL, PROVIDER_SLUG, providerFromSlug, resetConfirm, resolutionSentence, sortedRows,
    threadProvider, usableGrant, windowColumns, type ProviderId,
  } from "./model";

  /**
   * Settings > Accounts: pi-pool's Claude and Codex accounts with every action the old Prime chat had (legacy AccountsSettings.svelte).
   * `#/settings/accounts?thread=<id>` opens it for one thread: its sentence, its pool class, Auto, and Use in this thread on each row.
   */
  type Confirm = { title: string; body: string; label: string; action: AccountAction; danger?: boolean; typed?: string };

  const thread = $derived(router.route.params.thread || null);
  /** The thread's name and model, from the agent, job or DM that holds it. */
  const threadInfo = $derived.by(() => {
    if (!thread) return null;
    const conversation = conversations.byId(thread as never);
    const agentId = conversation?.agent ?? thread;
    const agent = agents.byId(agentId as never) ?? jobs.byId(agentId as never);
    return { name: agent?.name ?? conversation?.name ?? thread, model: agent?.model ?? null };
  });
  const modelId = $derived(threadInfo?.model?.id ?? null);

  let view = $state<AccountsView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  /** The provider the route names, `#/settings/accounts/claude` or `#/settings/accounts/codex`. With none, the page follows the thread's model. */
  const tab = $derived(providerFromSlug(router.route.rest[1]));
  const providerHref = (provider: ProviderId) => hrefFor("settings", ["accounts", PROVIDER_SLUG[provider]], { thread });
  const showProvider = (provider: ProviderId) => router.navigate(providerHref(provider), { replace: true });
  let acting = $state<string | null>(null);
  let confirm = $state<Confirm | null>(null);
  let confirmOpen = $state(false);
  let typed = $state("");
  let menu = $state<{ row: PoolAccount; anchor: HTMLElement } | null>(null);
  let menuOpen = $state(false);
  let priorityAnchor = $state<HTMLElement>();
  let priorityOpen = $state(false);
  let notice = $state<string | null>(null);
  let now = $state(Date.now());
  let login = $state<Login | null>(null);
  /** The login this page started or saw running. An ended login from an earlier visit stays hidden. */
  let watched = $state<string | null>(null);
  /** The latest usage refresh per provider, from the server. */
  let refreshes = $state<Partial<Record<ProviderId, UsageRefresh>>>({});
  /** Refresh runs this page started or saw running. A run that ended before the page opened stays hidden. */
  let watchedRefreshes = $state<string[]>([]);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let loginCard = $state<HTMLElement>();
  let request = 0;

  const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));
  const running = (entry: Login | null): boolean => entry !== null && (entry.status === "starting" || entry.status === "waiting" || entry.status === "finishing");
  const settled = (run: UsageRefresh | undefined): number => (run ? run.accounts.filter(entry => entry.state === "read" || entry.state === "failed").length : 0);

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** `quiet` keeps the table at full opacity, as a refresh reloads it after every read. */
  async function load(fresh = false, quiet = false): Promise<void> {
    const id = ++request;
    if (!quiet) loading = true;
    try {
      const result = await accountsApi.view({ thread, model: modelId, fresh });
      if (id !== request) return;
      view = result;
      error = null;
    } catch (caught) {
      if (id === request) error = message(caught);
    } finally {
      if (id === request) loading = false;
    }
  }
  $effect(() => {
    void thread;
    void modelId;
    void load();
  });

  /** Reload the table shortly after a read lands, at most once per 700 ms, without dimming it. */
  function reloadSoon(): void {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void load(true, true);
    }, 700);
  }
  $effect(() => () => {
    if (reloadTimer) clearTimeout(reloadTimer);
  });

  function applyLogin(next: Login | null): void {
    const previous = login;
    login = next;
    if (!next) return;
    if (running(next)) watched = next.id;
    if (next.id === watched && previous?.status !== "done" && next.status === "done") {
      showProvider(next.provider);
      void load(true);
    }
  }
  function applyRefresh(next: UsageRefresh): void {
    const previous = refreshes[next.provider];
    refreshes = { ...refreshes, [next.provider]: next };
    if (next.status === "running" && !watchedRefreshes.includes(next.id)) watchedRefreshes = [...watchedRefreshes, next.id];
    if (watchedRefreshes.includes(next.id) && (settled(next) > (previous?.id === next.id ? settled(previous) : 0) || next.status !== "running")) reloadSoon();
  }
  async function poll(): Promise<void> {
    const [nextLogin, nextRefreshes] = await Promise.all([accountsApi.login().catch(() => login), accountsApi.refreshes().catch(() => [])]);
    applyLogin(nextLogin);
    for (const run of nextRefreshes) applyRefresh(run);
  }
  $effect(() => void poll());
  /** The server pushes nothing for a login or a usage read, so the page asks once a second while one runs. */
  const polling = $derived(running(login) || Object.values(refreshes).some(run => run?.status === "running"));
  $effect(() => {
    if (!polling) return;
    const timer = setInterval(() => void poll(), 1000);
    return () => clearInterval(timer);
  });

  async function startRefresh(provider: ProviderId, account: string | null): Promise<void> {
    try {
      const started = await accountsApi.startRefresh(provider, account);
      if (!watchedRefreshes.includes(started.id)) watchedRefreshes = [...watchedRefreshes, started.id];
      applyRefresh(started);
    } catch (caught) {
      toast.error(message(caught));
    }
  }

  /** One line for a refresh this page watched: progress while it runs, the count read when it ends. */
  function refreshSummary(job: UsageRefresh): string {
    const total = job.accounts.length;
    const read = job.accounts.filter(entry => entry.state === "read");
    const failed = job.accounts.filter(entry => entry.state === "failed");
    const name = (entry: UsageRefreshAccount) => entry.label ?? entry.email ?? entry.id;
    if (job.status === "running") return total ? `Reading usage: ${settled(job)} of ${total} done.` : "Starting the usage read.";
    if (job.status === "failed" || !total) return `The usage read failed. ${job.message ?? ""}`.trim();
    if (job.account !== null && total === 1) return read.length ? `Read ${name(read[0]!)} just now.` : `Could not read ${name(failed[0]!)}. The reason is on its row.`;
    const head = `Read ${read.length} of ${total} accounts just now.`;
    const tail = failed.length ? ` Not read: ${failed.map(name).join(", ")}. The reasons are on their rows.` : "";
    return head + tail + (job.message ? " " + job.message : "");
  }

  async function run(action: AccountAction, key: string): Promise<void> {
    confirmOpen = false;
    acting = key;
    try {
      const result = await accountsApi.action(action);
      notice = result.notice ?? null;
      // A use or follow answers with that thread's view. Any other action answers with the whole pool, so a thread view reads again.
      if (action.action === "use" || action.action === "follow" || !thread) view = result;
      else await load(false, true);
      if (action.action === "reset") void startRefresh("anthropic", action.account);
    } catch (caught) {
      toast.error(message(caught));
    } finally {
      acting = null;
    }
  }

  async function setPriority(priority: PoolPriority): Promise<void> {
    if (!thread) return;
    acting = "priority";
    try {
      view = await accountsApi.priority(thread, priority);
    } catch (caught) {
      toast.error(message(caught));
    } finally {
      acting = null;
    }
  }

  async function startLogin(provider: ProviderId, account: string | null): Promise<void> {
    try {
      const started = await accountsApi.startLogin(provider, account);
      watched = started.id;
      login = started;
      // A row's Sign in again sits below the card, so the card comes into view.
      await tick();
      loginCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (caught) {
      toast.error(message(caught));
    }
  }

  /** The route's provider, else the thread's, else the first one, Claude, so a bare #/settings/accounts never jumps to Codex because Claude has no free account. */
  const current = $derived(view ? (view.providers.find(entry => entry.provider === tab) ?? (thread ? threadProvider(view.providers, threadInfo?.model?.provider) : view.providers[0])) : undefined);
  const resolution = $derived(current?.resolution ?? null);
  const refresh = $derived(current ? refreshes[current.provider] : undefined);
  const refreshing = $derived(refresh?.status === "running");
  const shownRefresh = $derived(refresh && watchedRefreshes.includes(refresh.id) ? refresh : null);
  const shownLogin = $derived(login && (running(login) || login.id === watched) ? login : null);
  const columns = $derived(current ? windowColumns(current.rows) : []);
  const rows = $derived(current ? sortedRows(current) : []);
  /** One tab per provider, each counting its accounts. */
  const providerTabs = $derived((view?.providers ?? []).map(entry => ({ id: entry.provider, label: PROVIDER_LABEL[entry.provider], badge: entry.rows.length, href: providerHref(entry.provider) })));
  const priorityItems: PickerItem[] = POOL_PRIORITIES.map(level => ({ id: level, label: POOL_PRIORITY_LABEL[level] }));
  const waiting = $derived(Boolean(thread && current && (current.wait || !resolution?.email)));

  function ask(next: Confirm): void {
    typed = "";
    confirm = next;
    confirmOpen = true;
  }
  const askPin = (provider: ProviderId, row: PoolAccount) => ask({
    title: `Pin ${row.label} for all sessions?`, label: "Pin", action: { action: "pin", provider, account: row.id },
    body: `Every ${PROVIDER_LABEL[provider]} session without its own choice stays on this account until you unpin it. If it cannot serve, the session reports its error and does not switch accounts.`,
  });
  const askUnpin = (provider: ProviderId) => ask({ title: `Unpin ${PROVIDER_LABEL[provider]}?`, body: "Sessions go back to the pool's own choice.", label: "Unpin", action: { action: "unpin", provider } });
  const askRecheck = (provider: ProviderId, row: PoolAccount) => ask({
    title: "Check refused accounts again?", label: "Check again", action: { action: "recheck", provider },
    body: `${row.cooldownReason ? `${row.label} was refused: ${row.cooldownReason.replace(/\.$/, "")}. ` : ""}The pool sends one free request per Claude account, and a one-token message to an account that needs terms. An account the API accepts again returns to the pool. One it refuses cools down for 24 hours.`,
  });
  const askRemove = (provider: ProviderId, row: PoolAccount) => ask({
    title: `Remove ${row.label}?`, label: "Remove", danger: true, typed: row.label, action: { action: "remove", provider, account: row.id },
    body: "This deletes its sign-in and drops its pins. To use it again, add it again.",
  });
  function askReset(row: PoolAccount): void {
    const text = resetConfirm(row, now);
    if (text) ask({ title: text.title, body: text.body, label: text.label, action: { action: "reset", provider: "anthropic", account: row.id, grant: text.grant } });
  }
  const actionKey = (action: AccountAction): string => ("account" in action && action.account ? action.account : action.action);
  const pickable = (row: PoolAccount): boolean => thread !== null && current !== undefined && !isManualAccount(current, row.id) && acting === null;
  function useForThread(row: PoolAccount): void {
    if (thread && current && pickable(row)) void run({ action: "use", provider: current.provider, account: row.id, id: thread }, row.id);
  }
  const confirmReady = $derived(Boolean(confirm && (!confirm.typed || typed.trim() === confirm.typed)));
  function submitConfirm(event: SubmitEvent): void {
    event.preventDefault();
    if (confirm && confirmReady) void run(confirm.action, actionKey(confirm.action));
  }

  /** The More menu of one row: actions 19 to 28 of FEATURES.md and Use in this thread. */
  const menuItems = $derived.by((): MenuEntry[] => {
    if (!menu || !current) return [];
    const row = menu.row;
    const provider = current.provider;
    const state = accountState(row);
    const claude = provider === "anthropic";
    const resetable = claude && !row.disabled && (pendingReset(row.resets, now) || usableGrant(row.resets, now));
    const items: (MenuEntry | false)[] = [
      pickable(row) && { id: "use", label: "Use in this thread", onselect: () => useForThread(row) },
      { id: "refresh", label: "Refresh usage", icon: "refresh", disabled: refreshing, onselect: () => void startRefresh(provider, row.id) },
      current.poolPin === row.id
        ? { id: "unpin", label: "Unpin for all sessions", icon: "pin", onselect: () => askUnpin(provider) }
        : { id: "pin", label: "Pin for all sessions", icon: "pin", onselect: () => askPin(provider, row) },
      !!resetable && { id: "reset", label: pendingReset(row.resets, now) ? "Retry the reset" : "Use a reset", onselect: () => askReset(row) },
      claude && !row.disabled && { id: "resets", label: "Check resets", disabled: acting !== null, onselect: () => void run({ action: "resets", provider, account: row.id }, row.id) },
      claude && !row.disabled && (state === "refused" || state === "cooldown" || state === "needs-terms") && { id: "recheck", label: "Check again", onselect: () => askRecheck(provider, row) },
      { id: "login", label: "Sign in again", icon: "user", disabled: running(login), onselect: () => void startLogin(provider, row.id) },
      row.disabled
        ? { id: "enable", label: "Turn on", onselect: () => void run({ action: "enable", provider, account: row.id }, row.id) }
        : { id: "disable", label: "Turn off", onselect: () => void run({ action: "disable", provider, account: row.id }, row.id) },
      { type: "separator" },
      { id: "remove", label: "Remove", icon: "trash", tone: "danger", onselect: () => askRemove(provider, row) },
    ];
    return items.filter((item): item is MenuEntry => item !== false);
  });
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Accounts" icon="users" level={1}>
      {#snippet actions()}
        <IconButton icon="refresh" label="Read the pool again" size="sm" loading={loading} onclick={() => void load(true)} />
      {/snippet}
    </PanelHeader>
  {/snippet}

  {#if error && !view}
    <div title={error}>
      <EmptyState icon="warning" title="Accounts unavailable" description="The pool did not answer.">
        {#snippet action()}<Button variant="outline" size="sm" {loading} onclick={() => void load(true)}>Retry</Button>{/snippet}
      </EmptyState>
    </div>
  {:else if !view || !current}
    <LoadingText text="Loading accounts" delay={300} spinner />
  {:else}
    <div class="body" data-testid="accounts-page">
      <div class="toolbar">
        <Tabs items={providerTabs} value={current.provider} variant="underline" size="sm" label="Account providers" />
        <span class="spacer"></span>
        {#if current.provider === "anthropic"}
          <span use:tooltip={"Read every Claude account's banked usage-limit resets. Spends nothing."}>
            <Button size="sm" variant="ghost" disabled={acting !== null} loading={acting === "resets"} onclick={() => void run({ action: "resets", provider: current.provider }, "resets")}>
              {acting === "resets" ? "Checking resets" : "Check resets"}
            </Button>
          </span>
        {/if}
        <span use:tooltip={`Read usage for every ${PROVIDER_LABEL[current.provider]} account now`}>
          <Button size="sm" variant="ghost" icon={refreshing ? undefined : "refresh"} loading={refreshing} disabled={refreshing} data-testid="refresh-all"
            onclick={() => void startRefresh(current.provider, null)}>
            {refreshing ? (refresh?.accounts.length ? `Reading ${settled(refresh)} of ${refresh.accounts.length}` : "Reading") : "Refresh all"}
          </Button>
        </span>
        <Button size="sm" variant="outline" icon="plus" disabled={running(login)} aria-label="Add {PROVIDER_LABEL[current.provider]} account"
          onclick={() => void startLogin(current.provider, null)}>Add account</Button>
      </div>

      <PoolMeters {view} provider={current} {now} />

      {#if thread}
        <div class="thread" class:warning={waiting} data-testid="accounts-thread">
          <span class="for">{threadInfo?.name ?? thread}</span>
          <span class="sentence" data-testid="resolution">{resolutionSentence(current, now)}</span>
          <span class="spacer"></span>
          {#if view.priority}
            <span use:tooltip={POOL_PRIORITY_HINT}>
              <Button bind:element={priorityAnchor} size="sm" variant="ghost" trailingIcon="chevron-down" loading={acting === "priority"}
                aria-haspopup="listbox" aria-expanded={priorityOpen} onclick={() => (priorityOpen = !priorityOpen)}>{POOL_PRIORITY_LABEL[view.priority]}</Button>
            </span>
          {/if}
          <Button size="sm" variant="outline" aria-pressed={resolution?.selection.mode === "auto"} disabled={acting !== null || resolution?.selection.mode === "auto"}
            loading={acting === "follow"} onclick={() => thread && void run({ action: "follow", provider: current.provider, id: thread }, "follow")}>
            {current.poolPin ? "Auto (pool override active)" : "Auto"}
          </Button>
          <IconButton icon="close" label="Show the whole pool" size="sm" onclick={() => router.setParams({ thread: null })} />
        </div>
      {/if}

      {#if shownLogin}
        <div bind:this={loginCard}>
          <AccountLogin login={shownLogin} account={view.providers.flatMap(entry => entry.rows).find(row => row.id === shownLogin.account)?.label}
          onchange={next => applyLogin(next)} onclose={() => (watched = null)} onretry={() => shownLogin && void startLogin(shownLogin.provider, shownLogin.account)} />
        </div>
      {/if}

      {#if shownRefresh && shownRefresh.status !== "running"}
        <div class="notice" class:failed={shownRefresh.status === "failed"} role="status" aria-live="polite" data-testid="refresh-summary">
          <span>{refreshSummary(shownRefresh)}</span>
          <IconButton icon="close" label="Dismiss" size="xs" onclick={() => (watchedRefreshes = watchedRefreshes.filter(id => id !== shownRefresh?.id))} />
        </div>
      {/if}
      {#if notice}
        <div class="notice" role="status" data-testid="action-notice">
          <span>{notice}</span>
          <IconButton icon="close" label="Dismiss" size="xs" onclick={() => (notice = null)} />
        </div>
      {/if}
      {#if error}<div class="notice failed" title={error}><span>The last read of the pool failed, so the table may be old.</span></div>{/if}

      {#if current.error && !current.rows.length}
        <p class="problem" title={current.error}>The {PROVIDER_LABEL[current.provider]} pool did not answer.</p>
      {:else if !current.rows.length}
        <EmptyState icon="users" size="sm" title="No {PROVIDER_LABEL[current.provider]} accounts yet" />
      {:else}
        <div class="frame">
          <div class="table" role="table" aria-label="{PROVIDER_LABEL[current.provider]} accounts" style:--windows={columns.length} class:busy={loading}
            class:no-threads={!current.rows.some(row => row.sessions)}>
            <div class="head" role="row">
              <span role="columnheader">Account</span>
              <span role="columnheader" class="plan">Plan</span>
              <span role="columnheader" class="threads">Threads</span>
              {#each columns as column (column)}<span role="columnheader">{column}</span>{/each}
              <span role="columnheader">Status</span>
              <span role="columnheader" class="sr-only">Actions</span>
            </div>
            {#each rows as row (row.id)}
              <AccountRow {row} provider={current} {columns} {now} {thread} read={shownRefresh?.accounts.find(entry => entry.id === row.id)} {refreshing}
                busy={acting === row.id} locked={acting !== null} loginRunning={running(login)} poolConfig={view.poolConfig} menuOpen={menuOpen && menu?.row.id === row.id}
                onuse={() => useForThread(row)} onrefresh={() => void startRefresh(current.provider, row.id)} onreset={() => askReset(row)}
                onenable={() => void run({ action: "enable", provider: current.provider, account: row.id }, row.id)}
                onlogin={() => void startLogin(current.provider, row.id)}
                onmore={anchor => {
                  const same = menuOpen && menu?.row.id === row.id;
                  menu = { row, anchor };
                  menuOpen = !same;
                }} />
            {/each}
          </div>
        </div>
      {/if}
      <NoModelRoom />
    </div>
  {/if}
</Page>

<Menu bind:open={menuOpen} anchor={menu?.anchor} items={menuItems} placement="bottom-end" width={220} label={menu ? `Actions for ${menu.row.label}` : "Actions"} />

<Picker bind:open={priorityOpen} anchor={priorityAnchor} items={priorityItems} value={view?.priority ?? null} searchable={false} width={220} label="Pool class"
  onselect={id => {
    priorityOpen = false;
    void setPriority(id as PoolPriority);
  }} />

<Dialog bind:open={confirmOpen} title={confirm?.title} width={440} dirty={typed !== ""}>
  {#if confirm}
    <form id="account-confirm" class="confirm" onsubmit={submitConfirm}>
      <p>{confirm.body}</p>
      {#if confirm.typed}
        <label class="typed">
          <span>Type <strong>{confirm.typed}</strong> to confirm.</span>
          <Input bind:value={typed} size="sm" autocomplete="off" spellcheck="false" data-autofocus aria-label="Type {confirm.typed} to confirm" />
        </label>
      {/if}
    </form>
  {/if}
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button type="submit" form="account-confirm" variant={confirm?.danger ? "danger" : "primary"} size="sm" disabled={!confirmReady}>{confirm?.label}</Button>
  {/snippet}
</Dialog>

<style>
  .body { display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-8); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-1); border-bottom: 1px solid var(--border-standard); }
  .toolbar :global(.tabs.underline) { border-bottom: 0; }
  .toolbar > :global(:not(.tabs)) { margin-bottom: var(--space-1); }
  .spacer { flex: 1; }
  .thread { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); color: var(--text-standard); font: var(--text-body-sm); }
  .for { color: var(--text-subtle); }
  .for::after { content: "·"; margin-left: var(--space-2); }
  .sentence { min-width: 0; }
  .thread.warning .sentence { color: var(--text-danger); }
  .notice {
    display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-1) 0 var(--space-3);
    border-radius: var(--radius-row); background: var(--surface-inset); color: var(--text-subtle); font: var(--text-body-sm);
  }
  .notice span { flex: 1; overflow-wrap: anywhere; }
  .notice.failed, .problem { color: var(--text-danger); }
  .problem { margin: var(--space-4) 0; font: var(--text-body-sm); }
  .frame { container-type: inline-size; }
  .table {
    --cols: minmax(11rem, 3fr) auto auto repeat(var(--windows), minmax(6.5rem, 1fr)) minmax(6rem, auto) auto;
    display: grid; grid-template-columns: var(--cols); column-gap: var(--space-4);
  }
  .table.no-threads { --cols: minmax(11rem, 3fr) auto repeat(var(--windows), minmax(6.5rem, 1fr)) minmax(6rem, auto) auto; }
  .table.no-threads .threads, .table.no-threads :global(.row > .threads) { display: none; }
  .table.busy { opacity: 0.7; }
  .head {
    display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: end; column-gap: inherit; padding: 0 var(--space-2) var(--space-1-5) var(--space-3);
    color: var(--text-subtle); font: var(--text-caption);
  }
  /* Narrow: plan and threads go, and each meter stacks its percent, bar and time left so no number is cut. */
  @container (max-width: 46rem) {
    .table, .table.no-threads { --cols: minmax(8rem, 2fr) repeat(var(--windows), minmax(3.5rem, 1fr)) auto auto; column-gap: var(--space-3); }
    .head .plan, .head .threads, .table :global(.row > .plan), .table :global(.row > .threads) { display: none; }
    .table :global(.row .nums) { display: contents; }
    .table :global(.row .cell) { padding: var(--space-1-5) 0; }
    .table :global(.row .cell .meter) { order: 1; }
    .table :global(.row .cell .reset) { order: 2; }
    .table :global(.row .actions > :not(:last-child)) { display: none; }
  }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .confirm { display: flex; flex-direction: column; gap: var(--space-3); }
  .confirm p { margin: 0; color: var(--text-subtle); font: var(--text-body); }
  .typed { display: flex; flex-direction: column; gap: var(--space-1-5); color: var(--text-subtle); font: var(--text-body-sm); }
  .typed strong { color: var(--text-standard); font-weight: 500; overflow-wrap: anywhere; }
</style>
