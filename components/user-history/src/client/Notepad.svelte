<script lang="ts">
  import { onDestroy } from "svelte";
  import { api } from "./api.ts";
  import { ui } from "./ui.svelte.ts";
  import { clockTime } from "./format.ts";
  import Icon from "./Icon.svelte";

  /** A plain memo beside a thread, saved as you type. It is the person's own; nothing sends it to the agent. */
  let { id, narrow = false }: { id: string; narrow?: boolean } = $props();

  const SAVE_AFTER_MS = 600;
  let text = $state("");
  let saved = $state("");
  let updatedAt = $state(0);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    let cancelled = false;
    api.note(id).then(note => {
      if (cancelled) return;
      text = saved = note.text;
      updatedAt = note.updatedAt;
      loaded = true;
    }, caught => { if (!cancelled) { error = caught instanceof Error ? caught.message : String(caught); loaded = true; } });
    return () => { cancelled = true; };
  });

  async function save(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!loaded || text === saved) return;
    const next = text;
    saving = true;
    try {
      const note = await api.setNote(id, next);
      saved = next;
      updatedAt = note.updatedAt;
      error = null;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { saving = false; }
  }

  function oninput(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_AFTER_MS);
  }

  onDestroy(() => { void save(); });

  const status = $derived(error ? "Not saved: " + error : saving || text !== saved ? "Saving" : updatedAt ? "Saved " + clockTime(updatedAt) : "");
</script>

<svelte:window onbeforeunload={() => { void save(); }} />

<aside class="notepad" class:narrow aria-label="Notepad">
  <div class="head">
    <Icon name="note" size={14} />
    <span class="title">Notepad</span>
    <span class="status" class:error>{status}</span>
    <button type="button" class="icon-button" aria-label="Close notepad" onclick={() => { void save(); ui.setNotesOpen(false); }}><Icon name="x" size={14} /></button>
  </div>
  <textarea bind:value={text} {oninput} onblur={() => void save()} disabled={!loaded} spellcheck="true"
    placeholder={loaded ? "Notes for this thread. Only you see them. The agent never reads them." : "Loading"}></textarea>
</aside>

<style>
  .notepad { display: flex; flex-direction: column; flex: none; width: 320px; min-height: 0; border-left: 1px solid var(--border); background: var(--bg); }
  .notepad.narrow { position: fixed; top: 0; right: 0; bottom: 0; z-index: 45; width: min(360px, 100vw); box-shadow: var(--shadow); }
  .head { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 13px; flex: none; }
  .title { font-weight: 500; color: var(--text); }
  .status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-faint); }
  .status.error { color: var(--danger); }
  .head .icon-button { width: 26px; height: 26px; }
  textarea { flex: 1; min-height: 0; width: 100%; resize: none; border: 0; outline: none; padding: 12px 14px; background: transparent; color: var(--text); font: inherit; font-size: 14px; line-height: 1.6; }
  textarea::placeholder { color: var(--text-faint); }
</style>
