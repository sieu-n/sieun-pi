<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { briefRows, currentBrief } from "./brief.ts";

  const rows = $derived(briefRows(store.sessions));
  const current = $derived(currentBrief(store.sessions));
  const behind = $derived(rows.filter(row => row.version !== current).length);
  let busy = $state(false);

  async function updateAll(): Promise<void> {
    busy = true;
    await store.run(api.updateChats());
    busy = false;
  }
</script>

<section class="chats" aria-label="Chats">
  <header class="bar"><h3>Chats</h3></header>
  <p class="note">
    Each chat reads its rules (the chat brief) when it loads. A new brief reaches a chat when it reloads: an idle chat at once, a busy one when its turn ends,
    and the chat gets one line saying what changed. Jobs a chat started keep their old instructions.
  </p>
  {#if current === null}
    <p class="note">No chats yet.</p>
  {:else}
    <div class="summary">
      <span>Current brief <code>{current}</code>. {behind === 0 ? "Every chat runs it." : `${behind} of ${rows.length} not on it yet.`}</span>
      <button class="button small primary" disabled={busy} onclick={() => void updateAll()}>Update all chats</button>
    </div>
    <ul class="list">
      {#each rows as row (row.id)}
        <li class="row">
          <span class="name" title={row.name}>{row.name}</span>
          <code class="version">{row.version}</code>
          <span class="status" class:pending={row.status === "update pending"} class:updating={row.status === "updating"}>
            {#if row.status === "updating"}<span class="spinner tiny"></span>{/if}{row.status}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .chats { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) max-content 120px; align-items: center; gap: 12px; padding: 7px 12px; }
  .row + .row { border-top: 1px solid var(--border); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .version { color: var(--text-muted); }
  .status { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .status.pending { color: var(--danger); }
  .status.updating { color: var(--text); }
</style>
