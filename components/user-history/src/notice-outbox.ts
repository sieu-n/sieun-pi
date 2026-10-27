import { randomUUID } from "node:crypto";
import { ThreadError, type ThreadHub } from "./chat-threads.ts";
import { Outbox, type OutboxDeps } from "./outbox.ts";

/**
 * The server's notices to a chat (`Chats.tell`: [job], [check-in] and duty pushes), on disk under `dir` until the daemon takes them, so a failed
 * steer goes again instead of being lost. Before, each went straight to the daemon once: from 10-19 07:00Z to 10-22 08:00Z 12 such notices failed
 * and were only logged (the messaging audit, sieun-pi chats.ts `tell`). A send that may have reached the daemon is looked for in the chat's
 * file and queue before it goes again (`ThreadHub.copyOf`). A chat the daemon refuses as bad (400) or does not have (404) fails the notice. A
 * notice to a chat on a box that reads offline waits with no try (`held`): from 10-26 01:30Z to 10-27 01:30Z 4 of the 5 notices lost so were
 * to Mac chats while the Mac was offline.
 */
export interface NoticeOutbox {
  /** Keeps the notice on disk and sends it in the background; resolves once it is on disk. */
  send(chat: string, message: string): Promise<void>;
  readonly outbox: Outbox;
  close(): Promise<void>;
}

export function noticeOutbox(dir: string, threads: Pick<ThreadHub, "prompt" | "copyOf">, log: (line: string) => void,
  options: Pick<OutboxDeps, "sleep" | "now" | "held"> = {}): NoticeOutbox {
  const outbox = new Outbox({ dir, log, ...options,
    deliver: async (entry, sending) => {
      await threads.prompt(entry.threadId, { message: entry.text, images: [], mode: "steer", sending: () => sending(), ...entry.write ? { write: entry.write } : {} });
    },
    copy: (entry, since) => threads.copyOf(entry.threadId, entry.text, 0, since),
    final: error => error instanceof ThreadError && (error.status === 400 || error.status === 404) ? error.message : null,
    where: chat => `${chat.slice(0, 8)} notice`,
    changed: () => {},
  });
  return {
    outbox,
    async send(chat, message) {
      const id = `n-${randomUUID()}`;
      await outbox.submit({ id, threadId: chat, text: message, images: [], mode: "steer", fingerprint: id });
    },
    close: () => outbox.close(true),
  };
}
