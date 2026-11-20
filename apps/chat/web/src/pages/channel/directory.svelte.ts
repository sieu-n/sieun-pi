import { agents, kept, live, reads, type Room } from "$lib/api";

/** Channels and Solo rooms, fetched once and kept current from the live socket's room events. */
class RoomDirectory {
  private get kept() {
    return kept(reads.rooms());
  }

  private started = false;

  get list(): Room[] {
    return this.kept.value ?? [];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.kept.open();
    live.on((event) => {
      if (event.type !== "room") return;
      const index = this.list.findIndex((r) => r.id === event.room.id);
      this.kept.set(index >= 0 ? this.list.map((r, i) => (i === index ? event.room : r)) : [...this.list, event.room]);
    });
  }
}

const roomDirectory = new RoomDirectory();

export const directory = {
  get agents() {
    return agents.list;
  },
  /** Channels only, for the # typeahead and mention chips. */
  get channels() {
    roomDirectory.start();
    return roomDirectory.list.filter((r) => r.kind === "channel");
  },
  room(id: string): Room | undefined {
    roomDirectory.start();
    return roomDirectory.list.find((r) => r.id === id);
  },
};
