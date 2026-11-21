import { kept, reads } from "$lib/api";
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

  /**
   * Reads the agent's config while the pointer is on its name or avatar, so the card opens with its job counts. On 11-21 agent factory's
   * config was 370 KB and took 0.3 to 2.8 s to read from :5184, and the card showed "…" for that long when the read started on the click.
   */
  warm(agent: string): void {
    void kept(reads.agentConfig(agent)).ahead();
  }
}

export const profileCard = new ProfileCard();
