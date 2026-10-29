<script lang="ts">
  import { api, type AgentHost, type AgentSummary, type ModelCatalog, type ProjectList, type ThinkingLevel } from "$lib/api";
  import { Button, Dialog, Field, Input, ModelPicker, Select, mascotSvg } from "$lib/ui";
  import { levelsFor, modelOptions } from "./agents-model";
  import { defaultHost, hostOptions, hostProjects } from "./host-badge";
  import ProjectPicker from "./ProjectPicker.svelte";

  type Props = {
    open: boolean;
    catalog: ModelCatalog | null;
    onclose: () => void;
    oncreated: (agent: AgentSummary) => void;
  };
  let { open = $bindable(), catalog, onclose, oncreated }: Props = $props();

  let name = $state("");
  let model = $state("");
  let level = $state<ThinkingLevel | undefined>();
  let pending = $state(false);
  let error = $state("");
  let nameError = $state<string | null>(null);
  let touched = $state(false);
  let projects = $state<ProjectList | null>(null);
  let cwd = $state("");
  /** The boxes that run pi-host, from `GET /api/agent-hosts`; the picker shows only when there is more than one. */
  let hosts = $state<AgentHost[] | null>(null);
  let host = $state("");

  $effect(() => {
    if (!open || hosts) return;
    api.agentHosts().then(
      (list) => {
        hosts = list.hosts;
        if (!host) host = defaultHost(list.hosts);
      },
      () => (hosts = []),
    );
  });
  const picked = $derived(hosts?.find((row) => row.box === host) ?? null);
  /** The chat's own box offers `GET /api/projects`; another box offers the folders its row of the host list names. */
  const folders = $derived(picked && !picked.self ? hostProjects(picked) : projects);
  function pickHost(next: string) {
    touched = true;
    host = next;
    cwd = folders?.default ?? "";
  }

  $effect(() => {
    if (!open || projects) return;
    api.projects().then(
      (list) => {
        projects = list;
        if (!cwd) cwd = list.default ?? "";
      },
      () => (projects = { projects: [], default: null, home: "" }),
    );
  });
  $effect(() => {
    if (open && !model && catalog) {
      model = catalog.default.model;
      level = catalog.default.thinkingLevel;
    }
  });
  const options = $derived(modelOptions(catalog));
  const preview = $derived(mascotSvg(name.trim() || "New agent", "create-preview"));

  function reset() {
    name = "";
    model = catalog?.default.model ?? "";
    level = catalog?.default.thinkingLevel;
    host = hosts ? defaultHost(hosts) : "";
    cwd = projects?.default ?? "";
    error = "";
    nameError = null;
    touched = false;
    pending = false;
  }
  function close() {
    open = false;
    reset();
    onclose();
  }
  async function create(event?: Event) {
    event?.preventDefault();
    if (pending) return;
    if (!name.trim()) {
      nameError = "Add a name to create your agent";
      return;
    }
    pending = true;
    error = "";
    try {
      const agent = await api.createAgent({ name: name.trim(), ...(model ? { model } : {}), ...(level ? { thinkingLevel: level } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(picked && !picked.self ? { host: picked.box } : {}) });
      open = false;
      reset();
      oncreated(agent);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      pending = false;
    }
  }
</script>

<Dialog bind:open title="Create agent" width={532} dirty={touched} initialFocus="#create-agent-name" onclose={close}>
  <form id="create-agent-form" class="form" onsubmit={create} aria-label="New agent">
    <div class="stage" aria-hidden="true">
      <span class="stage-label t-body-sm">Its mascot follows its name</span>
      <span class="stage-art">{@html preview}</span>
    </div>
    <Field label="Name" id="create-agent-name" error={nameError}>
      <Input
        id="create-agent-name"
        placeholder="Name"
        bind:value={name}
        invalid={!!nameError}
        disabled={pending}
        autocomplete="off"
        oninput={() => {
          touched = true;
          nameError = null;
          error = "";
        }}
      />
    </Field>
    <div class="settings">
      <div class="setting">
        <span class="t-body">Model</span>
        <ModelPicker
          models={options}
          value={model}
          efforts={levelsFor(catalog, model)}
          effort={level}
          variant="field"
          disabled={pending || !catalog}
          onchange={(next) => {
            touched = true;
            model = next.model;
            const levels = levelsFor(catalog, next.model);
            level = next.effort && levels.includes(next.effort) ? (next.effort as ThinkingLevel) : (levels.includes("high") ? "high" : (levels.at(-1) as ThinkingLevel | undefined));
          }}
        />
      </div>
      {#if hosts && hosts.length > 1}
        <div class="setting">
          <span class="t-body">Host</span>
          <Select label="Host" id="create-agent-host" value={host} options={hostOptions(hosts)} disabled={pending} onchange={pickHost} />
        </div>
      {/if}
      <div class="setting">
        <span class="t-body">Project</span>
        {#key host}
          <ProjectPicker projects={folders} bind:value={cwd} disabled={pending || !folders} id="create-agent-project" onchange={() => (touched = true)} />
        {/key}
      </div>
      <p class="hint t-caption">
        A new agent is a new root thread on pi-host{#if hosts && hosts.length > 1}{" "}on the box you pick{/if}, in its project folder, whose AGENTS.md, skills and rules it reads.
        {#if folders && !folders.default}No project folder is configured on this box, so name one.{/if}
        You can change its model and folder later from its card.
      </p>
    </div>
    {#if error}<p class="error t-body-sm" role="alert">{error}</p>{/if}
  </form>
  {#snippet actions()}
    <Button variant="primary" type="submit" form="create-agent-form" loading={pending} disabled={pending}>Create agent</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .stage {
    position: relative;
    display: grid;
    place-items: center;
    height: 208px;
    border-radius: var(--radius-container);
    background: var(--gradient-2);
    overflow: hidden;
  }
  .stage-label {
    position: absolute;
    top: var(--space-3);
    left: var(--space-4);
    color: var(--text-subtle);
  }
  .stage-art {
    width: 136px;
    height: 136px;
  }
  .stage-art :global(svg) {
    width: 100%;
    height: 100%;
  }
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-container);
  }
  .setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 40px;
  }
  .hint {
    margin: 0;
    color: var(--text-metadata);
  }
  .error {
    margin: 0;
    color: var(--text-danger);
  }
</style>
