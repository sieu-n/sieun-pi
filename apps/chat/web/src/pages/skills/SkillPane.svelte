<script lang="ts">
  import { useConversation, type SkillRow } from "$lib/api/shared/skills";
  import { conversationHref } from "$lib/router.svelte";
  import { openView } from "$lib/shell/viewer.svelte";
  import { Badge, IconButton, LoadingText, Markdown, toast } from "$lib/ui";
  import { VERDICT_TONE, agoText, flagBadges, listOf, shortPath, splitFrontmatter } from "./model";
  import { skillView } from "./skill-view.svelte";

  /**
   * One skill in the viewer popup: its inventory row (where it lives, who loads it, its last uses with links into their threads, its flags
   * and verdict, and the rows it duplicates), then its SKILL.md.
   */
  let { id }: { id: string } = $props();

  $effect(() => skillView.load(id));

  const doc = $derived(skillView.id === id ? skillView.doc : null);
  const error = $derived(skillView.id === id ? skillView.error : null);
  const row = $derived(doc?.row ?? null);
  const parts = $derived(doc?.text ? splitFrontmatter(doc.text) : null);
  const now = Date.now();

  function copyPath(path: string) {
    void navigator.clipboard.writeText(path).then(() => toast.show("Path copied"), () => toast.error("Could not copy the path"));
  }

  const otherLabel = (other: SkillRow): string => `${other.name} (${other.kind} on ${other.box})`;
</script>

<div class="skill" data-testid="skill-pane">
  {#if error}
    <p class="notice" role="status">This skill did not read: {error}</p>
  {:else if !row}
    <LoadingText text="Reading the skill…" />
  {:else}
    <dl class="facts">
      <dt>Path</dt>
      <dd class="path"><code>{row.path}</code><IconButton icon="copy" label="Copy path" size="xs" onclick={() => copyPath(row.path)} /></dd>
      <dt>Box</dt>
      <dd>{row.box}{#if row.runtimes.length}, for {row.runtimes.join(", ")}{/if}</dd>
      {#if row.links.length}
        <dt>Linked from</dt>
        <dd>{row.links.map(shortPath).join(", ")}</dd>
      {/if}
      {#if row.upstream}
        <dt>Upstream</dt>
        <dd><a href={row.upstream.url} target="_blank" rel="noopener">{row.upstream.url}</a> <Badge tone={row.upstream.status === "drift" ? "warning" : row.upstream.status === "same" ? "success" : "outline"}>{row.upstream.status}</Badge></dd>
      {/if}
      {#if row.useful.verdict}
        <dt>Verdict</dt>
        <dd><Badge tone={VERDICT_TONE[row.useful.verdict]}>{row.useful.verdict}</Badge> {row.useful.reason}</dd>
      {/if}
      {#if flagBadges(row).length}
        <dt>Flags</dt>
        <dd><ul>{#each flagBadges(row) as flag (flag.label)}<li><Badge tone={flag.tone}>{flag.label}</Badge> {flag.detail}</li>{/each}</ul></dd>
      {/if}
      {#if doc?.related.length}
        <dt>Same as</dt>
        <dd>
          <ul>
            {#each doc.related as other (other.id)}
              <li><button type="button" class="link" onclick={() => openView({ kind: "skill", id: other.id })}>{otherLabel(other)}</button> <span class="subtle">{shortPath(other.path)}</span></li>
            {/each}
          </ul>
        </dd>
      {/if}
      <dt>Loaded by</dt>
      <dd>
        {row.loadedBy.agents.length ? listOf(row.loadedBy.agents, 8) : "No agent named"}{#if row.loadedBy.sessions !== null}, in {row.loadedBy.sessions} {row.loadedBy.sessions === 1 ? "session" : "sessions"} over 7 days{/if}{#if row.loadedBy.how.length}, through {row.loadedBy.how.join(", ")}{/if}
      </dd>
      {#if row.lastChange}
        <dt>Last change</dt>
        <dd><code>{row.lastChange.sha.slice(0, 8)}</code> {row.lastChange.subject} <span class="subtle">{agoText(Date.parse(row.lastChange.at), now)}</span></dd>
      {/if}
      <dt>Last uses</dt>
      <dd>
        {#if row.uses.length}
          <ul class="uses">
            {#each row.uses as use, i (i)}
              {@const conversation = useConversation(use)}
              <li>
                {#if conversation}
                  <a href={conversationHref(conversation, { messageId: use.entry !== null ? `e${use.entry}` : null })}>{agoText(Date.parse(use.at), now)}</a>
                {:else}
                  <span>{agoText(Date.parse(use.at), now)}</span>
                {/if}
                <span class="subtle">{[use.agent ?? use.session, use.how, use.runtime, use.box].filter(Boolean).join(" · ")}</span>
              </li>
            {/each}
          </ul>
          {#if row.uses7d !== null || row.uses30d !== null}<p class="subtle counts">{row.uses7d ?? "?"} uses in 7 days, {row.uses30d ?? "?"} in 30 days.</p>{/if}
        {:else}
          No use found in the transcripts.
        {/if}
      </dd>
    </dl>

    <div class="doc">
      {#if parts}
        {#if parts.frontmatter}<Markdown text={"```yaml\n" + parts.frontmatter + "\n```"} />{/if}
        <Markdown text={parts.body} />
      {:else}
        <p class="notice" role="status">{doc?.textError ?? "The file is empty."}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .skill { flex: 1; min-height: 0; overflow: auto; padding: 16px 24px 32px; }
  .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; margin: 0 0 24px; font: var(--text-body); }
  dt { color: var(--text-subtle); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  ul { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .path { display: flex; align-items: center; gap: 6px; }
  code { font: var(--text-mono); }
  .subtle { color: var(--text-subtle); }
  .counts { margin: 6px 0 0; font: var(--text-body-sm); }
  .uses a { color: var(--text-message-link); font-variant-numeric: tabular-nums; }
  .facts a { color: var(--text-message-link); }
  .link { padding: 0; border: 0; background: none; color: var(--text-message-link); font: inherit; text-decoration: underline; cursor: pointer; }
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
  .doc { border-top: 1px solid var(--border-standard); padding-top: 16px; }
</style>
