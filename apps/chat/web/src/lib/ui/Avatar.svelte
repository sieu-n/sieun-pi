<script lang="ts">
  import { hashString, hueFor, initials } from "./hash";
  import type { Status } from "./types";

  type Props = {
    name: string;
    /** person is a circle (the owner, people); agent is a squircle (chats and jobs). */
    kind?: "person" | "agent";
    /** Image URL. Without it, people show initials and agents show generated art from `seed`. */
    src?: string | null;
    /** Seed for generated art and color, defaults to name. Use the agent id for stable art. */
    seed?: string;
    size?: number;
    status?: Status | null;
    /** Show a ring, used inside an AvatarStack. */
    ring?: boolean;
    title?: string;
  };
  let { name, kind = "agent", src = null, seed, size = 28, status = null, ring = false, title }: Props = $props();

  const key = $derived(seed ?? name);
  const hue = $derived(hueFor(key));
  const h = $derived(hashString(key));
  const radius = $derived(kind === "person" ? "50%" : `${Math.round(size * 0.32)}px`);
  const dot = $derived(Math.max(6, Math.round(size * 0.28)));
  const eyeGap = $derived(4 + (h % 3));
  const eyeY = $derived(9 + ((h >> 3) % 3));
  const mouth = $derived((h >> 6) % 3);
</script>

<span
  class="avatar {kind}"
  class:ring
  style:width="{size}px"
  style:height="{size}px"
  style:--r={radius}
  style:--h={hue}
  title={title ?? name}
  data-kind={kind}
>
  {#if src}
    <img {src} alt={name} draggable="false" />
  {:else if kind === "person"}
    <span class="initials" style:font-size="{Math.max(9, Math.round(size * 0.4))}px">{initials(name)}</span>
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx={12 - eyeGap / 2} cy={eyeY} r="1.4" />
      <circle cx={12 + eyeGap / 2} cy={eyeY} r="1.4" />
      {#if mouth === 0}
        <path d="M9.5 15.5q2.5 2 5 0" />
      {:else if mouth === 1}
        <path d="M10 15.5h4" />
      {:else}
        <circle cx="12" cy="15.5" r="1" />
      {/if}
    </svg>
    <span class="sr-only">{name}</span>
  {/if}
  {#if status}
    <span class="status {status}" style:width="{dot}px" style:height="{dot}px" aria-label={status}></span>
  {/if}
</span>

<style>
  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: var(--r);
    background: hsl(var(--h) 45% 86%);
    color: hsl(var(--h) 40% 22%);
    user-select: none;
  }
  :global(:root[data-color-mode="dark"]) .avatar {
    background: hsl(var(--h) 30% 30%);
    color: hsl(var(--h) 60% 88%);
  }
  .agent {
    background:
      radial-gradient(circle at 30% 25%, hsl(calc(var(--h) + 40) 80% 88%) 0%, transparent 60%),
      linear-gradient(150deg, hsl(var(--h) 70% 78%), hsl(calc(var(--h) + 30) 60% 64%));
  }
  .ring {
    box-shadow: 0 0 0 2px var(--surface-panel);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--r);
  }
  .initials {
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1;
  }
  svg {
    width: 72%;
    height: 72%;
    fill: hsl(var(--h) 45% 16%);
    stroke: hsl(var(--h) 45% 16%);
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  svg path {
    fill: none;
  }
  .status {
    position: absolute;
    right: -1px;
    bottom: -1px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--surface-panel);
  }
  .agent .status {
    right: -2px;
    bottom: -2px;
  }
  .status.online {
    background: var(--status-online);
  }
  .status.away {
    background: var(--status-away);
  }
  .status.offline {
    background: var(--status-offline);
  }
  .status.busy {
    background: var(--border-danger);
  }
</style>
