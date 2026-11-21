import type { Anchor } from "$lib/ui/floating";

/**
 * The agent profile card's target, as Slack opens a person's card from their name or avatar. A post's author, a DM's header name and the
 * DM intro open it; App mounts the card once (pages/agents/AgentProfileCard.svelte).
 */
class ProfileCard {
  target = $state<{ agent: string; name: string; anchor: Anchor } | null>(null);

  /** A second press on the element that opened the card closes it. */
  toggle(agent: string, name: string, anchor: Anchor): void {
    this.target = this.target?.anchor === anchor ? null : { agent, name, anchor };
  }

  close(): void {
    this.target = null;
  }
}

export const profileCard = new ProfileCard();
