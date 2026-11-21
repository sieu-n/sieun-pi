<script lang="ts">
  import type { ReviewAction, ReviewCopy } from "$lib/api/shared/skills-review";
  import { REVIEW_ACTIONS } from "$lib/api/shared/skills-review";
  import { Badge, Disclosure, IconButton, Input, Select, toast } from "$lib/ui";
  import DiffView from "./DiffView.svelte";
  import { ACTION_LABEL, actionText, agoText, diffCounts, diffLines, sizeText, type Edit } from "./model";

  /**
   * One copy of a review item: where it lives, its size and use, the action proposed for it and its reason, its state after a decision,
   * and its diff against the keeper, or its text when the item has no keeper. With `editing` it shows the action and fold target fields
   * that Change target opened.
   */
  type Props = {
    copy: ReviewCopy;
    diff: string | null | undefined;
    text: string | null | undefined;
    hasKeeper: boolean;
    editing: boolean;
    edit: Edit;
    onedit: (next: Edit) => void;
    /** The id of the datalist of skill names, for the fold target field. */
    suggestions: string;
    now: number;
  };
  let { copy, diff, text, hasKeeper, editing, edit, onedit, suggestions, now }: Props = $props();

  const STATE_TONE = { pending: "outline", queued: "warning", applied: "success", failed: "danger", undone: "neutral" } as const;
  const STATE_LABEL = { pending: "Pending", queued: "Queued for Mac", applied: "Applied", failed: "Failed", undone: "Undone" } as const;

  const lines = $derived(diff ? diffLines(diff) : []);
  const counts = $derived(diffCounts(lines));
  let diffOpen = $state(false);
  let textOpen = $state(false);
  $effect.pre(() => {
    diffOpen = lines.length > 0 && lines.length <= 120;
    textOpen = !copy.keeper && !hasKeeper && !!text && text.length <= 1500;
  });

  const changed = $derived(copy.action !== copy.proposed);
  const options = REVIEW_ACTIONS.map(action => ({ value: action, label: ACTION_LABEL[action] }));
  const uses = $derived(copy.uses30d === null ? "uses unknown" : `${copy.uses30d} ${copy.uses30d === 1 ? "use" : "uses"} in 30 d`);
  const lastUse = $derived(copy.lastUse ? `last used ${agoText(Date.parse(copy.lastUse), now)}` : "no use in the scan window");

  function copyPath(): void {
    void navigator.clipboard.writeText(copy.path).then(() => toast.show("Path copied"), () => toast.error("The clipboard refused the path"));
  }
</script>

<article class="copy" class:keeper={copy.keeper} data-testid="review-copy" data-copy={copy.id} data-state={copy.state} data-action={copy.action}>
  <header class="head">
    <Badge tone="outline" title="Box">{copy.box}</Badge>
    <code class="path" title={copy.path}>{copy.path}</code>
    <IconButton icon="copy" label="Copy path" size="xs" onclick={copyPath} />
    <span class="grow"></span>
    {#if copy.keeper}<Badge tone="accent" title="The copy the others are compared with and folded into">Keeper</Badge>{/if}
    {#if copy.state !== "pending"}<Badge tone={STATE_TONE[copy.state]} title={copy.note ?? undefined}>{STATE_LABEL[copy.state]}</Badge>{/if}
  </header>

  <p class="facts">
    {copy.family} · {copy.kind} · {sizeText(copy.sizeBytes)}{copy.lines === null ? "" : ` · ${copy.lines} lines`}{copy.files === null || copy.files <= 1 ? "" : ` · ${copy.files} files`} · {lastUse} · {uses}
  </p>

  <div class="action">
    <span class="verb" data-testid="copy-action">{actionText(copy.action, copy.foldInto)}</span>
    {#if changed}<span class="was">proposed {actionText(copy.proposed, null).toLowerCase()}</span>{/if}
    {#if copy.how !== "none"}<span class="how">by {copy.how}</span>{/if}
    {#if copy.reason}<p class="reason">{copy.reason}</p>{/if}
  </div>

  {#if copy.note}<p class="note" class:failed={copy.state === "failed"} role="status">{copy.note}</p>{/if}

  {#if editing}
    <div class="edit" data-testid="copy-edit">
      <Select size="sm" label={`Action for ${copy.box} ${copy.path}`} value={edit.action} {options} onchange={(action: ReviewAction) => onedit({ ...edit, action })} />
      {#if edit.action === "fold"}
        <Input size="sm" value={edit.foldInto} list={suggestions} placeholder="Skill to fold into" aria-label={`Fold target for ${copy.box} ${copy.path}`} oninput={(event: Event) => onedit({ ...edit, foldInto: (event.currentTarget as HTMLInputElement).value })} />
      {/if}
    </div>
  {/if}

  {#if copy.keeper}
    {#if text}
      <Disclosure title="Text that stays" detail={`${text.length} characters`} bind:open={textOpen}>
        <pre class="text">{text}</pre>
      </Disclosure>
    {/if}
  {:else}
    {#if lines.length > 0}
      <Disclosure title="Diff against the keeper" detail={`+${counts.added} −${counts.removed}`} bind:open={diffOpen}>
        <DiffView {lines} label={`Diff of ${copy.path} against the keeper`} />
      </Disclosure>
    {:else if hasKeeper && diff === ""}
      <p class="quiet">Same text as the keeper.</p>
    {:else if hasKeeper && diff === null && !text}
      <p class="quiet">The diff is not readable here.</p>
    {/if}
    {#if text && lines.length === 0 && diff !== ""}
      <Disclosure title={hasKeeper ? "Text" : "Text (no keeper to compare with)"} detail={`${text.length} characters`} bind:open={textOpen}>
        <pre class="text">{text}</pre>
      </Disclosure>
    {/if}
  {/if}
</article>

<style>
  .copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--surface-panel);
  }
  .keeper {
    border-color: var(--affordance-accent-prominent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .path {
    min-width: 0;
    overflow-wrap: anywhere;
    font: var(--text-mono);
    letter-spacing: var(--tracking-mono);
  }
  .grow {
    flex: 1;
  }
  .facts {
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-body-sm);
    font-variant-numeric: tabular-nums;
  }
  .action {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }
  .verb {
    font: var(--text-label-sm);
  }
  .was,
  .how {
    color: var(--text-metadata);
    font: var(--text-caption);
  }
  .reason {
    flex-basis: 100%;
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-body);
  }
  .note {
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .note.failed {
    color: var(--text-danger);
  }
  .edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .edit :global(.input) {
    flex: 1 1 14rem;
    max-width: 24rem;
  }
  .quiet {
    margin: 0;
    color: var(--text-metadata);
    font: var(--text-body-sm);
  }
  .text {
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    padding: 8px 12px;
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    font: var(--text-mono);
    letter-spacing: var(--tracking-mono);
    white-space: pre-wrap;
  }
</style>
