<script lang="ts">
  import { untrack } from "svelte";
  import { agents, api } from "$lib/api";
  import { SKILL_RUNTIMES, type BoxName, type SkillEntry, type SkillRuntime, type SkillsView } from "$lib/api/shared/skills";
  import { Button, Dialog, Field, Picker, Select, type PickerItem } from "$lib/ui";
  import { act } from "./actions";
  import { boxLabel, runtimeLabel, sourceText, tilde, type Folder } from "./model";

  /**
   * Adds a skill to a folder or for an agent. Opened from a folder, the folder is set and the person picks the skill; opened from a skill,
   * the skill is set and the person picks the box and folder. "The runtime's own folder" leaves the path to the server.
   */
  type Props = {
    open: boolean;
    view: SkillsView;
    roots: ReadonlyMap<BoxName, Folder[]>;
    folder: Folder | null;
    skill: SkillEntry | null;
    reload: () => Promise<void>;
  };
  let { open = $bindable(), view, roots, folder, skill, reload }: Props = $props();

  const RUNTIME_FOLDER = "";
  let skillId = $state("");
  let box = $state<BoxName>("");
  let path = $state(RUNTIME_FOLDER);
  let runtime = $state<SkillRuntime>("prime");
  let agent = $state("");
  let mode = $state<"link" | "copy">("link");
  let pickerOpen = $state(false);
  let pickerAnchor = $state<HTMLElement | undefined>();
  let busy = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      skillId = skill?.id ?? "";
      box = folder?.box ?? view.boxes.find(b => b.state === "ok")?.box ?? view.boxes[0]?.box ?? "";
      path = folder?.node.path ?? RUNTIME_FOLDER;
      runtime = folder?.node.loadedBy[0] ?? "prime";
      agent = "";
      mode = "link";
    });
  });

  const chosen = $derived(view.skills.find(s => s.id === skillId) ?? null);
  const boxRoots = $derived(roots.get(box) ?? []);
  const runtimes = $derived.by((): readonly SkillRuntime[] => {
    const at = boxRoots.find(f => f.node.path === path);
    return at && at.node.loadedBy.length ? at.node.loadedBy : SKILL_RUNTIMES;
  });
  $effect(() => {
    if (!runtimes.includes(runtime)) runtime = runtimes[0] ?? "prime";
  });
  const items = $derived(
    [...view.skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s): PickerItem => ({ id: s.id, label: s.name, detail: s.description, trailing: sourceText(s), keywords: [s.id] })),
  );
  const agentOptions = $derived([
    { value: "", label: "No agent" },
    ...agents.list.filter(a => a.kind === "chat" && !a.archived).map(a => ({ value: a.id, label: a.name })),
  ]);
  const target = $derived(chosen && path !== RUNTIME_FOLDER ? `${path}/${chosen.name}` : null);

  async function submit(): Promise<void> {
    if (!chosen || !box) return;
    busy = true;
    const ok = await act(
      `Adding ${chosen.name}`,
      () => api.installSkill({ name: chosen.name, source: chosen.id, box, runtime, mode, agent: agent || null, path: target }),
      reload,
    );
    busy = false;
    if (ok) open = false;
  }
</script>

<Dialog bind:open title={folder ? `Add a skill to ${tilde(folder.node.path)}` : `Add ${skill?.name ?? "a skill"}`} description="It installs at once, and the toast after it can undo it.">
  <div class="form">
    {#if !skill}
      <Field label="Skill" id="install-skill">
        <Button id="install-skill" variant="outline" trailingIcon="chevron-down" bind:element={pickerAnchor} onclick={() => (pickerOpen = !pickerOpen)}>{chosen?.name ?? "Choose a skill"}</Button>
      </Field>
      <Picker bind:open={pickerOpen} anchor={pickerAnchor} {items} value={skillId} searchable width={420} label="Skill" placeholder="Find a skill" onselect={id => ((skillId = id), (pickerOpen = false))} />
    {/if}
    {#if !folder}
      <Field label="Box" id="install-box">
        <Select id="install-box" label="Box" bind:value={box} options={view.boxes.map(b => ({ value: b.box, label: boxLabel(b.box) }))} onchange={() => (path = RUNTIME_FOLDER)} />
      </Field>
      <Field label="Folder" id="install-folder">
        <Select id="install-folder" label="Folder" bind:value={path} options={[{ value: RUNTIME_FOLDER, label: "The runtime's own folder" }, ...boxRoots.map(f => ({ value: f.node.path, label: tilde(f.node.path) }))]} />
      </Field>
    {/if}
    <Field label="Loaded by" id="install-runtime">
      <Select id="install-runtime" label="Loaded by" bind:value={runtime} options={runtimes.map(r => ({ value: r, label: runtimeLabel(r) }))} />
    </Field>
    <Field label="For agent" id="install-agent" optional>
      <Select id="install-agent" label="For agent" bind:value={agent} options={agentOptions} />
    </Field>
    <Field label="How" id="install-mode">
      <Select id="install-mode" label="How" bind:value={mode} options={[{ value: "link", label: "Link to the source" }, { value: "copy", label: "Copy of the source" }]} />
    </Field>
    {#if target}<p class="where">Goes to <code>{tilde(target)}</code> on {boxLabel(box)}.</p>{/if}
  </div>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!chosen || !box} onclick={() => void submit()} data-testid="tree-install-submit">Add skill</Button>
  {/snippet}
</Dialog>

<style>
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .where { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); overflow-wrap: anywhere; }
  code { font: var(--text-mono); }
</style>
