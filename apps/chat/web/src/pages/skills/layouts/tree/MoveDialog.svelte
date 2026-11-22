<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$lib/api";
  import type { SkillCopy, SkillEntry } from "$lib/api/shared/skills";
  import { Button, Dialog, Field, Select } from "$lib/ui";
  import { act } from "./actions";
  import { tilde, type Folder } from "./model";

  type Props = { open: boolean; skill: SkillEntry; copy: SkillCopy; roots: readonly Folder[]; reload: () => Promise<void> };
  let { open = $bindable(), skill, copy, roots, reload }: Props = $props();

  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const choices = $derived(roots.filter(f => f.node.path !== parentOf(copy.path)));
  let folder = $state("");
  let busy = $state(false);
  $effect(() => {
    if (open) untrack(() => (folder = choices[0]?.node.path ?? ""));
  });
  const target = $derived(folder ? `${folder}/${skill.name}` : "");

  async function submit(): Promise<void> {
    const installId = copy.installId;
    if (!installId || !target) return;
    busy = true;
    const ok = await act({ doing: `Moving ${skill.name}`, done: `Moved ${skill.name} to ${tilde(folder)}` }, () => api.moveSkill({ installId, path: target }), reload);
    busy = false;
    if (ok) open = false;
  }
</script>

<Dialog bind:open title={`Move ${skill.name}`} description={`Now at ${tilde(copy.path)} on ${copy.box}.`}>
  {#if choices.length}
    <Field label="To folder" id="move-folder">
      <Select id="move-folder" label="To folder" bind:value={folder} options={choices.map(f => ({ value: f.node.path, label: tilde(f.node.path) }))} />
    </Field>
    {#if target}<p class="where">Goes to <code>{tilde(target)}</code>.</p>{/if}
  {:else}
    <p class="where">{copy.box} has no other skill folder to move it to.</p>
  {/if}
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!target} onclick={() => void submit()} data-testid="tree-move-submit">Move</Button>
  {/snippet}
</Dialog>

<style>
  .where { margin: var(--space-3) 0 0; color: var(--text-subtle); font: var(--text-body-sm); overflow-wrap: anywhere; }
  code { font: var(--text-mono); }
</style>
