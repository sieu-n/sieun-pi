import { Outbox, type OutboxDeps, type Stored } from "./outbox.ts";
import { ThreadError, type ThreadHub } from "./chat-threads.ts";
import type { Chats } from "./chats.ts";
import type { Catalog } from "./chat-catalog.ts";
import type { ChatImage } from "./chat-images.ts";
import type { OutboxAccepted } from "./shared/outbox.ts";
import type { SendMode } from "./shared/types.ts";

/** A send that cannot go: the owner archived the chat after he sent it. */
class ArchivedFirst extends Error {}

/**
 * The owner's sends from the composer (POST api/threads/:id/prompt), on disk under `dir` until the daemon takes them. Each delivery marks an
 * owner turn, reopens a chat he archived before he wrote, and fails for good if he archived it after he wrote, as the route did before.
 */
export class OwnerOutbox {
  readonly outbox: Outbox;
  /** The chat's archive count when each send came in; a send loaded after a service start counts from that start. */
  private readonly archives = new Map<string, number>();
  private readonly chats: Chats;

  /** `sleep` is the wait between tries; tests make it short. */
  constructor(dir: string, parts: { threads: ThreadHub; chats: Chats; catalog: Catalog }, log: (line: string) => void,
    options: Pick<OutboxDeps, "sleep"> = {}) {
    const { threads, chats, catalog } = parts;
    this.chats = chats;
    this.outbox = new Outbox({ dir, log, ...options, sendBeforeWrite: true,
      deliver: async (entry: Stored, sending) => {
        const id = entry.threadId;
        const since = this.archives.get(entry.id) ?? chats.archives(id);
        this.archives.set(entry.id, since);
        // A plain thread's archive goes through the hub alone, so its start time decides; a chat's also counts in `archives`. It is checked
        // before the reopen too, because a retry after an archive must not reopen the chat.
        const archived = () => chats.archives(id) !== since || threads.archivedSince(id, entry.at);
        if (archived()) throw new ArchivedFirst("The chat was archived before this message went.");
        if (await chats.reopen(id, since)) {
          void catalog.notify().catch(error => log(`chat ${id.slice(0, 8)}: reopen: sidebar update: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (archived()) throw new ArchivedFirst("The chat was archived before this message went.");
        // The owner's own message never waits in a box's turn queue: it goes as an owner turn.
        await threads.prompt(id, { message: entry.text, images: entry.images, mode: entry.mode, owner: true, sending });
      },
      copy: (entry, since) => threads.copyOf(entry.threadId, entry.text, entry.imageCount, since),
      final: error => error instanceof ArchivedFirst || (error instanceof ThreadError && error.status === 400) ? error.message : null,
      changed: (id, outbox, left) => threads.setOutbox(id, outbox, left),
    });
  }

  async submit(input: { id: string; threadId: string; text: string; images: ChatImage[]; mode: SendMode; fingerprint: string }): Promise<OutboxAccepted> {
    if (!this.archives.has(input.id)) this.archives.set(input.id, this.chats.archives(input.threadId));
    return this.outbox.submit(input);
  }

  close(): Promise<void> { return this.outbox.close(); }
}
