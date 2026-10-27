<script lang="ts">
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import type { StackMember } from "$lib/ui/types";

  type Props = {
    /** Reply authors, or the job itself. */
    members: StackMember[];
    label: string;
    replies: number;
    working?: boolean;
    failed?: boolean;
    open?: boolean;
    own?: boolean;
    onclick: () => void;
  };
  let { members, label, replies, working = false, failed = false, open = false, own = false, onclick }: Props = $props();
  const count = $derived(replies === 0 ? "View thread" : `${replies} ${replies === 1 ? "reply" : "replies"}`);
</script>

<button type="button" class="pill" class:own class:open data-thread-pill aria-label="{label}, {count}" {onclick}>
  <AvatarStack {members} size={18} max={3} />
  {#if label}<span class="label">{label}</span>{/if}
  <span class="count">{count}</span>
  {#if working}<span class="working"><TypingDots mode="working" label="Working" /></span>{/if}
  {#if failed}<span class="failed"><Icon name="warning" size={13} label="Failed" /></span>{/if}
</button>

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
</style>
