<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { SdkView } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import Checkbox from "./ui/Checkbox.svelte";
  import { briefRows, currentBrief } from "./brief.ts";

  let view = $state<SdkView | null | undefined>(undefined);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  const update = $derived(view?.update ?? null);
  const running = $derived(update?.state === "running" || update?.state === "restarting");
  const status = $derived.by(() => {
    if (!view) return { tone: "off", text: "" };
    if (update?.state === "running") return { tone: "checking", text: update.message };
    if (update?.state === "restarting") return { tone: "checking", text: update.message };
    if (update?.state === "failed") return { tone: "problem", text: `Update to prime-agent ${update.target} failed. The chat still uses ${view.client}.` };
    if (view.daemon === null) return { tone: "off", text: "Waiting for the Prime Agent daemon to report its version." };
    if (view.matched && view.daemon !== view.client) return { tone: "on", text: `Matched. Prime Agent ${view.daemon} ships SDK ${view.client}, and the chat uses it.` };
    if (view.matched) return { tone: "on", text: `Matched. The chat and the daemon both use prime-agent ${view.client}.` };
    if (update?.message) return { tone: "problem", text: update.message };
    return { tone: "problem", text: `Prime Agent ${view.daemon} ships SDK ${view.sdk}, and the chat still uses ${view.client}.` };
  });

  async function load(): Promise<void> {
    try { view = await api.sdk(); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  async function start(): Promise<void> {
    busy = true;
    const next = await store.run(api.updateSdk());
    if (next) view = next;
    busy = false;
  }
  async function setAuto(auto: boolean): Promise<void> {
    busy = true;
    const next = await store.run(api.setSdkAuto(auto));
    if (next) view = next;
    busy = false;
  }
  onMount(() => {
    void load();
    // An update runs for about a minute and ends in a restart; this keeps the open dialog in step with it.
    timer = setInterval(() => { void load(); }, 2000);
  });
  onDestroy(() => clearInterval(timer));

  /** Chat rules: the brief each chat loaded against the current one. */
  const rows = $derived(briefRows(store.sessions));
  const current = $derived(currentBrief(store.sessions));
  const behind = $derived(rows.filter(row => row.version !== current).length);
  let updatingChats = $state(false);
  async function updateChats(): Promise<void> {
    updatingChats = true;
    await store.run(api.updateChats());
    updatingChats = false;
  }
</script>

<section class="pane" aria-label="Updates">
  <section class="block" aria-label="App version">
    <h4>App version</h4>
    {#if error && view === undefined}
      <div class="empty">
        <div class="error"><Icon name="alert" size={16} /> Version status unavailable. {error}</div>
        <button class="button small" onclick={() => void load()}>Retry</button>
      </div>
    {:else if view === undefined}
      <div class="empty muted"><Spinner size="normal" /> Loading versions</div>
    {:else if view === null}
      <p class="note">This chat instance does not manage its prime-agent packages.</p>
    {:else}
      <p class="current {status.tone}" aria-live="polite">
        {#if running}<Spinner />{:else}<span class="dot" aria-hidden="true"></span>{/if}
        <span>{status.text}</span>
      </p>

      <dl class="table">
        <dt>Prime Agent daemon</dt><dd class="mono">{view.daemon ?? "unknown"}</dd>
        {#if view.sdk && view.sdk !== view.daemon}<dt>SDK the daemon ships</dt><dd class="mono">{view.sdk}</dd>{/if}
        <dt>Chat SDK (prime-agent package)</dt><dd class="mono">{view.client}</dd>
        <dt>Chat build</dt><dd class="mono">{view.build}</dd>
      </dl>

      {#if update?.state === "failed"}
        <pre class="log problem">{update.message}</pre>
      {:else if running && update && update.log.length}
        <pre class="log">{update.log.join("\n")}</pre>
      {/if}

      {#if view.available}
        <button type="button" class="toggle" role="switch" aria-checked={view.auto} disabled={busy} onclick={() => void setAuto(!view!.auto)}>
          <Checkbox visual checked={view.auto} />
          <span class="text">
            <span class="label">Update the chat when Prime Agent updates</span>
            <span class="note">When the daemon comes back on a new version, the chat installs the matching prime-agent packages, runs its type check and tests, and restarts. If a check fails, it puts the old packages back and shows the error here.{view.canRestart ? "" : " This instance does not run as the login item, so restart it yourself after an update."}</span>
          </span>
        </button>
        {#if !view.matched || update?.state === "failed"}
          <div class="actions">
            <button class="button small primary" disabled={busy || running || view.daemon === null} onclick={() => void start()}>
              {update?.state === "failed" ? "Retry" : `Update to ${view.sdk ?? view.daemon}`}
            </button>
          </div>
        {/if}
      {:else}
        <p class="note">Automatic updates need a sieun-pi checkout. Run <code>node scripts/sync-prime-agent.mjs</code> there, then restart the chat.</p>
      {/if}
    {/if}
  </section>

  <section class="block" aria-label="Chat rules">
    <div class="block-head">
      <h4>Chat rules</h4>
      {#if current !== null}
        <button class="button small primary" disabled={updatingChats} onclick={() => void updateChats()}>Update all chats</button>
      {/if}
    </div>
    <p class="note">
      Every chat follows a set of rules, the chat brief, and reads it when it loads. A new brief reaches a chat when the chat reloads: an idle chat at once,
      a busy one when its turn ends. The chat then gets one line that says what changed. Jobs a chat already started keep their old rules.
    </p>
    {#if current === null}
      <p class="note">No chats yet.</p>
    {:else}
      <p class="current" class:on={behind === 0}><span class="dot" aria-hidden="true"></span>
        <span>Current brief <code class="mono">{current}</code>. {behind === 0 ? "Every chat runs it." : `${behind} of ${rows.length} chats are not on it yet.`}</span></p>
      <ul class="list">
        {#each rows as row (row.id)}
          <li class="row">
            <span class="name" title={row.name}>{row.name}</span>
            <code class="mono version">{row.version}</code>
            <span class="status" class:pending={row.status === "update pending"} class:updating={row.status === "updating"}>
              {#if row.status === "updating"}<Spinner />{/if}{row.status}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 22px; padding: 12px 18px 18px; font-size: 13px; }
  .block { display: flex; flex-direction: column; gap: 12px; }
  .block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 26px; }
  h4 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--text-muted); }
  .list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) max-content 120px; align-items: center; gap: 12px; padding: 7px 12px; }
  .row + .row { border-top: 1px solid var(--border); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .version { color: var(--text-muted); }
  .status { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .status.pending { color: var(--danger); }
  .status.updating { color: var(--text); }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .current.on .dot { background: var(--success, #2e9e5b); }
  .current.problem .dot { background: var(--danger); }
  .current.problem { color: var(--danger); }
  .table { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); }
  dt { color: var(--text-muted); }
  dd { margin: 0; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .log { margin: 0; padding: 8px 10px; max-height: 180px; overflow: auto; border-radius: var(--radius-small); background: var(--bg-sunken); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .log.problem { color: var(--danger); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .toggle:hover:not(:disabled) { background: var(--bg-hover); }
  .toggle:disabled { cursor: default; opacity: 0.75; }
  .toggle :global(.box) { margin-top: 2px; }
  .text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .label { font-weight: 500; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .actions { display: flex; gap: 8px; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
