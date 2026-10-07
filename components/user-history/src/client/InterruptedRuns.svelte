<script lang="ts">
  import { onMount } from "svelte";
  import { get, post } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { InterruptedReport, InterruptedRun } from "../shared/interrupted.ts";
  import Icon from "./Icon.svelte";
  import Floating from "./ui/Floating.svelte";

  /** Runs a wifi drop, sleep or shutdown stopped. The resume-paused-sessions skill decides which runs count; this only shows its answer. */
  let report = $state<InterruptedReport | null>(null);
  let busy = $state(false);
  let open = $state(false);
  let summary: HTMLButtonElement | undefined = $state();
  const runs = $derived(report?.paused ?? []);
  const heads = $derived(new Set(runs.map(run => run.head)).size);

  function why(run: InterruptedRun): string {
    if (run.reason === "cut_off") return "cut off mid-turn";
    if (run.reason === "empty_reply") return "empty model reply";
    if (run.reason === "hung") return "hung";
    if (/api key/i.test(run.error)) return "sign-in failed";
    if (/refused to respond/i.test(run.error)) return "model refused";
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
    <button type="button" class="summary" bind:this={summary} title="Stopped by a network drop, sleep or shutdown" aria-haspopup="dialog" aria-expanded={open} onclick={() => { open = !open; }}>
      <Icon name="alert" size={13} /><span>{runs.length} interrupted</span>
    </button>
    <button type="button" class="resume" disabled={busy} onclick={resume}>
      <Icon name="refresh" size={12} /><span>{busy ? "Resuming" : "Resume"}</span>
    </button>
  </div>
  {#if open && summary}
    <Floating anchor={summary} width={300} maxHeight={360} label="Interrupted runs" onclose={() => { open = false; }}>
      <ul>
        {#each runs as run (run.id)}<li title={run.error}><span class="name">{run.name}</span><span class="why">{why(run)}</span></li>{/each}
      </ul>
      <p class="hint">Resume sends continue to {heads} head thread{heads === 1 ? "" : "s"}; each one re-drives its own runs.</p>
    </Floating>
  {/if}
{/if}

<style>
  .interrupted { display: inline-flex; align-items: center; flex: none; height: 26px; border-radius: var(--radius-small); border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
    background: color-mix(in srgb, var(--warning) 9%, var(--bg-elevated)); font-size: 12px; font-weight: 500; overflow: hidden; }
  .summary { display: inline-flex; align-items: center; gap: 5px; height: 100%; padding: 0 7px; color: var(--warning); }
  .summary span { color: var(--text); white-space: nowrap; }
  .summary:hover, .summary[aria-expanded="true"] { background: var(--bg-hover); }
  .resume { display: inline-flex; align-items: center; gap: 4px; height: 100%; padding: 0 8px; border-left: 1px solid color-mix(in srgb, var(--warning) 35%, transparent); color: var(--accent-bold); }
  .resume:hover:not(:disabled) { background: var(--accent-soft); }
  .resume:disabled { opacity: 0.6; }
  ul { list-style: none; margin: 0; padding: 4px 6px 0; font-size: 12.5px; }
  li { display: flex; gap: 8px; justify-content: space-between; padding: 3px 0; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .why { flex: none; color: var(--text-faint); }
  .hint { margin: 4px 6px 4px; color: var(--text-faint); font-size: 11.5px; }
</style>
