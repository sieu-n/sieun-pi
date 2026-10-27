<script lang="ts">
  import { hueFor, initials } from "./hash";
  import { mascotParts, mascotSvg } from "./mascot";
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
  const tint = $derived(mascotParts(key).body);
  const radius = $derived(kind === "person" ? "50%" : `${Math.round(size * 0.32)}px`);
  const dot = $derived(Math.max(6, Math.round(size * 0.28)));
  const uid = Math.random().toString(36).slice(2, 8);
</script>

<span
  class="avatar {kind}"
  class:ring
  style:width="{size}px"
  style:height="{size}px"
  style:--r={radius}
  style:--h={hue}
  style:--tint={tint}
  title={title ?? name}
  data-kind={kind}
>
  {#if src}
    <img {src} alt={name} draggable="false" />
  {:else if kind === "person"}
    <span class="initials" style:font-size="{Math.max(9, Math.round(size * 0.4))}px">{initials(name)}</span>
  {:else}
    <span class="figure">{@html mascotSvg(key, `av-${uid}`)}</span>
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
  .agent,
  :global(:root[data-color-mode="dark"]) .agent {
    background: color-mix(in srgb, var(--tint) 28%, var(--surface-panel));
  }
  .figure {
    width: 100%;
    height: 100%;
    border-radius: var(--r);
    overflow: hidden;
    line-height: 0;
  }
  .figure :global(svg) {
    width: 100%;
    height: 100%;
    transform: translateY(6%) scale(1.12);
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
