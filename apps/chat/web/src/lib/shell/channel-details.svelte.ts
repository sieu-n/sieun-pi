import { router } from "$lib/router.svelte";

export type DetailsTab = "about" | "settings";

/**
 * The channel details dialog's target. The channel name in the header, the header menu and a sidebar row's menu open it. The dialog
 * draws over its own channel, as Slack's does, so opening it for another channel opens that channel first.
 */
class ChannelDetails {
  target = $state<{ id: string; tab: DetailsTab; editDescription: boolean } | null>(null);

  open(id: string, opts: { tab?: DetailsTab; editDescription?: boolean } = {}): void {
    if (router.conversationId !== id) router.openConversation(id);
    this.target = { id, tab: opts.tab ?? "about", editDescription: opts.editDescription ?? false };
  }

  close(): void {
    this.target = null;
  }
}

export const channelDetails = new ChannelDetails();
