/**
 * Follows a conversation's place in pi-pool's turn queue after an input, through pi-host's `durable_ticket`, so the page shows "queued,
 * 12 of 160" on a waiting send and the channel shows it on a delivery. pi-host answers the first place with `durable_submit`; this reads it
 * again every few seconds until the run works or ends.
 */
import type { ConversationId, TurnPlace } from "../web/src/lib/api/types.ts";
import type { Host } from "./host/types.ts";
import { parseConversationId, type Threads } from "./threads.ts";

const READ_EVERY_MS = 3000;
/** A wait longer than this stops being followed; the page keeps the last place it got. */
const FOLLOW_MS = 60 * 60_000;
/** Reads of `none` in a row, while the conversation is not working, that mean the run ended. */
const NONE_READS = 3;

/** The place a page shows: a queued or marked run waits; working and none show nothing. */
export function waitingPlace(place: TurnPlace | null | undefined): TurnPlace | undefined {
  return place && (place.state === "queued" || place.state === "marked") ? place : undefined;
}

type Listener = (place: TurnPlace | null) => void;
interface Followed { place: TurnPlace | null; listeners: Set<Listener>; timer?: NodeJS.Timeout; until: number; nones: number }

export class QueueWatch {
  private readonly followed = new Map<ConversationId, Followed>();

  constructor(readonly host: Host, readonly threads: Threads, readonly emit: (conversation: ConversationId, place: TurnPlace | null) => void, private readonly log: (line: string) => void = () => {}) {}

  /** The waiting place now, or null. */
  place(id: ConversationId): TurnPlace | null {
    return this.followed.get(id)?.place ?? null;
  }

  /** Starts or extends following `id` from the place pi-host just answered; `listener` hears each change until the run works or ends. */
  follow(id: ConversationId, first: TurnPlace | null, listener?: Listener): void {
    let entry = this.followed.get(id);
    if (!entry) {
      entry = { place: null, listeners: new Set(), until: 0, nones: 0 };
      this.followed.set(id, entry);
    }
    entry.until = Date.now() + FOLLOW_MS;
    if (listener) entry.listeners.add(listener);
    this.set(id, entry, waitingPlace(first) ?? null);
    if (first?.state === "working") return this.end(id, entry);
    entry.timer ??= setTimeout(() => void this.read(id), READ_EVERY_MS);
  }

  private set(id: ConversationId, entry: Followed, place: TurnPlace | null): void {
    if (JSON.stringify(place) === JSON.stringify(entry.place)) return;
    entry.place = place;
    this.emit(id, place);
    for (const listener of entry.listeners) listener(place);
  }

  private end(id: ConversationId, entry: Followed): void {
    clearTimeout(entry.timer);
    this.set(id, entry, null);
    this.followed.delete(id);
  }

  private async read(id: ConversationId): Promise<void> {
    const entry = this.followed.get(id);
    if (!entry) return;
    entry.timer = undefined;
    const { thread, conversation } = parseConversationId(id);
    try {
      const ticket = await this.host.ticket(thread, conversation === 1 ? undefined : conversation);
      const place = ticket?.place ?? { state: "none" as const };
      entry.nones = place.state === "none" && this.threads.statusOfConversation(thread, conversation) !== "working" ? entry.nones + 1 : 0;
      if (place.state === "working" || entry.nones >= NONE_READS || Date.now() > entry.until) return this.end(id, entry);
      this.set(id, entry, waitingPlace(place) ?? null);
    } catch (error) {
      this.log(`ticket of ${id} failed: ${String(error)}`);
    }
    if (this.followed.get(id) === entry) entry.timer = setTimeout(() => void this.read(id), READ_EVERY_MS);
  }

  stop(): void {
    for (const entry of this.followed.values()) clearTimeout(entry.timer);
    this.followed.clear();
  }
}
