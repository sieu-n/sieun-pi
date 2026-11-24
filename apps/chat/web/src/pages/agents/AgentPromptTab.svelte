<script lang="ts">
  import { kept, reads, view, type AgentPrompt, type AgentPromptOutline, type PromptKind } from "$lib/api";
  import { get } from "$lib/api/client";
  import { Button, Disclosure, IconButton, LoadingText, ShowAllList, stampLabel, toast } from "$lib/ui";

  /**
   * The Prompt tab: the whole prompt each kind of the agent's threads runs with, as pi-host's builder makes it (GET /api/agents/:id/prompt),
   * one block per kind with its size and a copy button, and one folded row per section. It draws from the outline (GET .../prompt/outline,
   * 3.9 KB as brotli) and takes each section's text from the whole answer (63 to 94 KB), read behind it, or at once when he opens a row or
   * copies before it came. Both are kept (kept.svelte.ts), so an open draws the last build with its time at once, and the build the open
   * asks for, 50 to 80 ms on the server, replaces it when its text changed.
   */
  /**
   * Only the agent's id, so the tab draws before the agent's config came: on a new server after a hand-over that read took 1.6 to 3.4 s on
   * 11-24, and the tab waited for it.
   */
  let { agentId }: { agentId: string } = $props();
  const outline = view(() => reads.agentPromptOutline(agentId));
  const texts = $derived(kept(reads.agentPrompt(agentId)));
  /** One section as the tab shows it: its text once the whole answer of the same build came. */
  type Section = { key: string; source: string; chars: number; message?: true; text?: string };
  type Shown = Omit<AgentPromptOutline, "kinds"> & { kinds: (Omit<AgentPromptOutline["kinds"][number], "sections"> & { sections: Section[] })[] };
  /** The whole answer when it is of the outline's build or no outline came yet, else the outline. */
  const shown = $derived.by((): Shown | null => {
    const whole: AgentPrompt | null = texts.value, first = outline.value;
    if (whole && (!first || whole.builtAt === first.builtAt)) {
      return { ...whole, kinds: whole.kinds.map(kind => ({ ...kind, sections: kind.sections.map(section => ({ ...section, chars: section.text.length })) })) };
    }
    return first;
  });
  $effect(() => {
    const first = outline.value;
    if (first && texts.value?.builtAt !== first.builtAt) void texts.ahead();
  });
  /** An outline marked pending is the one an earlier build stored, sent while the builder starts: the build it started takes its place. */
  $effect(() => {
    const first = outline.value;
    if (!first?.pending) return;
    void get<AgentPromptOutline>({ path: `${reads.agentPromptOutline(agentId).path}?wait=1` }, { background: "ahead" }).then(fresh => {
      if (outline.value === first) outline.set(fresh);
    }, () => undefined);
  });
  /** The sections of a kind with their text, the whole answer read now when the one of the outline's build has not come. */
  async function sectionsOf(kind: PromptKind): Promise<AgentPrompt["kinds"][number]["sections"] | undefined> {
    const first = outline.value;
    if (!texts.value || (first && texts.value.builtAt !== first.builtAt)) await texts.read();
    return texts.value?.kinds.find(k => k.kind === kind)?.sections;
  }

  const KINDS: Record<PromptKind, { title: string; note: string }> = {
    work: { title: "Main thread", note: "Its main thread's own conversation, which plans the work and starts jobs." },
    comm: { title: "Comm thread", note: "The thread that talks in its DM and hands each task to the main thread." },
    job: { title: "Job", note: "A job its main thread starts." },
  };
  /** Each section's name, by the key pi-host's builder gives it (`PromptKey` in prime-prompt.ts, and `instructions` for the role text). */
  const SECTIONS: Record<string, string> = {
    preamble: "Base prompt",
    delegation: "Delegating to jobs",
    mcp: "MCP connections",
    guidance: "Additional guidance",
    context: "Project context and brief",
    skills: "Skills list",
    rules: "Repo rules",
    harness: "Memory digest",
    corrections: "Owner corrections",
    writing: "Writing standard",
    working: "Working memory",
    instructions: "Role text",
  };
  /** pi-host's `PRIME_SECTIONS`: the parts Prime's own builder writes, in its order. */
  const PRIME = new Set(["preamble", "delegation", "mcp", "guidance", "context", "skills"]);
  type Row = Section & { kind: PromptKind };
  /** The sections in the groups the model gets them in: Prime's prompt, what pi-host adds after it, and a root's digest sent before each input. */
  const groupsOf = (kind: PromptKind, all: readonly Section[]) => groupsOfRows(all.map(section => ({ ...section, kind })));
  const groupsOfRows = (sections: readonly Row[]) => [
    { id: "prime", label: "Prime's prompt", sections: sections.filter(s => !s.message && PRIME.has(s.key)) },
    { id: "added", label: "Added by pi-host after it", sections: sections.filter(s => !s.message && !PRIME.has(s.key)) },
    { id: "turn", label: "Sent as a message before each turn's input", sections: sections.filter(s => s.message) },
  ].filter(group => group.sections.length > 0);
  const sectionName = (key: string): string => SECTIONS[key] ?? key.replace(/[-_]/g, " ").replace(/^./, c => c.toUpperCase());
  const chars = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "character" : "characters"}`;
  /** The text the model gets: the system prompt's sections joined as pi-ai joins them, then the digest a root gets as a message. */
  const joined = (sections: readonly { text: string; message?: true }[]): string =>
    [sections.filter(s => !s.message), sections.filter(s => s.message)].map(group => group.map(s => s.text).join("\n\n")).filter(Boolean).join("\n\n");
  const sizeOf = (sections: readonly Section[]): number => sections.reduce((n, s) => n + s.chars, 0);
  const builtBy = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

  function copy(text: Promise<string | undefined>, what: string) {
    text.then(value => {
      if (value === undefined) throw new Error("no text");
      return navigator.clipboard?.writeText(value);
    }).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Copy failed"),
    );
  }
  const kindText = (kind: PromptKind): Promise<string | undefined> => sectionsOf(kind).then(sections => sections && joined(sections));
  const sectionText = (row: Row): Promise<string | undefined> => sectionsOf(row.kind).then(sections => sections?.find(s => s.key === row.key)?.text);
  /** Opens a row: reads the whole answer at once when its text has not come. */
  const needText = (_node: HTMLElement, need: () => void) => {
    need();
  };
</script>

{#snippet sectionRow(section: Row)}
  <li class="section" data-key={section.key}>
    <Disclosure title={sectionName(section.key)} detail={chars(section.chars)}>
      {#snippet actions()}
        <IconButton icon="copy" label="Copy {sectionName(section.key)}" size="xs" onclick={() => copy(sectionText(section), sectionName(section.key))} />
      {/snippet}
      {#if section.text !== undefined}
        <pre class="text t-mono">{section.text}</pre>
      {:else}
        <span class="text-wait" use:needText={() => void texts.read()}><LoadingText text="Reading its text…" delay={300} /></span>
      {/if}
      <span class="t-caption meta source">{section.source}</span>
    </Disclosure>
  </li>
{/snippet}

{#if shown}
  {@const prompt = shown}
  {#if prompt.away}
    <p class="t-body-sm meta">{prompt.away}</p>
  {/if}
  {#if prompt.builtBy}
    <p class="t-caption meta built" title={prompt.builtBy}>
      Built by pi-host {builtBy(prompt.builtBy)}, the same since {stampLabel(prompt.builtAt)}.
      <Button variant="ghost" size="sm" onclick={() => outline.refresh()}>Build again</Button>
    </p>
  {/if}
  {#each prompt.kinds as kind (kind.kind)}
    {@const title = KINDS[kind.kind].title}
    <section class="block kind" aria-label="{title} prompt" data-kind={kind.kind}>
      <div class="kind-head">
        <h3 class="t-label-sm">{title}</h3>
        <span class="t-caption meta">{chars(sizeOf(kind.sections))}</span>
        <IconButton icon="copy" label="Copy the {title.toLowerCase()} prompt" size="xs" onclick={() => copy(kindText(kind.kind), `the ${title.toLowerCase()} prompt`)} />
      </div>
      <p class="t-caption meta">{KINDS[kind.kind].note}</p>
      {#each groupsOf(kind.kind, kind.sections) as group (group.id)}
        <p class="t-caption meta group" data-group={group.id}>{group.label}</p>
        <ShowAllList items={group.sections} key={section => section.key} noun="sections" label="{title}: {group.label}" row={sectionRow} dense />
      {/each}
    </section>
  {/each}
{:else if outline.error}
  <p class="t-body-sm warn">{outline.error}</p>
  <Button variant="outline" size="sm" onclick={() => outline.refresh()}>Try again</Button>
{:else}
  <LoadingText text="Building its prompts…" />
{/if}

<style>
  .kind-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .kind-head h3 {
    margin: 0;
  }
  .kind > p {
    margin: 0;
  }
  .section {
    min-width: 0;
  }
  .group {
    margin: var(--space-1) 0 0;
  }
  .text {
    margin: 0;
    max-height: 480px;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-chip);
    background: var(--surface-panel);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-standard);
    font-size: 12px;
  }
  .text-wait {
    display: block;
    min-height: 1.5em;
  }
  .source {
    display: block;
    margin-top: var(--space-1);
  }
  .built {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }
</style>
