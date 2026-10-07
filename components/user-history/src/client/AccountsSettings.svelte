<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { accountState, forgetAccounts, loadAccounts, meterTone, PROVIDER_LABEL, rememberAccounts, resetText, resolutionSentence, span, staleText, STATE_LABEL, threadProvider, windowColumns, windowLabel,
    type AccountState } from "./accounts.ts";
  import type { AccountAction, AccountLogin as Login, AccountResets, AccountsView, PoolAccount, PoolProvider, ResetGrant, UsageRefresh, UsageRefreshAccount } from "../shared/types.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import Floating from "./ui/Floating.svelte";
  import AccountLogin from "./AccountLogin.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  type Provider = PoolProvider["provider"];
  type Confirm = { title: string; body: string; label: string; action: AccountAction; danger?: boolean; typed?: string };

  const threadId = $derived(store.selectedId);
  const modelProvider = $derived(threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined);
  const modelId = $derived(threadId ? store.thread(threadId)?.state?.info.model?.id ?? null : null);
  let view = $state<AccountsView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let tab = $state<Provider | null>(null);
  let acting = $state<string | null>(null);
  let confirm = $state<Confirm | null>(null);
  let typed = $state("");
  let menu = $state<{ row: PoolAccount; anchor: HTMLElement } | null>(null);
  let notice = $state<string | null>(null);
  let now = $state(Date.now());
  let login = $state<Login | null>(null);
  /** The login this page started or saw running. An ended login from an earlier visit stays hidden. */
  let watched = $state<string | null>(null);
  /** The latest usage refresh per provider, from the server. */
  let refreshes = $state<Partial<Record<Provider, UsageRefresh>>>({});
  /** Refresh runs this page started or saw running. A run that ended before the page opened stays hidden. */
  let watchedRefreshes = $state<string[]>([]);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** A tab opened on the click that started a login, so the sign-in page lands in it without a popup block. */
  let signInTab: Window | null = null;

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });

  const running = (entry: Login | null): boolean => entry !== null && (entry.status === "starting" || entry.status === "waiting" || entry.status === "finishing");
  const shownLogin = $derived(login && (running(login) || login.id === watched) ? login : null);

  $effect(() => api.loginStream(next => {
    const previous = login;
    login = next;
    if (!next) return;
    if (running(next)) watched = next.id;
    if (next.url && signInTab) {
      if (!signInTab.closed) signInTab.location.replace(next.url);
      signInTab = null;
    }
    if (!running(next)) { signInTab?.close(); signInTab = null; }
    if (next.id === watched && previous?.status !== "done" && next.status === "done") {
      tab = next.provider;
      forgetAccounts();
      void load(true);
    }
  }));

  /** Reload the table shortly after a read lands, at most once per 700 ms, without dimming it. */
  function reloadSoon(): void {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => { reloadTimer = null; forgetAccounts(); void load(true, true); }, 700);
  }
  $effect(() => () => { if (reloadTimer) clearTimeout(reloadTimer); });

  const settled = (run: UsageRefresh | undefined): number => run ? run.accounts.filter(entry => entry.state === "read" || entry.state === "failed").length : 0;
  $effect(() => api.refreshStream(next => {
    const previous = refreshes[next.provider];
    refreshes = { ...refreshes, [next.provider]: next };
    if (next.status === "running" && !watchedRefreshes.includes(next.id)) watchedRefreshes = [...watchedRefreshes, next.id];
    if (watchedRefreshes.includes(next.id) && (settled(next) > (previous?.id === next.id ? settled(previous) : 0) || next.status !== "running")) reloadSoon();
  }));

  async function startRefresh(provider: Provider, account: string | null): Promise<void> {
    menu = null;
    try {
      const started = await api.startRefresh(provider, account);
      if (!watchedRefreshes.includes(started.id)) watchedRefreshes = [...watchedRefreshes, started.id];
      if (!refreshes[provider] || refreshes[provider]!.id !== started.id) refreshes = { ...refreshes, [provider]: started };
    } catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
  }

  /** One line under the header for a refresh this page watched: progress while it runs, the count read when it ends. */
  function refreshSummary(job: UsageRefresh): string {
    const total = job.accounts.length;
    const read = job.accounts.filter(entry => entry.state === "read");
    const failed = job.accounts.filter(entry => entry.state === "failed");
    const name = (entry: UsageRefreshAccount) => entry.email ?? entry.id;
    if (job.status === "running") return total ? `Reading usage: ${settled(job)} of ${total} done.` : "Starting the usage read.";
    if (job.status === "failed" || !total) return `The usage read failed. ${job.message ?? ""}`.trim();
    if (job.account !== null && total === 1) return read.length ? `Read ${name(read[0]!)} just now.` : `Could not read ${name(failed[0]!)}. The reason is on its row.`;
    const head = `Read ${read.length} of ${total} accounts just now.`;
    const tail = failed.length ? ` Not read: ${failed.map(name).join(", ")}. The reasons are on their rows.` : "";
    return head + tail + (job.message ? " " + job.message : "");
  }

  const current = $derived(view ? (view.providers.find(entry => entry.provider === tab) ?? threadProvider(view, modelProvider)) : undefined);
  const resolution = $derived(current?.resolution ?? null);
  const refresh = $derived(current ? refreshes[current.provider] : undefined);
  const refreshing = $derived(refresh?.status === "running");
  const shownRefresh = $derived(refresh && watchedRefreshes.includes(refresh.id) ? refresh : null);
  const refreshEntry = (row: PoolAccount): UsageRefreshAccount | undefined => shownRefresh?.accounts.find(entry => entry.id === row.id);
  const columns = $derived(current ? windowColumns(current.rows) : []);
  const RANK: Record<AccountState | "ready", number> = { seat: 1, pinned: 1, ready: 2, live: 2, depleted: 3, limited: 3, cooldown: 4, refused: 4, "needs-login": 5, off: 6 };
  const rows = $derived([...(current?.rows ?? [])].sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email)));

  function rank(row: PoolAccount): number {
    return row.id === resolution?.account && !row.disabled ? 0 : RANK[accountState(row) ?? "ready"];
  }

  /** `quiet` keeps the table at full opacity: a refresh reloads it after every read. */
  async function load(fresh = false, quiet = false): Promise<void> {
    if (!quiet) loading = true;
    error = null;
    try {
      const result = await loadAccounts(threadId, { fresh, model: modelId });
      view = result;
      if (!tab) tab = threadProvider(result, modelProvider)?.provider ?? result.providers[0]?.provider ?? null;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { loading = false; }
  }
  $effect(() => { void threadId; void modelId; void load(); });

  async function run(action: AccountAction, key: string): Promise<void> {
    confirm = null;
    menu = null;
    acting = key;
    try {
      const result = await api.accountAction(action);
      forgetAccounts();
      rememberAccounts("id" in action ? action.id : threadId, result);
      view = result;
      notice = result.notice ?? null;
      if (action.action === "reset") void startRefresh("anthropic", action.account);
    } catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
    finally { acting = null; }
  }

  async function startLogin(provider: Provider, account: string | null): Promise<void> {
    menu = null;
    signInTab = window.open("about:blank", "_blank");
    if (signInTab) {
      signInTab.opener = null;
      signInTab.document.title = "Starting sign-in";
      signInTab.document.body.textContent = "Starting the sign-in. This tab opens the sign-in page in a few seconds.";
    }
    try {
      const started = await api.startLogin(provider, account);
      watched = started.id;
      login = started;
    } catch (caught) {
      signInTab?.close();
      signInTab = null;
      store.toast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const planText = (row: PoolAccount): string | null => {
    const plan = row.plan ?? row.tier;
    return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
  };

  const RESET_WINDOW: Record<string, string> = { five_hour: "5h", seven_day: "week", seven_day_overage_included: "overage" };
  const INELIGIBLE: Record<string, string> = { tenure: "the account is too new", tier: "the plan has none", seat: "team seats have none", surface: "this client cannot see them",
    cli_version: "the Claude Code version is too old", no_grant: "no reset was granted", config_off: "resets are off", mobile: "mobile only", other_experiment: "another experiment", unavailable: "unavailable" };
  /** Claims with an unknown outcome can be retried with the same request id for this long; pi-pool enforces it too. */
  const RESET_RETRY_MS = 10 * 60_000;
  const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  /** The grant `pi-pool reset` would spend: Anthropic's pick when it can be spent, else the first usable one. Mirrors grant_blocker in vend.py. */
  function usableGrant(resets: AccountResets | null | undefined): ResetGrant | undefined {
    if (!resets?.eligible || (resets.cooldownUntil && resets.cooldownUntil > now)) return undefined;
    const usable = resets.grants.filter(grant => !grant.paused && grant.usableNow && grant.resetsLeft > 0 && (!grant.useRequiresLimit || resets.atLimit)
      && (!grant.startsAt || grant.startsAt <= now) && (!grant.endsAt || grant.endsAt > now)).sort((a, b) => a.id.localeCompare(b.id));
    return usable.find(grant => grant.id === resets.nextGrantId) ?? usable[0];
  }
  const pendingReset = (resets: AccountResets | null | undefined) => resets?.pending && now - resets.pending.createdAt < RESET_RETRY_MS ? resets.pending : null;

  /** One note about a Claude account's banked resets, or null when they were never read. */
  function resetNote(resets: AccountResets | null | undefined): string | null {
    if (!resets) return null;
    const checked = resets.checkedAt ? ` Checked ${span(now - resets.checkedAt)} ago.` : "";
    if (resets.pending) {
      return now - resets.pending.createdAt < RESET_RETRY_MS
        ? `A reset claim got no answer, so a reset may be spent. Use reset within ${span(resets.pending.createdAt + RESET_RETRY_MS - now)} to retry the same claim.`
        : "A reset claim got no answer. Use reset again to check the count; it sends nothing new if the reset was spent.";
    }
    const failed = resets.error ? ` Last check failed: ${resets.error.replace(/\.$/, "")}.` : "";
    if (resets.eligible === null) return `Resets not read: ${resets.error ?? "unknown error"}.`;
    if (!resets.eligible) return `No banked resets: ${INELIGIBLE[resets.ineligibleReason ?? ""] ?? resets.ineligibleReason ?? "not eligible"}.` + checked + failed;
    const left = resets.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
    if (!left) return "No banked resets left." + checked + failed;
    const grant = usableGrant(resets) ?? resets.grants.find(entry => entry.resetsLeft > 0)!;
    const ends = grant.endsAt ? ` Expires ${day(grant.endsAt)}.` : "";
    return `${left} banked reset${left === 1 ? "" : "s"} left${grant.label ? `: ${grant.label}` : ""}.${ends}` + (usableGrant(resets) ? "" : " Not usable right now.") + checked + failed;
  }

  function askReset(row: PoolAccount): void {
    const pending = pendingReset(row.resets);
    if (pending) {
      ask({ title: `Retry the reset on ${row.email}?`, label: "Retry the same claim",
        body: "The last claim got no answer, so a reset may already be spent. A retry sends the same request id, so Anthropic counts it at most once.",
        action: { action: "reset", provider: "anthropic", account: row.id, grant: pending.grantId } });
      return;
    }
    const grant = usableGrant(row.resets);
    if (!grant) return;
    const clears = grant.clears.map(window => RESET_WINDOW[window] ?? window);
    const week = row.windows.find(window => window.kind === "weekly");
    const weekSoon = week?.resetsAt && week.resetsAt > now && week.resetsAt - now < 24 * 3600_000 ? ` The week resets by itself in ${span(week.resetsAt - now)}.` : "";
    const usage = row.windows.filter(window => window.kind !== "model").map(window => `${windowLabel(window)} ${Math.round(window.pct)}%`).join(", ");
    ask({ title: `Use a reset on ${row.email}?`, label: "Use reset",
      body: `This spends 1 of ${grant.resetsLeft} banked reset${grant.resetsLeft === 1 ? "" : "s"}${grant.label ? ` (${grant.label})` : ""}. It clears the ${clears.join(", ") || "eligible"} usage limits now`
        + (usage ? `; usage is ${usage}.` : ".") + weekSoon + " A spent reset cannot be given back.",
      action: { action: "reset", provider: "anthropic", account: row.id, grant: grant.id } });
  }

  function notes(row: PoolAccount): string[] {
    const state = accountState(row);
    const read = refreshEntry(row);
    const unread = read?.state === "failed" && read.reason ? [`Not read: ${read.reason.replace(/\.$/, "")}.`] : [];
    if (state === "off") return ["Off. The pool never picks it.", ...unread];
    const out: string[] = [];
    if (state === "needs-login") out.push("The sign-in expired.");
    else if (state === "refused" || state === "cooldown") {
      const left = row.cooldownUntil && row.cooldownUntil > now ? ` The pool tries it again in ${span(row.cooldownUntil - now)}.` : "";
      out.push((row.cooldownReason ? `Refused: ${row.cooldownReason}.` : "Cooling down after a failure.") + left);
    }
    else if (state === "limited" && row.limitedUntil && row.limitedUntil > now)
      out.push(`The provider answered 429. The pool skips it for ${span(row.limitedUntil - now)}, pins included.`);
    out.push(...unread);
    const stale = staleText(row, now);
    if (stale && state !== "needs-login") out.push(stale + ".");
    const resets = state === "needs-login" ? null : resetNote(row.resets);
    if (resets) out.push(resets);
    return out;
  }

  /** A row click uses the account for this thread. An account that cannot serve asks first; an account that is off or already in use does nothing. */
  const pickable = (row: PoolAccount): boolean => threadId !== null && !row.disabled && row.id !== resolution?.account && acting === null;

  function useForThread(provider: Provider, row: PoolAccount): void {
    menu = null;
    if (!threadId || !pickable(row)) return;
    if (row.usable) { void run({ action: "use", provider, account: row.id, id: threadId, force: false }, row.id); return; }
    confirm = { title: `Use ${row.email} anyway?`, body: `${row.email} cannot serve right now (${row.reason ?? "not usable"}). This thread keeps it, used up or not, until you follow the pool again. A 429 from the provider still moves it to another account until the reset.`, label: "Use anyway",
      action: { action: "use", provider, account: row.id, id: threadId, force: true } };
  }
  function rowClick(event: MouseEvent, provider: Provider, row: PoolAccount): void {
    if (event.target instanceof Element && event.target.closest(".actions, a")) return;
    useForThread(provider, row);
  }
  function ask(next: Confirm): void { menu = null; typed = ""; confirm = next; }
  const askPin = (provider: Provider, row: PoolAccount) => ask({ title: `Pin ${row.email} for all sessions?`, body: `Every ${PROVIDER_LABEL[provider]} session uses this account until you unpin it. While it is used up, limited by a 429 or cooling down, sessions use another account and come back when it can serve.`, label: "Pin",
    action: { action: "pin", provider, account: row.id } });
  const askUnpin = (provider: Provider) => ask({ title: `Unpin ${PROVIDER_LABEL[provider]}?`, body: "Sessions go back to the pool's own choice.", label: "Unpin", action: { action: "unpin", provider } });
  const askDropSeat = (provider: Provider, row: PoolAccount) => ask({ title: `Drop the seat on ${row.email}?`, body: "The next request moves the seat to the best account. Running sessions keep their connection.",
    label: "Drop seat", action: { action: "switch", provider } });
  const askRecheck = (provider: Provider) => ask({ title: "Check refused accounts again?",
    body: "The pool sends one free request per Claude account. An account the API accepts again returns to the pool. One it refuses cools down for 24 hours.", label: "Check again",
    action: { action: "recheck", provider } });
  const askRemove = (provider: Provider, row: PoolAccount) => ask({ title: `Remove ${row.email}?`,
    body: "This deletes its sign-in and drops its pins and seat. To use it again, add it again.", label: "Remove", danger: true, typed: row.email,
    action: { action: "remove", provider, account: row.id } });
  const actionKey = (action: AccountAction): string => "account" in action && action.account ? action.account : action.action;
</script>

<section class="accounts" aria-label="Accounts">
  <header class="bar">
    {#if view}
      <div class="tabs" role="tablist">
        {#each view.providers as provider (provider.provider)}
          <button class="tab" role="tab" aria-selected={current?.provider === provider.provider} onclick={() => { tab = provider.provider; menu = null; }}>
            {PROVIDER_LABEL[provider.provider]} <span class="count">{provider.rows.length}</span>
          </button>
        {/each}
      </div>
    {/if}
    <span class="spacer"></span>
    {#if current}
      <button class="button small" disabled={running(login)} onclick={() => void startLogin(current.provider, null)}>
        <Icon name="plus" size={14} /> Add {PROVIDER_LABEL[current.provider]} account
      </button>
    {/if}
    {#if current?.provider === "anthropic"}
      <button class="button small" disabled={acting !== null} use:tooltip={"Read every Claude account's banked usage-limit resets. Spends nothing."}
        onclick={() => current && void run({ action: "resets", provider: current.provider }, "resets")}>
        {#if acting === "resets"}<span class="spinner tiny"></span> Checking resets{:else}Check resets{/if}
      </button>
    {/if}
    {#if current}
      <button class="button small" disabled={refreshing} use:tooltip={`Read usage for every ${PROVIDER_LABEL[current.provider]} account now`}
        onclick={() => current && void startRefresh(current.provider, null)}>
        {#if refreshing}
          <span class="spinner tiny"></span>
          {refresh?.accounts.length ? `Reading ${settled(refresh)} of ${refresh.accounts.length}` : "Reading"}
        {:else}<Icon name="refresh" size={14} /> Refresh all{/if}
      </button>
    {/if}
  </header>

  {#if shownLogin}
    <AccountLogin login={shownLogin} onclose={() => { watched = null; }} onretry={() => shownLogin && void startLogin(shownLogin.provider, shownLogin.account)} />
  {/if}

  {#if error && !view}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Accounts unavailable. {error}</div>
      <button class="button small" onclick={() => void load(true)}>Retry</button>
    </div>
  {:else if !view || !current}
    <div class="empty muted"><span class="spinner"></span> Loading accounts</div>
  {:else}
    <div class="uses">
      <span class:warning={threadId && !resolution?.email}>{threadId ? resolutionSentence(current) : "No thread is open. New chats start on the account marked Next request."}</span>
      {#if threadId && resolution?.pinned}
        <button class="button small" disabled={acting !== null} onclick={() => threadId && void run({ action: "follow", provider: current.provider, id: threadId }, "follow")}>Follow the pool</button>
      {/if}
    </div>
    {#if shownRefresh}
      <div class="notice" class:failed={shownRefresh.status === "failed"} role="status" aria-live="polite">
        <span>{refreshSummary(shownRefresh)}</span>
        {#if shownRefresh.status !== "running"}
          <button class="icon-button small" aria-label="Dismiss" onclick={() => { watchedRefreshes = watchedRefreshes.filter(id => id !== shownRefresh?.id); }}><Icon name="x" size={14} /></button>
        {/if}
      </div>
    {/if}
    {#if notice}
      <div class="notice"><span>{notice}</span><button class="icon-button small" aria-label="Dismiss" onclick={() => { notice = null; }}><Icon name="x" size={14} /></button></div>
    {/if}
    {#if error}<div class="inline-error">{error}</div>{/if}
    {#if current.error && !current.rows.length}
      <div class="inline-error">{current.error}</div>
    {:else if !current.rows.length}
      <div class="empty muted">No {PROVIDER_LABEL[current.provider]} accounts yet.</div>
    {:else}
      <div class="table" role="table" style:--windows={columns.length} class:busy={loading}>
        <div class="row head" role="row">
          <span role="columnheader">Account</span>
          {#each columns as column (column)}<span role="columnheader">{column}</span>{/each}
          <span role="columnheader" class="sr-only">Actions</span>
        </div>
        {#each rows as row (row.id)}
          {@const state = accountState(row)}
          {@const inUse = row.id === resolution?.account && !row.disabled}
          {@const rowNotes = notes(row)}
          {@const canPick = pickable(row)}
          {@const read = refreshEntry(row)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div class="row" role="row" class:this={inUse} class:off={row.disabled} class:dead={state === "needs-login"} class:pick={canPick} class:busy={acting === row.id}
            onclick={event => rowClick(event, current.provider, row)}>
            <div class="who" role="cell">
              {#if canPick}
                <button type="button" class="email" aria-label="Use {row.email} for this thread">{row.email}</button>
              {:else}
                <div class="email">{row.email}</div>
              {/if}
              <div class="sub">
                {#if planText(row)}<span>{planText(row)}</span>{/if}
                {#if state}<span class="badge {STATE_LABEL[state].tone}">{STATE_LABEL[state].label}</span>{/if}
                {#if pendingReset(row.resets)}<span class="badge warning">Reset unknown</span>
                {:else if usableGrant(row.resets)}<span class="badge success">{usableGrant(row.resets)!.resetsLeft} reset{usableGrant(row.resets)!.resetsLeft === 1 ? "" : "s"}</span>{/if}
                {#if inUse}<span class="badge accent">{threadId ? "This thread" : "Next request"}</span>{/if}
              </div>
            </div>
            {#each columns as column (column)}
              {@const window = row.windows.find(entry => windowLabel(entry) === column)}
              <div class="cell {window ? meterTone(window.pct) : ''}" role="cell">
                {#if window}
                  <span class="pct">{Math.round(window.pct)}%</span>
                  <span class="track"><span class="fill" style:width="{Math.max(0, Math.min(100, window.pct))}%"></span></span>
                  <span class="reset">{resetText(window, now) ?? ""}</span>
                {/if}
              </div>
            {/each}
            <div class="actions" role="cell">
              {#if read?.state === "queued"}<span class="read-state">Queued</span>
              {:else if read?.state === "reading"}<span class="read-state"><span class="spinner tiny"></span> Reading</span>
              {:else}
                {#if read?.state === "read"}<span class="read-state ok">Updated</span>
                {:else if read?.state === "failed"}<span class="read-state bad">Not read</span>{/if}
                <button type="button" class="icon-button small row-refresh" disabled={refreshing} aria-label="Refresh usage for {row.email}" use:tooltip={"Refresh usage"}
                  onclick={() => void startRefresh(current.provider, row.id)}><Icon name="refresh" size={14} /></button>
              {/if}
              {#if acting === row.id}<span class="spinner tiny"></span>
              {:else if canPick}<button type="button" class="hint" aria-label="Use {row.email} for this thread" onclick={() => useForThread(current.provider, row)}>Use</button>{/if}
              {#if !row.disabled && (pendingReset(row.resets) || usableGrant(row.resets))}
                <button class="button small" disabled={acting !== null} onclick={() => askReset(row)}>{pendingReset(row.resets) ? "Retry reset" : "Use reset"}</button>
              {/if}
              {#if row.disabled}
                <button class="button small" disabled={acting !== null} onclick={() => void run({ action: "enable", provider: current.provider, account: row.id }, row.id)}>Turn on</button>
              {:else if state === "needs-login"}
                <button class="button small" disabled={running(login)} onclick={() => void startLogin(current.provider, row.email)}>Sign in again</button>
              {/if}
              <button class="icon-button small" aria-label="More actions for {row.email}" aria-haspopup="menu" aria-expanded={menu?.row.id === row.id}
                onclick={event => { menu = menu?.row.id === row.id ? null : { row, anchor: event.currentTarget }; }}><Icon name="more" size={16} /></button>
            </div>
            {#if rowNotes.length}
              <div class="notes">{#each rowNotes as note (note)}<span>{note}</span>{/each}</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

{#if menu && current}
  {@const row = menu.row}
  {@const provider = current.provider}
  {@const state = accountState(row)}
  <Floating anchor={menu.anchor} width={220} align="end" role="menu" label="Actions for {row.email}" onclose={() => { menu = null; }}>
    {#if pickable(row)}
      <button type="button" class="menu-item" role="menuitem" onclick={() => useForThread(provider, row)}>Use in this thread</button>
    {/if}
    <button type="button" class="menu-item" role="menuitem" disabled={refreshes[provider]?.status === "running"} onclick={() => void startRefresh(provider, row.id)}>Refresh usage</button>
    {#if !row.disabled}
      {#if current.poolPin === row.id}
        <button type="button" class="menu-item" role="menuitem" onclick={() => askUnpin(provider)}>Unpin for all sessions</button>
      {:else}
        <button type="button" class="menu-item" role="menuitem" onclick={() => askPin(provider, row)}>Pin for all sessions</button>
      {/if}
      {#if row.seat}<button type="button" class="menu-item" role="menuitem" onclick={() => askDropSeat(provider, row)}>Drop seat</button>{/if}
      {#if provider === "anthropic" && (pendingReset(row.resets) || usableGrant(row.resets))}
        <button type="button" class="menu-item" role="menuitem" onclick={() => askReset(row)}>{pendingReset(row.resets) ? "Retry the reset" : "Use a reset"}</button>
      {/if}
      {#if provider === "anthropic"}
        <button type="button" class="menu-item" role="menuitem" disabled={acting !== null} onclick={() => void run({ action: "resets", provider, account: row.id }, row.id)}>Check resets</button>
      {/if}
      {#if provider === "anthropic" && (state === "refused" || state === "cooldown")}
        <button type="button" class="menu-item" role="menuitem" onclick={() => askRecheck(provider)}>Check again</button>
      {/if}
    {/if}
    <button type="button" class="menu-item" role="menuitem" disabled={running(login)} onclick={() => void startLogin(provider, row.email)}>Sign in again</button>
    {#if row.disabled}
      <button type="button" class="menu-item" role="menuitem" onclick={() => void run({ action: "enable", provider, account: row.id }, row.id)}>Turn on</button>
    {:else}
      <button type="button" class="menu-item" role="menuitem" onclick={() => void run({ action: "disable", provider, account: row.id }, row.id)}>Turn off</button>
    {/if}
    <div class="menu-separator"></div>
    <button type="button" class="menu-item danger" role="menuitem" onclick={() => askRemove(provider, row)}><Icon name="trash" size={14} />Remove</button>
  </Floating>
{/if}

{#if confirm}
  <Modal title={confirm.title} width="420px" onclose={() => { confirm = null; }}>
    <form class="confirm" onsubmit={event => { event.preventDefault(); if (confirm && (!confirm.typed || typed.trim() === confirm.typed)) void run(confirm.action, actionKey(confirm.action)); }}>
      <p>{confirm.body}</p>
      {#if confirm.typed}
        <label class="typed">
          <span>Type <strong>{confirm.typed}</strong> to confirm.</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="field" bind:value={typed} autocomplete="off" spellcheck="false" autofocus />
        </label>
      {/if}
      <div class="confirm-actions">
        <button type="button" class="button" onclick={() => { confirm = null; }}>Cancel</button>
        <button type="submit" class="button {confirm.danger ? 'danger' : 'primary'}" disabled={confirm.typed !== undefined && typed.trim() !== confirm.typed}>{confirm.label}</button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .accounts { display: flex; flex-direction: column; gap: 12px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 6px; }
  .tabs { display: flex; gap: 4px; align-self: stretch; margin-bottom: -7px; }
  .tab { padding: 6px 10px 9px; color: var(--text-muted); border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--text); }
  .tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  .count { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  .uses { display: flex; align-items: center; gap: 10px; line-height: 1.4; }
  .uses span { flex: 1; }
  .warning { color: var(--warning); }
  .notice { display: flex; align-items: flex-start; gap: 8px; padding: 6px 6px 6px 12px; border-radius: var(--radius-small); background: var(--bg-sunken); color: var(--text-muted); line-height: 1.4; }
  .notice span { flex: 1; overflow-wrap: anywhere; padding-top: 3px; }
  .notice.failed { background: var(--danger-soft); color: var(--danger); }
  .read-state { display: inline-flex; align-items: center; gap: 5px; padding: 0 4px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
  .read-state.ok { color: var(--success); }
  .read-state.bad { color: var(--warning); }
  .row-refresh { opacity: 0; transition: opacity 0.12s; }
  .row:hover .row-refresh, .row-refresh:focus-visible { opacity: 1; }
  .inline-error { padding: 8px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
  .table { display: grid; grid-template-columns: minmax(200px, 1.5fr) repeat(var(--windows), minmax(96px, 1fr)) auto; }
  .table.busy { opacity: 0.7; }
  .row { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; column-gap: 14px; padding: 8px 6px; border-top: 1px solid var(--border); border-radius: var(--radius-small); transition: background-color 0.12s; }
  .row.head { border-top: none; padding-top: 0; padding-bottom: 6px; font-size: 11px; color: var(--text-faint); }
  .row.pick { cursor: pointer; }
  .row.pick:hover { background: var(--row-hover); border-top-color: transparent; }
  .row.pick:hover + .row { border-top-color: transparent; }
  .row.this { background: var(--accent-soft); border-top-color: transparent; }
  .row.this + .row { border-top-color: transparent; }
  .row.off .who, .row.off .cell, .row.dead .who, .row.dead .cell { opacity: 0.5; }
  .row.busy { opacity: 0.7; }
  .who { min-width: 0; }
  .email { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; text-align: left; }
  button.email:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
  .sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--text-muted); }
  .badge { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; background: var(--bg-active); color: var(--text-muted); }
  .badge.accent { background: var(--accent-soft); color: var(--accent); }
  .row.this .badge.accent { background: var(--bg-elevated); }
  .badge.success { background: rgba(47, 158, 99, 0.14); color: var(--success); }
  .badge.warning { background: rgba(201, 138, 18, 0.16); color: var(--warning); }
  .badge.danger { background: var(--danger-soft); color: var(--danger); }
  .cell { display: grid; grid-template-columns: 1fr; gap: 3px; min-width: 0; font-variant-numeric: tabular-nums; }
  .pct { font-size: 13px; }
  .track { height: 4px; border-radius: 2px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 2px; background: var(--success); }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .reset { font-size: 11px; color: var(--text-faint); white-space: nowrap; min-height: 13px; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
  .hint { padding: 0 6px; font-size: 12px; font-weight: 500; color: var(--accent-bold); opacity: 0; transition: opacity 0.12s; }
  .hint { height: 24px; border-radius: var(--radius-small); }
  .hint:hover { background: var(--accent-soft); }
  .row.pick:hover .hint, .hint:focus-visible { opacity: 1; }
  .notes { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 12px; color: var(--text-muted); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .confirm { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 16px; }
  .confirm p { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .typed { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--text-muted); }
  .typed strong { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
