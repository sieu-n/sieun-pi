<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { SdkView } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import Checkbox from "./ui/Checkbox.svelte";

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
    if (view.matched) return { tone: "on", text: `Matched. The chat and the daemon both use prime-agent ${view.client}.` };
    if (update?.message) return { tone: "problem", text: update.message };
    return { tone: "problem", text: `The daemon runs ${view.daemon}, and the chat still uses ${view.client}.` };
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
</script>

<section class="versions" aria-label="Versions">
  <header class="bar"><h3>Versions</h3></header>
  {#if error && view === undefined}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Version status unavailable. {error}</div>
      <button class="button small" onclick={() => void load()}>Retry</button>
    </div>
  {:else if view === undefined}
    <div class="empty muted"><span class="spinner"></span> Loading versions</div>
  {:else if view === null}
    <p class="note">This chat instance does not manage its prime-agent packages.</p>
  {:else}
    <p class="current {status.tone}" aria-live="polite">
      {#if running}<span class="spinner tiny"></span>{:else}<span class="dot" aria-hidden="true"></span>{/if}
      <span>{status.text}</span>
    </p>

    <dl class="table">
      <dt>Prime Agent daemon</dt><dd class="mono">{view.daemon ?? "unknown"}</dd>
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
            {update?.state === "failed" ? "Retry" : `Update to ${view.daemon}`}
          </button>
        </div>
      {/if}
    {:else}
      <p class="note">Automatic updates need a sieun-pi checkout. Run <code>node scripts/sync-prime-agent.mjs</code> there, then restart the chat.</p>
    {/if}
  {/if}
</section>

<style>
  .versions { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
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
