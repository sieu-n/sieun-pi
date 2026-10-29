<script lang="ts">
  import Avatar from "$lib/ui/Avatar.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { dayLabel, timeLabel } from "$lib/ui/datetime";
  import type { StackMember } from "$lib/ui/types";

  type Props = {
    /** Reply authors, or the job itself. */
    members: StackMember[];
    label: string;
    replies: number;
    /** When the last reply came, for Slack's "Last reply" line. */
    lastAt?: number | null;
    working?: boolean;
    failed?: boolean;
    open?: boolean;
    own?: boolean;
    /** bubble hangs the pill off its bubble with a curved line; slack is the left-aligned thread summary under a channel post. */
    layout?: "bubble" | "slack";
    onclick: () => void;
  };
  let { members, label, replies, lastAt = null, working = false, failed = false, open = false, own = false, layout = "bubble", onclick }: Props = $props();
  const count = $derived(replies === 0 ? "View thread" : `${replies} ${replies === 1 ? "reply" : "replies"}`);
  const lastDay = $derived(lastAt ? dayLabel(lastAt) : "");
  const lastReply = $derived(lastAt ? `Last reply ${lastDay === "Today" || lastDay === "Yesterday" ? lastDay.toLowerCase() : lastDay} at ${timeLabel(lastAt)}` : null);
</script>

{#if layout === "slack"}
  <button type="button" class="summary" class:open data-thread-pill aria-label="{label ? `${label}, ` : ""}{count}" {onclick}>
    <span class="faces">
      {#each members.slice(0, 3) as m (m.id)}
        <Avatar name={m.name} kind={m.kind ?? "agent"} src={m.src ?? null} seed={m.id} size={24} />
      {/each}
    </span>
    {#if label}<span class="label">{label}</span>{/if}
    <span class="count">{count}</span>
    {#if working}<span class="working"><TypingDots mode="working" label="Working" /></span>{/if}
    {#if failed}<span class="failed"><Icon name="warning" size={13} label="Failed" /></span>{/if}
    {#if replies > 0}
      <span class="hint">
        {#if lastReply}<span class="last">{lastReply}</span>{/if}
        <span class="view">View thread</span>
      </span>
    {/if}
    <span class="chevron"><Icon name="chevron-right" size={14} /></span>
  </button>
{:else}
  <button type="button" class="pill" class:own class:open data-thread-pill aria-label="{label}, {count}" {onclick}>
    <AvatarStack {members} size={18} max={3} />
    {#if label}<span class="label">{label}</span>{/if}
    <span class="count">{count}</span>
    {#if working}<span class="working"><TypingDots mode="working" label="Working" /></span>{/if}
    {#if failed}<span class="failed"><Icon name="warning" size={13} label="Failed" /></span>{/if}
  </button>
{/if}

<style>
  .pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 56px);
    margin-top: 4px;
    align-self: flex-start;
    padding: 4px 10px 4px 4px;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-subtle);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-standard);
  }
  .pill::before {
    content: "";
    position: absolute;
    left: -12px;
    bottom: 50%;
    width: 12px;
    height: 18px;
    border-left: 2px solid var(--border-message-thread);
    border-bottom: 2px solid var(--border-message-thread);
    border-bottom-left-radius: 12px;
    pointer-events: none;
  }
  .pill.own {
    align-self: flex-end;
  }
  .pill.own::before {
    left: auto;
    right: -12px;
    border-left: 0;
    border-right: 2px solid var(--border-message-thread);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 12px;
  }
  .pill:hover,
  .pill.open {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-standard);
    font-weight: 500;
  }
  .count {
    flex: none;
  }
  .working,
  .failed {
    display: inline-flex;
    flex: none;
  }
  .failed {
    color: var(--border-danger);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(100%, 36rem);
    margin-top: 4px;
    padding: 4px 8px 4px 4px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    text-align: left;
    cursor: pointer;
  }
  .summary:hover,
  .summary.open,
  .summary:focus-visible {
    border-color: var(--border-standard);
    background: var(--surface-panel);
  }
  .faces {
    display: inline-flex;
    flex: none;
    gap: 4px;
  }
  .summary .label {
    flex: 0 1 auto;
  }
  .summary .count {
    color: var(--text-message-link);
    font-weight: 700;
  }
  .summary:hover .count {
    text-decoration: underline;
  }
  .hint {
    display: grid;
    min-width: 0;
  }
  .last,
  .view {
    grid-area: 1 / 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .view,
  .summary:hover .last,
  .summary.open .last {
    visibility: hidden;
  }
  .summary:hover .view,
  .summary.open .view {
    visibility: visible;
  }
  .chevron {
    display: inline-flex;
    margin-left: auto;
    color: var(--text-subtle);
    visibility: hidden;
  }
  .summary:hover .chevron,
  .summary.open .chevron {
    visibility: visible;
  }
</style>
