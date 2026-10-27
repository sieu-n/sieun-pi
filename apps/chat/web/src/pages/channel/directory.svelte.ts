import { agents, api, live, type Channel } from "$lib/api";

/** Channels for the # typeahead and mention chips, fetched once and kept current from the live socket's channel events. */
class ChannelDirectory {
  list = $state<Channel[]>([]);
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void api.channels().then((channels) => (this.list = channels)).catch(() => undefined);
    live.on((event) => {
      if (event.type !== "channel") return;
      const index = this.list.findIndex((c) => c.id === event.channel.id);
      this.list = index >= 0 ? this.list.map((c, i) => (i === index ? event.channel : c)) : [...this.list, event.channel];
    });
  }
}

const channelDirectory = new ChannelDirectory();

export const directory = {
  get agents() {
    return agents.list;
  },
  get channels() {
    channelDirectory.start();
    return channelDirectory.list;
  },
};
