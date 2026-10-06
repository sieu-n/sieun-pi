<script lang="ts">
  import { onMount } from "svelte";
  import { get, post } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { InterruptedReport, InterruptedRun } from "../shared/interrupted.ts";
  import Icon from "./Icon.svelte";

  /** Runs a wifi drop, sleep or shutdown stopped. The resume-paused-sessions skill decides which runs count; this only shows its answer. */
  let report = $state<InterruptedReport | null>(null);
  let busy = $state(false);
  let open = $state(false);
  const runs = $derived(report?.paused ?? []);
  const heads = $derived(new Set(runs.map(run => run.head)).size);

  function why(run: InterruptedRun): string {
    if (run.reason === "cut_off") return "cut off mid-turn";
    if (run.reason === "empty_reply") return "empty model reply";
    if (run.reason === "hung") return "hung";
    if (/api key/i.test(run.error)) return "sign-in failed";
    return /rate.?limit|429|usage limit/i.test(run.error) ? "rate limited" : /overloaded|529|50[234]|server error/i.test(run.error) ? "provider error" : "network error";
  }

  async function check(): Promise<void> {
    if (busy) return;
    try { report = await get<InterruptedReport>("api/interrupted", 90_000); }
    catch { /* The next check retries; a failed check must not hide the chat behind toasts. */ }
  }

  async function resume(): Promise<void> {
    busy = true;
    try {
      const result = await post<InterruptedReport>("api/interrupted", {}, 120_000);
      const sent = result.heads.filter(head => typeof head.result === "object");
      const resumed = sent.filter(head => !head.working).length;
      const noted = sent.length - resumed;
      const parts = [resumed ? `sent continue to ${resumed} thread${resumed === 1 ? "" : "s"}` : "", noted ? `told ${noted} working thread${noted === 1 ? "" : "s"} what stopped` : ""].filter(Boolean);
      const text = parts.join(", ");
      store.toast(text ? text[0]!.toUpperCase() + text.slice(1) + "." : "Nothing to resume.", "info");
      report = { ...result, paused: [] };
      open = false;
    } catch (error) {
      store.toast(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    const onFocus = () => { void check(); };
    window.addEventListener("online", onFocus);
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("online", onFocus); window.removeEventListener("focus", onFocus); };
  });
</script>

{#if runs.length}
  <div class="interrupted" role="status">
    <div class="line">
      <button type="button" class="summary" title="Stopped by a network drop, sleep or shutdown" aria-expanded={open} onclick={() => { open = !open; }}>
        <span class="icon"><Icon name="alert" size={14} /></span>
        <span class="text">{runs.length} interrupted</span>
        <span class="chev" class:open><Icon name="chevronDown" size={11} /></span>
      </button>
      <button type="button" class="resume" disabled={busy} onclick={resume}>
        <Icon name="refresh" size={13} /><span>{busy ? "Resuming" : "Resume"}</span>
      </button>
    </div>
    {#if open}
      <ul>
        {#each runs as run (run.id)}<li title={run.error}><span class="name">{run.name}</span><span class="why">{why(run)}</span></li>{/each}
      </ul>
      <p class="hint">Resume sends continue to {heads} head thread{heads === 1 ? "" : "s"}; each one re-drives its own runs.</p>
    {/if}
  </div>
{/if}

<style>
  .interrupted { margin: 0 10px 8px; padding: 4px; border-radius: var(--radius-small); border: 1px solid var(--border-strong); background: var(--bg-elevated); font-size: 12.5px; }
  .line { display: flex; align-items: center; gap: 4px; }
  .summary { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: var(--radius-small); text-align: left; color: var(--text); }
  .summary:hover { background: var(--bg-hover); }
  .icon { display: inline-flex; color: var(--warning); }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .chev { display: inline-flex; color: var(--text-faint); transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .resume { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: var(--radius-small); background: var(--accent); color: white; font-weight: 500; }
  .resume:hover:not(:disabled) { background: var(--accent-bold); }
  .resume:disabled { opacity: 0.6; }
  ul { list-style: none; margin: 4px 0 0; padding: 0 4px; }
  li { display: flex; gap: 8px; justify-content: space-between; padding: 2px 0; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .why { flex: none; color: var(--text-faint); }
  .hint { margin: 4px 4px 2px; color: var(--text-faint); font-size: 11.5px; }
</style>
