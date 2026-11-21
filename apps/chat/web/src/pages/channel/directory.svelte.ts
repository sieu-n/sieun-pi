import { agents, kept, listedRoom, live, reads, type ListedRoom } from "$lib/api";

/** Channels and Solo rooms, fetched once and kept current from the live socket's room events. */
class RoomDirectory {
  private get kept() {
    return kept(reads.rooms());
  }

  private started = false;

  get list(): ListedRoom[] {
    return this.kept.value ?? [];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.kept.open();
    live.on((event) => {
      if (event.type !== "room") return;
      const room = listedRoom(event.room);
      const index = this.list.findIndex((r) => r.id === room.id);
      if (index >= 0 && JSON.stringify(this.list[index]) === JSON.stringify(room)) return;
      this.kept.set(index >= 0 ? this.list.map((r, i) => (i === index ? room : r)) : [...this.list, room]);
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
  room(id: string): ListedRoom | undefined {
    roomDirectory.start();
    return roomDirectory.list.find((r) => r.id === id);
  },
};
