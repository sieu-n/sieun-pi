<script lang="ts">
  import { reads, view, type AgentPrompt, type PromptKind, type PromptSection } from "$lib/api";
  import { Button, Disclosure, IconButton, LoadingText, ShowAllList, stampLabel, toast } from "$lib/ui";
  import type { AgentTabProps } from "./agent-tab";
  import { shortPath } from "./agents-model";

  /**
   * The Prompt tab: the whole prompt each kind of the agent's threads runs with, as pi-host's builder makes it (GET /api/agents/:id/prompt),
   * one block per kind with its size and a copy button, and one folded row per section.
   */
  let { agentId }: AgentTabProps = $props();
  const answer = view(() => reads.agentPrompt(agentId));

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
  const sectionName = (key: string): string => SECTIONS[key] ?? key.replace(/[-_]/g, " ").replace(/^./, c => c.toUpperCase());
  const chars = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "character" : "characters"}`;
  /** The text the model gets: the system prompt's sections joined as pi-ai joins them, then the digest a root gets as a message. */
  const whole = (sections: readonly PromptSection[]): string =>
    [sections.filter(s => !s.message), sections.filter(s => s.message)].map(group => group.map(s => s.text).join("\n\n")).filter(Boolean).join("\n\n");
  const sizeOf = (sections: readonly PromptSection[]): number => sections.reduce((n, s) => n + s.text.length, 0);
  const jobNote = (kind: AgentPrompt["kinds"][number]): string => kind.kind === "job" ? `${KINDS.job.note} Built here for job ${kind.conversation}.` : KINDS[kind.kind].note;
  const builtBy = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

  function copy(text: string, what: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Copy failed"),
    );
  }
</script>

{#snippet sectionRow(section: PromptSection)}
  <li class="section" data-key={section.key}>
    <Disclosure title={sectionName(section.key)} detail={chars(section.text.length)}>
      {#snippet actions()}
        <IconButton icon="copy" label="Copy {sectionName(section.key)}" size="xs" onclick={() => copy(section.text, sectionName(section.key))} />
      {/snippet}
      <pre class="text t-mono">{section.text}</pre>
      <span class="t-caption meta source">{section.source}</span>
    </Disclosure>
  </li>
{/snippet}

{#if answer.value}
  {@const prompt = answer.value}
  {#if prompt.away}
    <p class="t-body-sm meta">{prompt.away}</p>
  {/if}
  {#each prompt.kinds as kind (kind.kind)}
    {@const title = KINDS[kind.kind].title}
    <section class="block kind" aria-label="{title} prompt" data-kind={kind.kind}>
      <div class="kind-head">
        <h3 class="t-label-sm">{title}</h3>
        <span class="t-caption meta">{chars(sizeOf(kind.sections))}</span>
        <IconButton icon="copy" label="Copy the {title.toLowerCase()} prompt" size="xs" onclick={() => copy(whole(kind.sections), `the ${title.toLowerCase()} prompt`)} />
      </div>
      <p class="t-caption meta">{jobNote(kind)}</p>
      <ShowAllList items={kind.sections.filter(s => !s.message)} key={section => section.key} noun="sections" label="{title} system prompt" row={sectionRow} dense />
      {#if kind.sections.some(s => s.message)}
        <p class="t-caption meta turn">Sent as a message before each turn's input</p>
        <ShowAllList items={kind.sections.filter(s => s.message)} key={section => section.key} noun="sections" label="{title} messages" row={sectionRow} dense />
      {/if}
    </section>
  {/each}
  {#if prompt.builtBy}
    <p class="t-caption meta built" title={prompt.builtBy}>
      Built by pi-host {builtBy(prompt.builtBy)} in {shortPath(prompt.builtBy)}, {stampLabel(prompt.builtAt)}.
      <Button variant="ghost" size="sm" disabled={answer.loading} onclick={() => answer.refresh()}>Build again</Button>
    </p>
  {/if}
{:else if answer.error}
  <p class="t-body-sm warn">{answer.error}</p>
  <Button variant="outline" size="sm" onclick={() => answer.refresh()}>Try again</Button>
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
  .turn {
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
