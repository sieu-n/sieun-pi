<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { RemoteAccessInput, RemoteAccessView } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import Checkbox from "./ui/Checkbox.svelte";
  import QrCode from "./ui/QrCode.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  let view = $state<RemoteAccessView | null>(null);
  let error = $state<string | null>(null);
  let checking = $state(false);
  /** The value a switch is being set to; it shows at once, and the server's answer replaces it. */
  let pending = $state<{ key: "tailscale" | "keepRunning"; value: boolean } | null>(null);
  const saving = $derived(pending?.key ?? null);
  const tailscaleOn = $derived(pending?.key === "tailscale" ? pending.value : view?.mode !== "off");
  const keepRunningOn = $derived(pending?.key === "keepRunning" ? pending.value : view?.keepRunning.enabled === true);
  let copied = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  const host = $derived(view?.origin ? new URL(view.origin).host : null);
  const checkedAt = $derived(view?.checkedAt ? new Date(view.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);

  async function load(): Promise<void> {
    try { view = await api.remote(); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  async function check(): Promise<void> {
    checking = true;
    const next = await store.run(api.checkRemote());
    if (next) view = next;
    checking = false;
  }
  async function set(key: "tailscale" | "keepRunning", value: boolean): Promise<void> {
    pending = { key, value };
    const input: RemoteAccessInput = key === "tailscale" ? { tailscale: value } : { keepRunning: value };
    const next = await store.run(api.setRemote(input));
    if (next) view = next;
    pending = null;
  }
  function copy(): void {
    if (!view?.phoneUrl) return;
    void navigator.clipboard.writeText(view.phoneUrl).then(() => { copied = true; setTimeout(() => { copied = false; }, 1200); });
  }
  onMount(() => {
    void load();
    // The service re-checks every minute; this keeps an open dialog in step with it and with a first check that is still running.
    timer = setInterval(() => { void load(); }, 5000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<section class="remote" aria-label="Phone access">
  <header class="bar">
    <h3>Phone access</h3>
    <span class="spacer"></span>
    <button class="icon-button small" disabled={checking || !view} aria-label="Check now" use:tooltip={"Check now"} onclick={() => void check()}>
      {#if checking}<span class="spinner tiny"></span>{:else}<Icon name="refresh" size={14} />{/if}
    </button>
  </header>
  {#if error && !view}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Phone access status unavailable. {error}</div>
      <button class="button small" onclick={() => void load()}>Retry</button>
    </div>
  {:else if !view}
    <div class="empty muted"><span class="spinner"></span> Loading phone access</div>
  {:else}
    <p class="current {view.state}" aria-live="polite">
      {#if view.state === "checking"}<span class="spinner tiny"></span>{:else}<span class="dot" aria-hidden="true"></span>{/if}
      <span>{view.message}</span>
    </p>

    <button type="button" class="toggle" role="switch" aria-checked={tailscaleOn} aria-busy={saving === "tailscale"} disabled={!view.editable || saving !== null}
      onclick={() => void set("tailscale", !tailscaleOn)}>
      {#if saving === "tailscale"}<span class="spinner tiny"></span>{:else}<Checkbox visual checked={tailscaleOn} />{/if}
      <span class="text">
        <span class="label">Open from my devices on Tailscale</span>
        <span class="note">Adds https://{host ?? "this-mac.your-tailnet.ts.net"}/ to Tailscale Serve on this Mac. Only devices signed in to your tailnet can connect. Nothing is public.</span>
      </span>
    </button>

    {#if view.phoneUrl}
      <div class="link">
        <QrCode text={view.phoneUrl} label="QR code of the phone link" />
        <div class="side">
          <span class="label">Phone link</span>
          <code class="url">{view.phoneUrl}</code>
          <div class="actions">
            <button class="button small" onclick={copy}><Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy link"}</button>
          </div>
          <p class="note">Scan the code with the phone camera and bookmark the page. The link stays the same after restarts. Keep it private: anyone on your tailnet who has it can read and control your agents.</p>
          {#if checkedAt}
            <p class="note">{view.reachable ? `Checked at ${checkedAt}: the chat answered through ${host}.` : view.reachable === false ? `Checked at ${checkedAt}: no answer through ${host}.` : `Checked at ${checkedAt}.`}</p>
          {/if}
        </div>
      </div>
    {/if}

    <button type="button" class="toggle" role="switch" aria-checked={keepRunningOn} aria-busy={saving === "keepRunning"} disabled={!view.editable || !view.keepRunning.available || saving !== null}
      onclick={() => void set("keepRunning", !keepRunningOn)}>
      {#if saving === "keepRunning"}<span class="spinner tiny"></span>{:else}<Checkbox visual checked={keepRunningOn} />{/if}
      <span class="text">
        <span class="label">Keep the chat running</span>
        <span class="note" class:problem={view.keepRunning.state === "problem"}>{view.keepRunning.message}</span>
      </span>
    </button>

    {#if !view.editable}<p class="note">You opened this page from another device. Change these switches on the Mac that runs the chat.</p>{/if}
  {/if}
</section>

<style>
  .remote { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .spacer { flex: 1; }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .current.on .dot { background: var(--success, #2e9e5b); }
  .current.problem .dot { background: var(--danger); }
  .current.problem { color: var(--danger); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .toggle:hover:not(:disabled) { background: var(--bg-hover); }
  .toggle:disabled { cursor: default; opacity: 0.75; }
  .toggle :global(.box), .toggle .spinner { margin-top: 2px; }
  .text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .label { font-weight: 500; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .note.problem { color: var(--danger); }
  .link { display: flex; gap: 16px; align-items: flex-start; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); }
  .side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .url { display: block; padding: 6px 8px; border-radius: var(--radius-small); background: var(--bg-sunken); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; user-select: all; }
  .actions { display: flex; gap: 8px; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
  @media (max-width: 640px) { .link { flex-direction: column; } }
</style>
